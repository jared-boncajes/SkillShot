import { DAMAGE_MULTIPLIERS, type HitPart } from './constants';
import { rayBox } from './collision';
import { damageFalloff, type WeaponDef } from './weapons';

/**
 * Player hitboxes in the player's local space (origin at the feet, facing -Z,
 * rotated by yaw). The client builds the visible character model from this
 * same table, so the silhouette on screen is the hit volume on the server.
 */
export interface HitboxDef {
  part: HitPart;
  /** Mesh/animation slot name. */
  name: 'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR' | 'footL' | 'footR';
  cx: number; cy: number; cz: number;
  hx: number; hy: number; hz: number;
}

export const HITBOXES: HitboxDef[] = [
  { part: 'head', name: 'head', cx: 0, cy: 1.63, cz: 0, hx: 0.13, hy: 0.15, hz: 0.13 },
  { part: 'torso', name: 'torso', cx: 0, cy: 1.16, cz: 0, hx: 0.24, hy: 0.31, hz: 0.14 },
  { part: 'arms', name: 'armL', cx: -0.32, cy: 1.15, cz: 0, hx: 0.075, hy: 0.3, hz: 0.09 },
  { part: 'arms', name: 'armR', cx: 0.32, cy: 1.15, cz: 0, hx: 0.075, hy: 0.3, hz: 0.09 },
  { part: 'legs', name: 'legL', cx: -0.12, cy: 0.5, cz: 0, hx: 0.11, hy: 0.35, hz: 0.11 },
  { part: 'legs', name: 'legR', cx: 0.12, cy: 0.5, cz: 0, hx: 0.11, hy: 0.35, hz: 0.11 },
  { part: 'feet', name: 'footL', cx: -0.12, cy: 0.075, cz: -0.04, hx: 0.11, hy: 0.075, hz: 0.16 },
  { part: 'feet', name: 'footR', cx: 0.12, cy: 0.075, cz: -0.04, hx: 0.11, hy: 0.075, hz: 0.16 },
];

export interface PlayerHit {
  t: number;
  part: HitPart;
}

const hitOut: PlayerHit = { t: 0, part: 'torso' };

/**
 * Ray versus one player's hitboxes. Returns the nearest hit closer than maxT,
 * or null. The returned object is reused between calls - copy what you need.
 */
export function raycastPlayer(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  px: number, py: number, pz: number, yaw: number,
  maxT: number,
): PlayerHit | null {
  // Cheap bounding-sphere reject before testing the eight boxes.
  const cx = px - ox, cy = py + 0.9 - oy, cz = pz - oz;
  const along = cx * dx + cy * dy + cz * dz;
  if (along < -1.2 || along > maxT + 1.2) return null;
  const perp2 = cx * cx + cy * cy + cz * cz - along * along;
  if (perp2 > 1.2 * 1.2) return null;

  // Rotate the ray into the player's local space.
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const rx = ox - px, ry = oy - py, rz = oz - pz;
  const lox = rx * c - rz * s, loz = rx * s + rz * c;
  const ldx = dx * c - dz * s, ldz = dx * s + dz * c;

  let best = maxT;
  let part: HitPart | null = null;
  for (let i = 0; i < HITBOXES.length; i++) {
    const h = HITBOXES[i];
    const t = rayBox(
      lox, ry, loz, ldx, dy, ldz,
      h.cx - h.hx, h.cy - h.hy, h.cz - h.hz,
      h.cx + h.hx, h.cy + h.hy, h.cz + h.hz,
    );
    if (t < best) {
      best = t;
      part = h.part;
    }
  }
  if (part === null) return null;
  hitOut.t = best;
  hitOut.part = part;
  return hitOut;
}

/** Final damage for a verified hit. No randomness, no critical hits. */
export function computeDamage(
  def: WeaponDef,
  part: HitPart,
  dist: number,
  multipliers: Record<HitPart, number> = DAMAGE_MULTIPLIERS,
): number {
  const mult = part === 'head' ? def.headMult : multipliers[part];
  return Math.round(def.damage * mult * damageFalloff(def, dist));
}
