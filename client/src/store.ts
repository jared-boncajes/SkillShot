import { create } from 'zustand';
import type { LobbyState, MatchInfo, MatchResult, ScoreRow, Team } from '@aimstrike/shared';
import { loadName, loadSettings, saveSettings, type Settings } from './settings';

export type Screen = 'menu' | 'create' | 'join' | 'lobby' | 'howto' | 'settings';
export type ConnStatus = 'connecting' | 'online' | 'reconnecting';

export interface Hud {
  hp: number;
  alive: boolean;
  /** performance.now() timestamp of the respawn, 0 when alive. */
  respawnAt: number;
  weapon: number;
  mag: number;
  reserve: number;
  reloading: boolean;
  protected: boolean;
  timeLeft: number;
  scores: [number, number];
  live: boolean;
}

export interface FeedEntry {
  n: number;
  killer: string;
  victim: string;
  killerTeam: Team;
  victimTeam: Team;
  weapon: number;
  head: boolean;
  mine: boolean;
}

interface State {
  screen: Screen;
  conn: ConnStatus;
  myId: string;
  name: string;
  lobby: LobbyState | null;
  match: (MatchInfo & { receivedAt: number }) | null;
  result: (MatchResult & { receivedAt: number }) | null;
  rows: ScoreRow[];
  hud: Hud;
  feed: FeedEntry[];
  hitMarker: { n: number; head: boolean; kill: boolean };
  damage: { n: number; angle: number };
  banner: { n: number; text: string; sub: string };
  toast: { n: number; text: string; kind: 'error' | 'info' } | null;
  paused: boolean;
  pauseTab: 'main' | 'settings';
  scoreboard: boolean;
  loading: boolean;
  ping: number;
  fps: number;
  settings: Settings;
  set: (p: Partial<State>) => void;
  setHud: (p: Partial<Hud>) => void;
  setSettings: (p: Partial<Settings>) => void;
  showToast: (text: string, kind?: 'error' | 'info') => void;
  pushFeed: (e: Omit<FeedEntry, 'n'>) => void;
}

export const INITIAL_HUD: Hud = {
  hp: 100, alive: false, respawnAt: 0, weapon: 0, mag: 0, reserve: 0, reloading: false, protected: false,
  timeLeft: 0, scores: [0, 0], live: false,
};

let counter = 1;
export const nextN = () => counter++;

export const useStore = create<State>((set, get) => ({
  screen: 'menu',
  conn: 'connecting',
  myId: '',
  name: loadName(),
  lobby: null,
  match: null,
  result: null,
  rows: [],
  hud: INITIAL_HUD,
  feed: [],
  hitMarker: { n: 0, head: false, kill: false },
  damage: { n: 0, angle: 0 },
  banner: { n: 0, text: '', sub: '' },
  toast: null,
  paused: false,
  pauseTab: 'main',
  scoreboard: false,
  loading: false,
  ping: 0,
  fps: 0,
  settings: loadSettings(),
  set: (p) => set(p),
  setHud: (p) => set({ hud: { ...get().hud, ...p } }),
  setSettings: (p) => {
    const settings = { ...get().settings, ...p };
    saveSettings(settings);
    set({ settings });
  },
  showToast: (text, kind = 'error') => set({ toast: { n: nextN(), text, kind } }),
  pushFeed: (e) => set({ feed: [...get().feed.slice(-5), { ...e, n: nextN() }] }),
}));
