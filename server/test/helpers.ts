import WebSocket from 'ws';
import {
  BTN, DT, EYE_HEIGHT, HITBOXES, PROTOCOL_VERSION, WS_PATH, aimAt,
  type C2S, type CmdTuple, type HitPart, type LobbyState, type S2C, type SnapshotMsg,
} from '@aimstrike/shared';
import { loadConfig, type ServerConfig } from '../src/config';
import { GameServer } from '../src/GameServer';

export async function startServer(overrides: Partial<ServerConfig> = {}): Promise<{ server: GameServer; port: number }> {
  const cfg: ServerConfig = {
    ...loadConfig({}),
    port: 0, host: '127.0.0.1', log: false,
    countdownMs: 150, resultsMs: 300, reconnectGraceMs: 600, spawnProtectionMs: 0, respawnMs: 300,
    ...overrides,
  };
  const server = new GameServer(cfg);
  const port = await server.listen();
  return { server, port };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Of<T extends S2C['t']> = Extract<S2C, { t: T }>;

/** A real WebSocket client speaking the game protocol - the same thing a browser does. */
export class TestClient {
  ws!: WebSocket;
  id = '';
  token = '';
  name = '';
  resumed = false;
  lobby: LobbyState | null = null;
  snap: SnapshotMsg | null = null;
  snapCount = 0;
  log: S2C[] = [];
  seq = 0;
  closed = false;
  private waiters: Array<{ pred: (m: S2C) => boolean; ok: (m: S2C) => void }> = [];

  constructor(readonly port: number) {}

  async connect(name: string, token?: string): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}${WS_PATH}`);
    this.closed = false;
    this.ws.on('close', () => { this.closed = true; });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as S2C;
      if (msg.t === 's') { this.snap = msg; this.snapCount++; }
      else {
        if (msg.t === 'lobby') this.lobby = msg.lobby;
        this.log.push(msg);
      }
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].pred(msg)) this.waiters.splice(i, 1)[0].ok(msg);
      }
    });
    await new Promise<void>((ok, fail) => { this.ws.once('open', () => ok()); this.ws.once('error', fail); });
    const welcome = this.wait('welcome');
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name, token });
    const w = await welcome;
    this.id = w.id; this.token = w.token; this.name = w.name; this.resumed = w.resumed;
    this.seq = 0;
    return this;
  }

  send(msg: C2S | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  wait<T extends S2C['t']>(type: T, pred: (m: Of<T>) => boolean = () => true, timeout = 4000): Promise<Of<T>> {
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`${this.name || 'client'}: timed out waiting for "${type}"`)), timeout);
      this.waiters.push({
        pred: (m) => m.t === type && pred(m as Of<T>),
        ok: (m) => { clearTimeout(timer); ok(m as Of<T>); },
      });
    });
  }

  /** Messages of a type received so far (snapshots excluded). */
  all<T extends S2C['t']>(type: T): Array<Of<T>> {
    return this.log.filter((m) => m.t === type) as Array<Of<T>>;
  }

  /** Sends input commands, one per simulation tick, paced in real time like a real client. */
  async input(ticks: number, buttons: number | ((i: number) => number), yaw = 0, pitch = 0, weapon = 0): Promise<CmdTuple[]> {
    const sent: CmdTuple[] = [];
    for (let i = 0; i < ticks; i++) {
      const c: CmdTuple = [++this.seq, typeof buttons === 'function' ? buttons(i) : buttons, yaw, pitch, weapon];
      sent.push(c);
      this.send({ t: 'i', rt: this.snap?.st ?? 0, c: [c] });
      await sleep(DT * 1000);
    }
    return sent;
  }

  /** Clicks the trigger once (press then release) while aiming at a world position. */
  async shootAt(from: { x: number; y: number; z: number }, target: [number, number, number], weapon: number): Promise<void> {
    const a = aimAt(from.x, from.y + EYE_HEIGHT, from.z, target[0], target[1], target[2]);
    await this.input(1, BTN.FIRE, a.yaw, a.pitch, weapon);
    await this.input(8, 0, a.yaw, a.pitch, weapon);
  }

  close(): void {
    this.ws.close();
  }
}

/** World position of the centre of a hitbox for a player standing at (x, 0, z) with yaw 0. */
export function partCentre(part: HitPart, x: number, z: number): [number, number, number] {
  const h = HITBOXES.find((b) => b.part === part)!;
  return [x + h.cx, h.cy, z + h.cz];
}

/** Creates a lobby with a host and guests, everyone readied, and starts the match. */
export async function startMatch(port: number, names: string[], settings: Record<string, unknown> = {}): Promise<TestClient[]> {
  const clients: TestClient[] = [];
  const host = await new TestClient(port).connect(names[0]);
  host.send({ t: 'create', settings });
  const code = (await host.wait('lobby')).lobby.code;
  clients.push(host);
  for (const name of names.slice(1)) {
    const c = await new TestClient(port).connect(name);
    c.send({ t: 'join', code });
    await c.wait('lobby');
    c.send({ t: 'ready', ready: true });
    clients.push(c);
  }
  await host.wait('lobby', (m) => m.lobby.members.length === names.length && m.lobby.members.filter((x) => x.ready).length === names.length - 1);
  const live = clients.map((c) => c.wait('match', (m) => m.match.phase === 'live'));
  host.send({ t: 'start' });
  await Promise.all(live);
  await Promise.all(clients.map((c) => c.wait('s')));
  return clients;
}
