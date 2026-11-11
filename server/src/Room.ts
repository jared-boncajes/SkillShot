import {
  DEFAULT_MAP, DEFAULT_MODE, MAPS, MAX_TEAM_SIZE, MODES, WEAPON_COUNT,
  type CmdTuple, type ErrorCode, type LobbyMember, type LobbySettings, type LobbyState, type MatchResult,
  type RoomPhase, type S2C, type Team,
} from '@aimstrike/shared';
import type { ServerConfig } from './config';
import { Match } from './Match';

export interface Member extends LobbyMember {
  token: string;
  /** Sends a message to this member's socket; null while disconnected. */
  sink: ((data: string) => void) | null;
  graceTimer: NodeJS.Timeout | null;
}

export class RoomError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

export function sanitizeSettings(input: Partial<LobbySettings> | undefined, base: LobbySettings): LobbySettings {
  const out = { ...base };
  if (!input || typeof input !== 'object') return out;
  if (typeof input.mapId === 'string' && MAPS[input.mapId]) out.mapId = input.mapId;
  if (typeof input.modeId === 'string' && MODES[input.modeId]) out.modeId = input.modeId;
  if (typeof input.teamSize === 'number' && Number.isInteger(input.teamSize)) {
    out.teamSize = Math.min(MAX_TEAM_SIZE, Math.max(1, input.teamSize));
  }
  if (typeof input.isPublic === 'boolean') out.isPublic = input.isPublic;
  return out;
}

export const DEFAULT_SETTINGS: LobbySettings = { mapId: DEFAULT_MAP, modeId: DEFAULT_MODE, teamSize: MAX_TEAM_SIZE, isPublic: false };

/** A lobby and (while one is running) its match. Players stay in the room across matches. */
export class Room {
  readonly members = new Map<string, Member>();
  hostId = '';
  phase: RoomPhase = 'lobby';
  settings: LobbySettings;
  match: Match | null = null;
  private returnTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly code: string,
    settings: LobbySettings,
    private readonly cfg: ServerConfig,
    private readonly onEmpty: (room: Room) => void,
    private readonly onMemberGone: (member: Member) => void,
  ) {
    this.settings = settings;
  }

  get capacity(): number {
    return this.settings.teamSize * 2;
  }

  get isFull(): boolean {
    return this.members.size >= this.capacity;
  }

  private teamCount(team: Team): number {
    let n = 0;
    for (const m of this.members.values()) if (m.team === team) n++;
    return n;
  }

  private uniqueName(name: string): string {
    const taken = new Set([...this.members.values()].map((m) => m.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, 12)} (${i})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  state(): LobbyState {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      members: [...this.members.values()].map((m) => ({
        id: m.id, name: m.name, team: m.team, weapon: m.weapon, ready: m.ready, connected: m.connected, ping: m.ping,
      })),
    };
  }

  send(id: string, msg: S2C | string): void {
    const m = this.members.get(id);
    if (m?.sink) m.sink(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  broadcast(msg: S2C, exceptId?: string): void {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) if (m.sink && m.id !== exceptId) m.sink(data);
  }

  broadcastLobby(): void {
    this.broadcast({ t: 'lobby', lobby: this.state() });
  }

  /** Adds a player. Joining mid-match is allowed: they are assigned a team and dropped into play. */
  join(id: string, name: string, token: string, sink: (data: string) => void): Member {
    if (this.isFull) throw new RoomError('lobby_full', `Lobby ${this.code} is full (${this.capacity}/${this.capacity}).`);
    const team: Team = this.teamCount('red') <= this.teamCount('blue') ? 'red' : 'blue';
    const member: Member = {
      id, name: this.uniqueName(name), team, weapon: 0, ready: false, connected: true, ping: 0,
      token, sink, graceTimer: null,
    };
    this.members.set(id, member);
    if (!this.hostId) this.hostId = id;
    this.broadcastLobby();
    if (this.match && this.phase !== 'ended') {
      this.match.addPlayer(member);
      this.send(id, { t: 'match', match: this.match.info() });
    }
    return member;
  }

  /** Permanently removes a player (explicit leave or reconnect grace expired). */
  leave(id: string): void {
    const m = this.members.get(id);
    if (!m) return;
    if (m.graceTimer) clearTimeout(m.graceTimer);
    this.members.delete(id);
    this.match?.removePlayer(id);
    this.onMemberGone(m);
    this.afterDeparture(id);
  }

  /** Socket dropped: hold the slot for a while so the player can reconnect. */
  disconnect(id: string): void {
    const m = this.members.get(id);
    if (!m) return;
    m.sink = null;
    m.connected = false;
    m.ready = false;
    this.match?.setConnected(id, false);
    if (m.graceTimer) clearTimeout(m.graceTimer);
    m.graceTimer = setTimeout(() => this.leave(id), this.cfg.reconnectGraceMs);
    this.afterDeparture(id);
  }

  /** Rebinds a returning player to their held slot. */
  resume(id: string, sink: (data: string) => void): Member | null {
    const m = this.members.get(id);
    if (!m) return null;
    if (m.graceTimer) clearTimeout(m.graceTimer);
    m.graceTimer = null;
    m.sink = sink;
    m.connected = true;
    this.match?.setConnected(id, true);
    this.broadcastLobby();
    if (this.match && this.phase !== 'ended') this.send(id, { t: 'match', match: this.match.info() });
    return m;
  }

  private afterDeparture(id: string): void {
    const connected = [...this.members.values()].filter((m) => m.connected);
    if (connected.length === 0 && [...this.members.values()].every((m) => !m.graceTimer)) {
      this.dispose();
      this.onEmpty(this);
      return;
    }
    // Host migration: if the host left or dropped, hand the lobby to the next connected player.
    if (this.hostId === id || !this.members.get(this.hostId)?.connected) {
      if (connected.length > 0) this.hostId = connected[0].id;
    }
    if (this.members.size === 0) {
      this.dispose();
      this.onEmpty(this);
      return;
    }
    this.broadcastLobby();
  }

  private requireLobby(): void {
    if (this.phase !== 'lobby') throw new RoomError('in_progress', 'That can only be changed in the lobby, between matches.');
  }

  setTeam(id: string, team: Team): void {
    this.requireLobby();
    const m = this.members.get(id);
    if (!m || m.team === team) return;
    if (this.teamCount(team) >= this.settings.teamSize) throw new RoomError('team_full', `${team === 'red' ? 'Red' : 'Blue'} team is full.`);
    m.team = team;
    this.broadcastLobby();
  }

  setWeapon(id: string, weapon: number): void {
    const m = this.members.get(id);
    if (!m || !Number.isInteger(weapon) || weapon < 0 || weapon >= WEAPON_COUNT) return;
    m.weapon = weapon;
    this.broadcastLobby();
  }

  setReady(id: string, ready: boolean): void {
    this.requireLobby();
    const m = this.members.get(id);
    if (!m) return;
    m.ready = ready;
    this.broadcastLobby();
  }

  updateSettings(id: string, input: Partial<LobbySettings>): void {
    this.requireLobby();
    if (id !== this.hostId) throw new RoomError('not_host', 'Only the lobby host can change match settings.');
    const next = sanitizeSettings(input, this.settings);
    if (next.teamSize * 2 < this.members.size) {
      throw new RoomError('bad_request', `Team size ${next.teamSize} is too small for the ${this.members.size} players already here.`);
    }
    this.settings = next;
    // Rebalance anyone left on an over-full team after shrinking.
    for (const team of ['red', 'blue'] as Team[]) {
      const other: Team = team === 'red' ? 'blue' : 'red';
      for (const m of this.members.values()) {
        if (this.teamCount(team) <= next.teamSize) break;
        if (m.team === team) m.team = other;
      }
    }
    this.broadcastLobby();
  }

  start(id: string, wallNow: number): void {
    this.requireLobby();
    if (id !== this.hostId) throw new RoomError('not_host', 'Only the lobby host can start the match.');
    const present = [...this.members.values()].filter((m) => m.connected);
    if (present.length < this.cfg.minPlayers) {
      throw new RoomError('not_enough_players', `At least ${this.cfg.minPlayers} players are needed to start.`);
    }
    const notReady = present.filter((m) => m.id !== this.hostId && !m.ready);
    if (notReady.length > 0) {
      throw new RoomError('not_ready', `Waiting for ${notReady.map((m) => m.name).join(', ')} to ready up.`);
    }
    const mode = MODES[this.settings.modeId];
    if (mode.teamBased) {
      const red = present.filter((m) => m.team === 'red').length;
      const blue = present.length - red;
      if (red > this.settings.teamSize || blue > this.settings.teamSize) {
        throw new RoomError('unbalanced', 'A team has more players than the team size allows.');
      }
      if (present.length >= 2 && (red === 0 || blue === 0)) {
        throw new RoomError('unbalanced', 'Both teams need at least one player.');
      }
    }
    this.phase = 'countdown';
    this.match = new Match(
      MAPS[this.settings.mapId], mode, this.cfg,
      {
        send: (pid, msg) => this.send(pid, msg),
        broadcast: (msg, except) => {
          if (msg.t === 'match' && msg.match.phase === 'live') this.phase = 'live';
          this.broadcast(msg, except);
        },
        onEnd: (result) => this.onMatchEnd(result),
      },
      [...this.members.values()],
      wallNow,
    );
    this.broadcastLobby();
    this.broadcast({ t: 'match', match: this.match.info() });
  }

  private onMatchEnd(result: MatchResult): void {
    this.phase = 'ended';
    this.broadcast({ t: 'end', result });
    this.broadcastLobby();
    this.returnTimer = setTimeout(() => this.returnToLobby(), this.cfg.resultsMs);
  }

  /** Match over: everyone stays connected in the same lobby, ready for the host to start again. */
  returnToLobby(): void {
    if (this.returnTimer) clearTimeout(this.returnTimer);
    this.returnTimer = null;
    this.match = null;
    this.phase = 'lobby';
    for (const m of this.members.values()) m.ready = false;
    this.broadcastLobby();
  }

  input(id: string, rt: number, cmds: CmdTuple[]): void {
    this.match?.queueInput(id, rt, cmds);
  }

  setPing(id: string, ping: number): void {
    const m = this.members.get(id);
    if (!m) return;
    m.ping = ping;
    this.match?.setPing(id, ping);
  }

  update(wallNow: number): void {
    if (this.match && this.phase !== 'ended' && this.phase !== 'lobby') this.match.update(wallNow);
  }

  dispose(): void {
    if (this.returnTimer) clearTimeout(this.returnTimer);
    for (const m of this.members.values()) if (m.graceTimer) clearTimeout(m.graceTimer);
    this.match = null;
  }
}
