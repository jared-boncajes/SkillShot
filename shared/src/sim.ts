import { DT, EYE_HEIGHT, MAX_PITCH, MOVE } from './constants';
import { moveBody } from './collision';
import type { MapDef } from './maps';
import { WEAPONS, WEAPON_COUNT, recoilPitch, recoilYaw, type WeaponDef } from './weapons';

/** Input button bitmask. */
export const BTN = {
  FORWARD: 1,
  BACK: 2,
  LEFT: 4,
  RIGHT: 8,
  JUMP: 16,
  WALK: 32,
  FIRE: 64,
  RELOAD: 128,
} as const;

/** One tick of player input. Each command advances the simulation by exactly DT. */
export interface Cmd {
  seq: number;
  buttons: number;
  yaw: number;
  pitch: number;
  weapon: number;
}

/**
 * Everything needed to advance one player deterministically. The server owns
 * the authoritative copy; the client keeps a predicted copy and replays
 * unacknowledged commands on top of each server snapshot.
 */
export interface SimState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  onGround: boolean;
  jumpHeld: boolean;
  weapon: number;
  mags: number[];
  reserves: number[];
  cooldown: number;
  reload: number;
  equip: number;
  heat: number;
  sinceShot: number;
  burstLeft: number;
  shotCount: number;
  triggerHeld: boolean;
  fireQueued: boolean;
}

export interface ShotEvent {
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
  weapon: number;
}

export function createSimState(x: number, y: number, z: number, weapon: number): SimState {
  return {
    x, y, z, vx: 0, vy: 0, vz: 0,
    onGround: true,
    jumpHeld: false,
    weapon,
    mags: WEAPONS.map((w) => w.magSize),
    reserves: WEAPONS.map((w) => w.reserve),
    cooldown: 0,
    reload: 0,
    equip: 0,
    heat: 0,
    sinceShot: 10,
    burstLeft: 0,
    shotCount: 0,
    triggerHeld: false,
    fireQueued: false,
  };
}

export function copySimState(dst: SimState, src: SimState): void {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
  dst.onGround = src.onGround;
  dst.jumpHeld = src.jumpHeld;
  dst.weapon = src.weapon;
  for (let i = 0; i < WEAPON_COUNT; i++) {
    dst.mags[i] = src.mags[i];
    dst.reserves[i] = src.reserves[i];
  }
  dst.cooldown = src.cooldown;
  dst.reload = src.reload;
  dst.equip = src.equip;
  dst.heat = src.heat;
  dst.sinceShot = src.sinceShot;
  dst.burstLeft = src.burstLeft;
  dst.shotCount = src.shotCount;
  dst.triggerHeld = src.triggerHeld;
  dst.fireQueued = src.fireQueued;
}

/**
 * Movement inaccuracy cone radius in radians. Zero while standing or walking
 * (Shift), growing linearly to the weapon's run value at full speed, and fixed
 * at the air value while airborne. Entirely predictable: stop or walk to be
 * perfectly accurate.
 */
export function movementSpread(def: WeaponDef, s: SimState): number {
  if (!s.onGround) return def.spread.air;
  const speed = Math.hypot(s.vx, s.vz);
  const max = MOVE.runSpeed * def.moveMul;
  const threshold = max * 0.6;
  if (speed <= threshold) return 0;
  return def.spread.run * Math.min(1, (speed - threshold) / (max - threshold));
}

const GOLDEN_ANGLE = 2.399963229728653;
const EPS = 1e-9;

function emitShot(s: SimState, cmd: Cmd, def: WeaponDef, shots: ShotEvent[] | null): void {
  const spread = movementSpread(def, s);
  let yaw = cmd.yaw + recoilYaw(def, s.heat);
  let pitch = cmd.pitch + recoilPitch(def, s.heat);
  if (spread > 0) {
    // Deterministic spiral pattern inside the cone - no RNG anywhere in the shot path.
    const a = s.shotCount * GOLDEN_ANGLE;
    const r = spread * (0.35 + 0.65 * ((s.shotCount * 0.6180339887) % 1));
    yaw += Math.cos(a) * r;
    pitch += Math.sin(a) * r;
  }
  if (pitch > MAX_PITCH) pitch = MAX_PITCH;
  else if (pitch < -MAX_PITCH) pitch = -MAX_PITCH;

  s.mags[s.weapon]--;
  s.shotCount++;
  s.heat = Math.min(def.recoil.maxHeat, s.heat + 1);
  s.sinceShot = 0;

  if (shots) {
    const cp = Math.cos(pitch);
    shots.push({
      ox: s.x, oy: s.y + EYE_HEIGHT, oz: s.z,
      dx: -Math.sin(yaw) * cp, dy: Math.sin(pitch), dz: -Math.cos(yaw) * cp,
      weapon: s.weapon,
    });
  }
}

function stepWeapon(s: SimState, cmd: Cmd, shots: ShotEvent[] | null): void {
  const b = cmd.buttons;

  if (cmd.weapon !== s.weapon && cmd.weapon >= 0 && cmd.weapon < WEAPON_COUNT) {
    s.weapon = cmd.weapon;
    s.equip = WEAPONS[s.weapon].equipTime;
    s.reload = 0;
    s.burstLeft = 0;
    s.heat = 0;
    s.cooldown = 0;
    s.fireQueued = false;
  }
  const def = WEAPONS[s.weapon];

  if (s.equip > 0) s.equip = Math.max(0, s.equip - DT);
  if (s.cooldown > -DT) s.cooldown -= DT;

  if (s.reload > 0) {
    s.reload -= DT;
    if (s.reload <= EPS) {
      s.reload = 0;
      const n = Math.min(def.magSize - s.mags[s.weapon], s.reserves[s.weapon]);
      s.mags[s.weapon] += n;
      s.reserves[s.weapon] -= n;
    }
  }

  const fire = (b & BTN.FIRE) !== 0;
  const pressed = fire && !s.triggerHeld;
  s.triggerHeld = fire;
  const ready = s.equip <= 0 && s.reload <= 0;

  if (def.mode !== 'auto') {
    // Buffer a click that lands just before the weapon is ready so semi-auto feels responsive.
    if (pressed && s.burstLeft === 0 && s.cooldown <= 0.12) s.fireQueued = true;
    if (!ready || s.mags[s.weapon] <= 0) s.fireQueued = false;
  }

  if (ready && s.mags[s.weapon] > 0) {
    if (def.mode === 'burst') {
      if (s.burstLeft === 0 && s.fireQueued && s.cooldown <= EPS) {
        s.burstLeft = def.burstCount;
        s.fireQueued = false;
      }
      if (s.burstLeft > 0 && s.cooldown <= EPS) {
        emitShot(s, cmd, def, shots);
        s.burstLeft--;
        if (s.mags[s.weapon] <= 0) s.burstLeft = 0;
        s.cooldown = (s.cooldown > -DT + 1e-6 ? s.cooldown : 0) + (s.burstLeft > 0 ? def.burstInterval : def.fireInterval);
      }
    } else if (s.cooldown <= EPS && (def.mode === 'auto' ? fire : s.fireQueued)) {
      s.fireQueued = false;
      emitShot(s, cmd, def, shots);
      s.cooldown = (s.cooldown > -DT + 1e-6 ? s.cooldown : 0) + def.fireInterval;
    }
  }

  // Reload on request, or automatically when the magazine runs dry.
  if (
    ready && s.burstLeft === 0 && s.reserves[s.weapon] > 0 && s.mags[s.weapon] < def.magSize &&
    ((b & BTN.RELOAD) !== 0 || s.mags[s.weapon] <= 0)
  ) {
    s.reload = def.reloadTime;
    s.fireQueued = false;
  }

  s.sinceShot += DT;
  if (s.heat > 0 && s.sinceShot > def.recoil.recoverDelay) {
    s.heat = Math.max(0, s.heat - def.recoil.recoverRate * DT);
  }
}

function stepMovement(s: SimState, cmd: Cmd, map: MapDef): void {
  const b = cmd.buttons;
  const def = WEAPONS[s.weapon];
  const fwd = ((b & BTN.FORWARD) ? 1 : 0) - ((b & BTN.BACK) ? 1 : 0);
  const side = ((b & BTN.RIGHT) ? 1 : 0) - ((b & BTN.LEFT) ? 1 : 0);
  const sin = Math.sin(cmd.yaw), cos = Math.cos(cmd.yaw);
  let wx = -sin * fwd + cos * side;
  let wz = -cos * fwd - sin * side;
  const wl = Math.hypot(wx, wz);
  const hasInput = wl > 1e-6;
  if (hasInput) { wx /= wl; wz /= wl; }

  const maxSpeed = MOVE.runSpeed * def.moveMul * ((b & BTN.WALK) ? MOVE.walkMul : 1);
  const jump = (b & BTN.JUMP) !== 0;

  if (s.onGround) {
    const tx = hasInput ? wx * maxSpeed : 0;
    const tz = hasInput ? wz * maxSpeed : 0;
    const ex = tx - s.vx, ez = tz - s.vz;
    const el = Math.hypot(ex, ez);
    const rate = (hasInput ? MOVE.groundAccel : MOVE.groundFriction) * DT;
    if (el <= rate) { s.vx = tx; s.vz = tz; }
    else { s.vx += (ex / el) * rate; s.vz += (ez / el) * rate; }
    if (jump && !s.jumpHeld) {
      s.vy = MOVE.jumpVel;
      s.onGround = false;
    }
  } else if (hasInput) {
    // Limited air control: can only add speed along the wish direction up to maxSpeed.
    const cur = s.vx * wx + s.vz * wz;
    const add = Math.min(MOVE.airAccel * DT, Math.max(0, maxSpeed - cur));
    s.vx += wx * add;
    s.vz += wz * add;
  }
  s.jumpHeld = jump;

  s.vy -= MOVE.gravity * DT;
  moveBody(s, map, DT);
}

/**
 * Advances one player by one tick. Any shots fired during the tick are appended
 * to `shots` (pass null when replaying commands during reconciliation).
 */
export function stepSim(s: SimState, cmd: Cmd, map: MapDef, shots: ShotEvent[] | null): void {
  stepMovement(s, cmd, map);
  stepWeapon(s, cmd, shots);
}
