import type { HitPart, Team } from './constants';
import type { SimState } from './sim';

/** Bump when the wire format changes; mismatched clients are told to refresh. */
export const PROTOCOL_VERSION = 1;
export const WS_PATH = '/ws';

export interface LobbySettings {
  mapId: string;
  modeId: string;
  /** Players per team, 1-5. Lobby capacity is twice this. */
  teamSize: number;
  /** Public lobbies can be found through "Play" (quick match). */
  isPublic: boolean;
}

export interface LobbyMember {
  id: string;
  name: string;
  team: Team;
  weapon: number;
  ready: boolean;
  connected: boolean;
  ping: number;
}

export type RoomPhase = 'lobby' | 'countdown' | 'live' | 'ended';

export interface LobbyState {
  code: string;
  hostId: string;
  phase: RoomPhase;
  settings: LobbySettings;
  members: LobbyMember[];
}

export interface MatchInfo {
  mapId: string;
  modeId: string;
  phase: 'countdown' | 'live';
  /** Milliseconds until the match goes live (0 when already live). */
  startsInMs: number;
  /** Milliseconds of play remaining once live. */
  remainingMs: number;
  scoreLimit: number;
}

export interface ScoreRow {
  id: string;
  name: string;
  team: Team;
  kills: number;
  deaths: number;
  /** Percent of hits that were headshots. */
  hsPct: number;
  /** Percent of shots that hit an opponent. */
  accPct: number;
  ping: number;
  connected: boolean;
}

export interface MatchResult {
  winner: Team | 'tie' | string;
  /** Display name of the winner for non-team modes. */
  winnerName: string;
  reason: 'score' | 'time';
  scores: [number, number];
  rows: ScoreRow[];
  /** Milliseconds until everyone is returned to the lobby. */
  returnInMs: number;
}

/** [seq, buttons, yaw, pitch, weapon] */
export type CmdTuple = [number, number, number, number, number];

/** [id, x, y, z, yaw, pitch, flags, weapon] */
export type RemoteTuple = [string, number, number, number, number, number, number, number];
export const PF = { ALIVE: 1, PROTECTED: 2, GROUND: 4, RELOADING: 8 } as const;

export type C2S =
  | { t: 'hello'; v: number; name: string; token?: string }
  | { t: 'create'; name?: string; settings?: Partial<LobbySettings> }
  | { t: 'join'; name?: string; code: string }
  | { t: 'quick'; name?: string }
  | { t: 'leave' }
  | { t: 'team'; team: Team }
  | { t: 'weapon'; weapon: number }
  | { t: 'ready'; ready: boolean }
  | { t: 'settings'; settings: Partial<LobbySettings> }
  | { t: 'start' }
  | { t: 'i'; rt: number; c: CmdTuple[] }
  | { t: 'ping'; c: number; rtt: number };

export interface SnapshotMsg {
  t: 's';
  /** Server match clock (ms) this snapshot was taken at. */
  st: number;
  /** Sequence number of the last input command the server consumed from this client. */
  ack: number;
  /** This client's authoritative simulation state. */
  me: SimState;
  hp: number;
  alive: boolean;
  /** Milliseconds until respawn while dead. */
  respawnIn: number;
  /** Increments every spawn; the client snaps its view to `yaw` when it changes. */
  life: number;
  yaw: number;
  /** Milliseconds of match time left. */
  left: number;
  sc: [number, number];
  p: RemoteTuple[];
}

export type S2C =
  | { t: 'welcome'; id: string; token: string; name: string; resumed: boolean }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'lobby'; lobby: LobbyState }
  | { t: 'left' }
  | { t: 'match'; match: MatchInfo }
  | SnapshotMsg
  | { t: 'shot'; id: string; w: number; o: [number, number, number]; e: [number, number, number] }
  | { t: 'hit'; victim: string; part: HitPart; dmg: number; killed: boolean }
  | { t: 'dmg'; from: string; dmg: number; ax: number; az: number }
  | { t: 'kill'; killer: string; victim: string; weapon: number; head: boolean }
  | { t: 'score'; sc: [number, number]; rows: ScoreRow[] }
  | { t: 'end'; result: MatchResult }
  | { t: 'pong'; c: number };

export type ErrorCode =
  | 'bad_request'
  | 'version'
  | 'not_found'
  | 'lobby_full'
  | 'team_full'
  | 'not_host'
  | 'not_ready'
  | 'not_enough_players'
  | 'unbalanced'
  | 'in_progress'
  | 'rate_limited'
  | 'server_full';
