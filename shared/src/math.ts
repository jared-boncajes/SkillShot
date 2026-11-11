export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  else if (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolates along the shortest arc between two angles. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/** Yaw / pitch that look from one point at another, in the game's angle convention. */
export function aimAt(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): { yaw: number; pitch: number } {
  const dx = tx - fx, dy = ty - fy, dz = tz - fz;
  const len = Math.hypot(dx, dy, dz) || 1;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.asin(dy / len) };
}
