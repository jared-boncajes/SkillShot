/** Core simulation constants shared by client prediction and the authoritative server. */

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
/** Snapshots are broadcast every N simulation ticks (60 / 2 = 30 Hz). */
export const SNAPSHOT_EVERY_TICKS = 2;
/** How far in the past clients render remote players (ms). */
export const INTERP_DELAY_MS = 100;
/** Maximum lag-compensation rewind the server will grant a shot (ms). */
export const MAX_REWIND_MS = 250;

export const PLAYER_RADIUS = 0.32;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
export const MAX_HEALTH = 100;

export const MOVE = {
  runSpeed: 5.4,
  walkMul: 0.52,
  groundAccel: 55,
  groundFriction: 45,
  airAccel: 14,
  gravity: 22,
  jumpVel: 6.3,
} as const;

export const MAX_PITCH = 1.553; // ~89 degrees
export const MAX_SHOT_RANGE = 250;

export type HitPart = 'head' | 'torso' | 'arms' | 'legs' | 'feet';

/**
 * Body-part damage multipliers. Tunable for balancing. The head entry is the
 * default; each weapon carries its own headshot multiplier which takes priority.
 * The server can override these at boot through the DAMAGE_MULTIPLIERS env var.
 */
export const DAMAGE_MULTIPLIERS: Record<HitPart, number> = {
  head: 2.5,
  torso: 1.0,
  arms: 0.9,
  legs: 0.75,
  feet: 0.6,
};

export type Team = 'red' | 'blue';
export const TEAMS: Team[] = ['red', 'blue'];

export const LOBBY_CODE_LENGTH = 6;
export const MAX_NAME_LENGTH = 16;
export const MAX_TEAM_SIZE = 5;
