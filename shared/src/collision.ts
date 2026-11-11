import { PLAYER_HEIGHT, PLAYER_RADIUS } from './constants';
import type { Box, MapDef } from './maps';

const EPS = 1e-4;

export interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
}

function overlaps(box: Box, x: number, y: number, z: number): boolean {
  return (
    x + PLAYER_RADIUS > box.min[0] && x - PLAYER_RADIUS < box.max[0] &&
    y + PLAYER_HEIGHT > box.min[1] && y < box.max[1] &&
    z + PLAYER_RADIUS > box.min[2] && z - PLAYER_RADIUS < box.max[2]
  );
}

/** True if a player standing at (x, y, z) would intersect map geometry. */
export function collidesAt(map: MapDef, x: number, y: number, z: number): boolean {
  if (y < 0) return true;
  for (const box of map.boxes) if (overlaps(box, x, y, z)) return true;
  return false;
}

/**
 * Moves a player body by its velocity for dt seconds, resolving collisions
 * against the map one axis at a time. Deterministic: the same inputs always
 * yield the same outputs on client and server.
 */
export function moveBody(body: Body, map: MapDef, dt: number): void {
  const boxes = map.boxes;

  body.x += body.vx * dt;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (!overlaps(box, body.x, body.y, body.z)) continue;
    if (body.vx > 0) body.x = box.min[0] - PLAYER_RADIUS - EPS;
    else if (body.vx < 0) body.x = box.max[0] + PLAYER_RADIUS + EPS;
    body.vx = 0;
  }

  body.z += body.vz * dt;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (!overlaps(box, body.x, body.y, body.z)) continue;
    if (body.vz > 0) body.z = box.min[2] - PLAYER_RADIUS - EPS;
    else if (body.vz < 0) body.z = box.max[2] + PLAYER_RADIUS + EPS;
    body.vz = 0;
  }

  body.y += body.vy * dt;
  body.onGround = false;
  if (body.y <= 0) {
    body.y = 0;
    body.vy = 0;
    body.onGround = true;
  }
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (!overlaps(box, body.x, body.y, body.z)) continue;
    if (body.vy <= 0) {
      body.y = box.max[1];
      body.onGround = true;
    } else {
      body.y = box.min[1] - PLAYER_HEIGHT - EPS;
    }
    body.vy = 0;
  }
}

/** Slab test. Returns the entry distance along the ray, or Infinity on a miss. */
export function rayBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number {
  let tmin = 0;
  let tmax = Infinity;

  if (Math.abs(dx) < 1e-9) {
    if (ox < minX || ox > maxX) return Infinity;
  } else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv;
    let t2 = (maxX - ox) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < minY || oy > maxY) return Infinity;
  } else {
    const inv = 1 / dy;
    let t1 = (minY - oy) * inv;
    let t2 = (maxY - oy) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (Math.abs(dz) < 1e-9) {
    if (oz < minZ || oz > maxZ) return Infinity;
  } else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv;
    let t2 = (maxZ - oz) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

/** Distance to the first solid surface (map box or floor) along a ray, capped at maxDist. */
export function raycastWorld(
  map: MapDef,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
): number {
  let best = maxDist;
  if (dy < -1e-9) {
    const t = -oy / dy;
    if (t >= 0 && t < best) best = t;
  }
  const boxes = map.boxes;
  for (let i = 0; i < boxes.length; i++) {
    const bx = boxes[i];
    const t = rayBox(ox, oy, oz, dx, dy, dz, bx.min[0], bx.min[1], bx.min[2], bx.max[0], bx.max[1], bx.max[2]);
    if (t < best) best = t;
  }
  return best;
}
