import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  LOBBY_CODE_LENGTH, MAX_NAME_LENGTH, MAX_PITCH, PROTOCOL_VERSION, WEAPON_COUNT, WS_PATH,
  type CmdTuple, type ErrorCode, type S2C,
} from '@aimstrike/shared';
import type { ServerConfig } from './config';
import { DEFAULT_SETTINGS, Room, RoomError, sanitizeSettings, type Member } from './Room';

/** Unambiguous alphabet: no 0/O or 1/I. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MSG_RATE = 150; // sustained messages per second per connection
const MSG_BURST = 300;
const MAX_CMDS_PER_MSG = 12;
const MAX_STRIKES = 5;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

interface Conn {
  ws: WebSocket;
  id: string;
  name: string;
  token: string;
  room: Room | null;
  alive: boolean;
  tokens: number;
  lastRefill: number;
  strikes: number;
}

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Player';
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name || 'Player';
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** HTTP + WebSocket front door: connections, validation, rate limiting, lobby registry and the tick loop. */
export class GameServer {
  readonly rooms = new Map<string, Room>();
  /** Reconnect tokens for players currently holding a room slot. */
  private readonly sessions = new Map<string, { room: Room; memberId: string }>();
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private tickTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly clientDist: string;

  constructor(readonly cfg: ServerConfig) {
    this.clientDist = cfg.clientDist ? resolve(cfg.clientDist) : '';
    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.http,
      path: WS_PATH,
      maxPayload: 8 * 1024,
      verifyClient: ({ origin }: { origin?: string }) =>
        cfg.allowedOrigins.length === 0 || (!!origin && cfg.allowedOrigins.includes(origin)),
    });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
  }

  listen(): Promise<number> {
    return new Promise((ok, fail) => {
      this.http.once('error', fail);
      this.http.listen(this.cfg.port, this.cfg.host, () => {
        const addr = this.http.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.cfg.port;
        this.tickTimer = setInterval(() => this.update(), 1000 / 120);
        this.heartbeatTimer = setInterval(() => this.heartbeat(), 15000);
        ok(port);
      });
    });
  }

  close(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
    for (const c of this.conns) c.ws.terminate();
    return new Promise((ok) => this.wss.close(() => this.http.close(() => ok())));
  }

  private log(...args: unknown[]): void {
    if (this.cfg.log) console.log(new Date().toISOString(), ...args);
  }

  private update(): void {
    const now = performance.now();
    for (const room of this.rooms.values()) {
      try {
        room.update(now);
      } catch (err) {
        // One broken match must never take the whole server down.
        console.error(`[room ${room.code}] tick failed`, err);
      }
    }
  }

  private heartbeat(): void {
    for (const c of this.conns) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }

  // ---------------------------------------------------------------- HTTP

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = (req.url || '/').split('?')[0];
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true, rooms: this.rooms.size, players: this.conns.size, protocol: PROTOCOL_VERSION }));
      return;
    }
    if (!this.clientDist || !existsSync(this.clientDist)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('AIMSTRIKE game server is running. Connect a client over WebSocket at ' + WS_PATH);
      return;
    }
    let file = normalize(join(this.clientDist, decodeURIComponent(url)));
    if (!file.startsWith(this.clientDist)) { res.writeHead(403); res.end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(this.clientDist, 'index.html');
    const ext = extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    createReadStream(file).pipe(res);
  }

  // ---------------------------------------------------------------- WebSocket

  private handleConnection(ws: WebSocket): void {
    const conn: Conn = {
      ws, id: '', name: 'Player', token: '', room: null, alive: true,
      tokens: MSG_BURST, lastRefill: performance.now(), strikes: 0,
    };
    this.conns.add(conn);
    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.strike(conn, 'Binary frames are not supported.');
      // Token bucket: floods are dropped, persistent floods are disconnected.
      const now = performance.now();
      conn.tokens = Math.min(MSG_BURST, conn.tokens + ((now - conn.lastRefill) / 1000) * MSG_RATE);
      conn.lastRefill = now;
      if (conn.tokens < 1) {
        if (++conn.strikes > MAX_STRIKES * 20) ws.close(1008, 'rate limited');
        return;
      }
      conn.tokens--;
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return this.strike(conn, 'Malformed message.');
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') {
        return this.strike(conn, 'Malformed message.');
      }
      try {
        this.handleMessage(conn, msg as Record<string, unknown> & { t: string });
      } catch (err) {
        if (err instanceof RoomError) this.error(conn, err.code, err.message);
        else {
          console.error('[server] message handler failed', err);
          this.error(conn, 'bad_request', 'The server could not process that request.');
        }
      }
    });
    ws.on('close', () => {
      this.conns.delete(conn);
      if (conn.room) {
        this.log(`[${conn.room.code}] ${conn.name} disconnected`);
        conn.room.disconnect(conn.id);
        conn.room = null;
      }
    });
    ws.on('error', () => ws.terminate());
  }

  private sendTo(conn: Conn, msg: S2C): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private error(conn: Conn, code: ErrorCode, message: string): void {
    this.sendTo(conn, { t: 'error', code, message });
  }

  private strike(conn: Conn, message: string): void {
    this.error(conn, 'bad_request', message);
    if (++conn.strikes > MAX_STRIKES) conn.ws.close(1008, 'too many invalid messages');
  }

  private sink(conn: Conn): (data: string) => void {
    return (data) => {
      // Drop state updates for hopelessly backed-up sockets rather than buffering without bound.
      if (conn.ws.readyState === conn.ws.OPEN && conn.ws.bufferedAmount < 512 * 1024) conn.ws.send(data);
    };
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < LOBBY_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  private createRoom(conn: Conn, settings: unknown): Room {
    if (this.rooms.size >= this.cfg.maxRooms) throw new RoomError('server_full', 'The server is at capacity. Please try again shortly.');
    const room = new Room(
      this.newCode(),
      sanitizeSettings(settings as never, DEFAULT_SETTINGS),
      this.cfg,
      (r) => { this.rooms.delete(r.code); this.log(`[${r.code}] closed`); },
      (m: Member) => this.sessions.delete(m.token),
    );
    this.rooms.set(room.code, room);
    this.log(`[${room.code}] created by ${conn.name}`);
    return room;
  }

  private enter(conn: Conn, room: Room): void {
    this.leaveRoom(conn);
    const member = room.join(conn.id, conn.name, conn.token, this.sink(conn));
    conn.room = room;
    this.sessions.set(conn.token, { room, memberId: member.id });
    this.log(`[${room.code}] ${member.name} joined (${room.members.size}/${room.capacity})`);
  }

  private leaveRoom(conn: Conn): void {
    if (!conn.room) return;
    const room = conn.room;
    conn.room = null;
    room.leave(conn.id);
  }

  private handleMessage(conn: Conn, msg: Record<string, unknown> & { t: string }): void {
    if (msg.t === 'hello') {
      if (conn.id) return;
      if (msg.v !== PROTOCOL_VERSION) {
        return this.error(conn, 'version', 'Your game client is out of date. Refresh the page to update.');
      }
      conn.name = sanitizeName(msg.name);
      const session = typeof msg.token === 'string' ? this.sessions.get(msg.token) : undefined;
      if (session && this.rooms.get(session.room.code) === session.room && !session.room.members.get(session.memberId)?.connected) {
        // Returning player: give them their slot back.
        conn.id = session.memberId;
        conn.token = msg.token as string;
        conn.room = session.room;
        const member = session.room.members.get(session.memberId)!;
        conn.name = member.name;
        this.sendTo(conn, { t: 'welcome', id: conn.id, token: conn.token, name: conn.name, resumed: true });
        session.room.resume(conn.id, this.sink(conn));
        this.log(`[${session.room.code}] ${conn.name} reconnected`);
        return;
      }
      conn.id = randomBytes(6).toString('hex');
      conn.token = randomBytes(18).toString('hex');
      this.sendTo(conn, { t: 'welcome', id: conn.id, token: conn.token, name: conn.name, resumed: false });
      return;
    }
    if (!conn.id) return this.strike(conn, 'Say hello first.');

    switch (msg.t) {
      case 'i': {
        // Hot path. Reject anything that is not a well-formed batch of finite numbers.
        const room = conn.room;
        if (!room) return;
        const list = msg.c;
        if (!fin(msg.rt) || !Array.isArray(list) || list.length === 0 || list.length > MAX_CMDS_PER_MSG) {
          return this.strike(conn, 'Invalid input batch.');
        }
        for (const c of list) {
          if (
            !Array.isArray(c) || c.length !== 5 || !Number.isInteger(c[0]) || c[0] <= 0 ||
            !Number.isInteger(c[1]) || c[1] < 0 || c[1] > 255 || !fin(c[2]) || Math.abs(c[2]) > 1e4 ||
            !fin(c[3]) || Math.abs(c[3]) > MAX_PITCH + 1e-6 || !Number.isInteger(c[4]) || c[4] < 0 || c[4] >= WEAPON_COUNT
          ) {
            return this.strike(conn, 'Invalid input command.');
          }
        }
        room.input(conn.id, msg.rt, list as CmdTuple[]);
        return;
      }
      case 'ping': {
        if (!fin(msg.c)) return;
        this.sendTo(conn, { t: 'pong', c: msg.c });
        if (fin(msg.rtt) && conn.room) conn.room.setPing(conn.id, Math.max(0, Math.min(999, Math.round(msg.rtt))));
        return;
      }
      case 'create': {
        if (typeof msg.name === 'string') conn.name = sanitizeName(msg.name);
        this.enter(conn, this.createRoom(conn, msg.settings));
        return;
      }
      case 'join': {
        if (typeof msg.name === 'string') conn.name = sanitizeName(msg.name);
        const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
        if (!/^[A-Z0-9]{6}$/.test(code)) {
          return this.error(conn, 'not_found', 'Lobby codes are six letters or numbers, like K7M2QX.');
        }
        const room = this.rooms.get(code);
        if (!room) return this.error(conn, 'not_found', `No lobby found with code ${code}. Check the code or ask the host for a new one.`);
        if (conn.room === room) return;
        this.enter(conn, room);
        return;
      }
      case 'quick': {
        if (typeof msg.name === 'string') conn.name = sanitizeName(msg.name);
        let target: Room | null = null;
        for (const room of this.rooms.values()) {
          if (room.settings.isPublic && !room.isFull && room !== conn.room && room.phase !== 'ended') {
            if (!target || room.members.size > target.members.size) target = room;
          }
        }
        this.enter(conn, target ?? this.createRoom(conn, { isPublic: true }));
        return;
      }
      case 'leave':
        this.leaveRoom(conn);
        this.sendTo(conn, { t: 'left' });
        return;
      case 'team':
        if (msg.team === 'red' || msg.team === 'blue') conn.room?.setTeam(conn.id, msg.team);
        return;
      case 'weapon':
        if (fin(msg.weapon)) conn.room?.setWeapon(conn.id, msg.weapon);
        return;
      case 'ready':
        conn.room?.setReady(conn.id, msg.ready === true);
        return;
      case 'settings':
        if (msg.settings && typeof msg.settings === 'object') conn.room?.updateSettings(conn.id, msg.settings);
        return;
      case 'start':
        conn.room?.start(conn.id, performance.now());
        return;
      default:
        return this.strike(conn, 'Unknown message type.');
    }
  }
}
