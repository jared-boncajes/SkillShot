export type Quality = 'low' | 'medium' | 'high';

export interface CrosshairSettings {
  color: string;
  size: number;
  gap: number;
  thickness: number;
  dot: boolean;
  outline: boolean;
  /** Widen the gap to show movement inaccuracy. */
  dynamic: boolean;
}

export interface Settings {
  /** Source-engine style: degrees turned per mouse count = 0.022 x sensitivity. */
  sensitivity: number;
  /** Horizontal field of view in degrees (at 16:9). */
  fov: number;
  master: number;
  sfx: number;
  music: number;
  quality: Quality;
  resScale: number;
  showFps: boolean;
  viewBob: boolean;
  crosshair: CrosshairSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 2.2,
  fov: 103,
  master: 0.8,
  sfx: 0.9,
  music: 0.35,
  quality: 'medium',
  resScale: 1,
  showFps: false,
  viewBob: true,
  crosshair: { color: '#39ff9e', size: 7, gap: 4, thickness: 2, dot: false, outline: true, dynamic: true },
};

const KEY = 'aimstrike.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed, crosshair: { ...DEFAULT_SETTINGS.crosshair, ...(parsed.crosshair || {}) } };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private mode) - settings just will not persist */
  }
}

export function loadName(): string {
  try {
    return localStorage.getItem('aimstrike.name') || '';
  } catch {
    return '';
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem('aimstrike.name', name);
  } catch {
    /* ignore */
  }
}
