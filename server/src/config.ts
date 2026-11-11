import { DAMAGE_MULTIPLIERS, type HitPart } from '@aimstrike/shared';

export interface ServerConfig {
  port: number;
  host: string;
  /** Minimum players required to start a match (2 in production; 1 is handy for solo testing). */
  minPlayers: number;
  countdownMs: number;
  resultsMs: number;
  /** How long a disconnected player's slot is held for reconnection. */
  reconnectGraceMs: number;
  /** Overrides for mode rules; null means use the mode's own value. */
  matchDurationSec: number | null;
  scoreLimit: number | null;
  respawnMs: number | null;
  spawnProtectionMs: number | null;
  /** Comma separated list of allowed WebSocket origins; empty allows any. */
  allowedOrigins: string[];
  /** Directory of a built client to serve over HTTP; empty disables static serving. */
  clientDist: string;
  maxRooms: number;
  damageMultipliers: Record<HitPart, number>;
  log: boolean;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseMultipliers(raw: string | undefined): Record<HitPart, number> {
  const out = { ...DAMAGE_MULTIPLIERS };
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(out) as HitPart[]) {
      const v = parsed[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
    }
  } catch {
    console.warn('[config] DAMAGE_MULTIPLIERS is not valid JSON; using defaults');
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: num(env.PORT) ?? 2567,
    host: env.HOST || '0.0.0.0',
    minPlayers: Math.max(1, num(env.MIN_PLAYERS) ?? 2),
    countdownMs: num(env.COUNTDOWN_MS) ?? 5000,
    resultsMs: num(env.RESULTS_MS) ?? 10000,
    reconnectGraceMs: num(env.RECONNECT_GRACE_MS) ?? 30000,
    matchDurationSec: num(env.MATCH_DURATION_SEC),
    scoreLimit: num(env.SCORE_LIMIT),
    respawnMs: num(env.RESPAWN_MS),
    spawnProtectionMs: num(env.SPAWN_PROTECTION_MS),
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    clientDist: env.CLIENT_DIST ?? '',
    maxRooms: num(env.MAX_ROOMS) ?? 200,
    damageMultipliers: parseMultipliers(env.DAMAGE_MULTIPLIERS),
    log: env.LOG !== '0',
  };
}
