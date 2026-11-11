/**
 * Weapon configuration. Every value that affects gameplay lives here so the
 * arsenal can be rebalanced in one place. Client prediction and the server
 * simulation both read this table, so they always agree.
 */

export type FireMode = 'auto' | 'semi' | 'burst';

export interface WeaponDef {
  id: string;
  name: string;
  /** Short class label shown in UI. */
  role: string;
  specialty: string;
  tradeoff: string;
  /** Base damage against the torso inside effective range. */
  damage: number;
  headMult: number;
  mode: FireMode;
  /** Seconds between shots (between bursts for burst weapons). */
  fireInterval: number;
  burstCount: number;
  burstInterval: number;
  /** Full damage up to rangeStart, linear falloff to minFalloff at rangeEnd. */
  rangeStart: number;
  rangeEnd: number;
  minFalloff: number;
  magSize: number;
  reserve: number;
  reloadTime: number;
  /** Seconds before the weapon can fire after being drawn. */
  equipTime: number;
  /** Movement speed multiplier while held. */
  moveMul: number;
  recoil: {
    /** Vertical climb in radians per unit of heat (one shot = one heat). */
    vertical: number;
    /** Horizontal sway amplitude in radians. */
    horizontal: number;
    /** Horizontal sway frequency (radians of phase per shot). */
    hFreq: number;
    maxHeat: number;
    /** Seconds after the last shot before the pattern starts resetting. */
    recoverDelay: number;
    /** Heat removed per second while recovering. */
    recoverRate: number;
  };
  /** Extra cone radius (radians) at full run speed / while airborne. Zero when still or walking. */
  spread: { run: number; air: number };
  visual: {
    body: number;
    accent: number;
    /** [length, height, width] of receiver, metres. */
    receiver: [number, number, number];
    barrel: number;
    stock: number;
    mag: [number, number];
    scope: boolean;
    tracer: number;
  };
  audio: {
    /** Body thump frequency in Hz. */
    thump: number;
    /** Noise band centre in Hz. */
    crack: number;
    /** Decay time in seconds. */
    decay: number;
    gain: number;
  };
}

export const WEAPONS: WeaponDef[] = [
  {
    id: 'vanguard',
    name: 'VX-9 Vanguard',
    role: 'Standard Rifle',
    specialty: 'Balanced accuracy and damage at every range',
    tradeoff: 'Average handling and fire rate; no standout strength',
    damage: 30,
    headMult: 2.5,
    mode: 'auto',
    fireInterval: 0.1,
    burstCount: 1,
    burstInterval: 0,
    rangeStart: 30,
    rangeEnd: 60,
    minFalloff: 0.8,
    magSize: 30,
    reserve: 90,
    reloadTime: 2.3,
    equipTime: 0.55,
    moveMul: 0.95,
    recoil: { vertical: 0.0085, horizontal: 0.006, hFreq: 0.55, maxHeat: 9, recoverDelay: 0.16, recoverRate: 14 },
    spread: { run: 0.03, air: 0.07 },
    visual: { body: 0x3a4250, accent: 0xf2a33a, receiver: [0.42, 0.11, 0.06], barrel: 0.3, stock: 0.22, mag: [0.07, 0.17], scope: false, tracer: 0xffd27a },
    audio: { thump: 150, crack: 1800, decay: 0.16, gain: 0.85 },
  },
  {
    id: 'halcyon',
    name: 'Halcyon PR',
    role: 'Precision Rifle',
    specialty: 'Pin-point semi-auto with a lethal headshot bonus',
    tradeoff: 'Slow firing; weak if you miss the head',
    damage: 38,
    headMult: 3.0,
    mode: 'semi',
    fireInterval: 0.32,
    burstCount: 1,
    burstInterval: 0,
    rangeStart: 40,
    rangeEnd: 80,
    minFalloff: 0.85,
    magSize: 12,
    reserve: 48,
    reloadTime: 2.4,
    equipTime: 0.6,
    moveMul: 0.93,
    recoil: { vertical: 0.012, horizontal: 0.0015, hFreq: 0.9, maxHeat: 3, recoverDelay: 0.12, recoverRate: 9 },
    spread: { run: 0.04, air: 0.09 },
    visual: { body: 0x2f3d36, accent: 0x5fe0b0, receiver: [0.46, 0.1, 0.055], barrel: 0.36, stock: 0.26, mag: [0.06, 0.11], scope: false, tracer: 0x9dffd8 },
    audio: { thump: 180, crack: 2600, decay: 0.2, gain: 0.9 },
  },
  {
    id: 'wasp',
    name: 'Wasp-45',
    role: 'Rapid SMG',
    specialty: 'Very fast fire and mobility for close-range tracking',
    tradeoff: 'Low damage that falls off sharply at distance',
    damage: 19,
    headMult: 2.2,
    mode: 'auto',
    fireInterval: 4 / 60,
    burstCount: 1,
    burstInterval: 0,
    rangeStart: 10,
    rangeEnd: 28,
    minFalloff: 0.5,
    magSize: 32,
    reserve: 128,
    reloadTime: 1.8,
    equipTime: 0.4,
    moveMul: 1.05,
    recoil: { vertical: 0.0048, horizontal: 0.0075, hFreq: 0.8, maxHeat: 12, recoverDelay: 0.12, recoverRate: 20 },
    spread: { run: 0.016, air: 0.05 },
    visual: { body: 0x3b3b46, accent: 0xf7e04a, receiver: [0.3, 0.12, 0.06], barrel: 0.12, stock: 0.1, mag: [0.05, 0.2], scope: false, tracer: 0xfff3a0 },
    audio: { thump: 230, crack: 3200, decay: 0.09, gain: 0.6 },
  },
  {
    id: 'trident',
    name: 'Trident B3',
    role: 'Burst Rifle',
    specialty: 'Tight three-round bursts that reward a steady first shot',
    tradeoff: 'Long gap between bursts punishes mistimed pulls',
    damage: 27,
    headMult: 2.5,
    mode: 'burst',
    fireInterval: 0.38,
    burstCount: 3,
    burstInterval: 4 / 60,
    rangeStart: 35,
    rangeEnd: 65,
    minFalloff: 0.8,
    magSize: 27,
    reserve: 81,
    reloadTime: 2.2,
    equipTime: 0.55,
    moveMul: 0.95,
    recoil: { vertical: 0.0058, horizontal: 0.001, hFreq: 0.7, maxHeat: 3, recoverDelay: 0.1, recoverRate: 12 },
    spread: { run: 0.032, air: 0.075 },
    visual: { body: 0x36405c, accent: 0x6aa8ff, receiver: [0.4, 0.11, 0.06], barrel: 0.26, stock: 0.2, mag: [0.065, 0.15], scope: false, tracer: 0xa8d0ff },
    audio: { thump: 170, crack: 2200, decay: 0.12, gain: 0.75 },
  },
  {
    id: 'bulwark',
    name: 'Bulwark H7',
    role: 'Heavy Rifle',
    specialty: 'Huge damage per shot; wins trades it hits first',
    tradeoff: 'Slow to draw, move, fire and reload, with hard recoil',
    damage: 48,
    headMult: 2.2,
    mode: 'auto',
    fireInterval: 13 / 60,
    burstCount: 1,
    burstInterval: 0,
    rangeStart: 25,
    rangeEnd: 55,
    minFalloff: 0.75,
    magSize: 20,
    reserve: 60,
    reloadTime: 3.0,
    equipTime: 0.9,
    moveMul: 0.84,
    recoil: { vertical: 0.019, horizontal: 0.009, hFreq: 0.6, maxHeat: 6, recoverDelay: 0.3, recoverRate: 7 },
    spread: { run: 0.05, air: 0.11 },
    visual: { body: 0x4a4038, accent: 0xff6a4a, receiver: [0.5, 0.14, 0.075], barrel: 0.32, stock: 0.24, mag: [0.1, 0.16], scope: false, tracer: 0xffb090 },
    audio: { thump: 95, crack: 1200, decay: 0.26, gain: 1.0 },
  },
  {
    id: 'longshot',
    name: 'Longshot M1',
    role: 'Marksman Rifle',
    specialty: 'No damage falloff; two body shots or one head at any range',
    tradeoff: 'Five-round magazine and very slow follow-up shots',
    damage: 72,
    headMult: 2.5,
    mode: 'semi',
    fireInterval: 0.9,
    burstCount: 1,
    burstInterval: 0,
    rangeStart: 200,
    rangeEnd: 250,
    minFalloff: 1,
    magSize: 5,
    reserve: 20,
    reloadTime: 2.9,
    equipTime: 0.8,
    moveMul: 0.9,
    recoil: { vertical: 0.035, horizontal: 0, hFreq: 0, maxHeat: 1, recoverDelay: 0.25, recoverRate: 2.2 },
    spread: { run: 0.08, air: 0.14 },
    visual: { body: 0x2c2f3a, accent: 0xc77dff, receiver: [0.5, 0.1, 0.055], barrel: 0.48, stock: 0.3, mag: [0.06, 0.08], scope: true, tracer: 0xe0b8ff },
    audio: { thump: 110, crack: 1500, decay: 0.38, gain: 1.0 },
  },
];

export const WEAPON_COUNT = WEAPONS.length;

/** Deterministic vertical recoil offset (radians) for the current heat. */
export function recoilPitch(def: WeaponDef, heat: number): number {
  return def.recoil.vertical * heat;
}

/** Deterministic horizontal recoil offset (radians) for the current heat. */
export function recoilYaw(def: WeaponDef, heat: number): number {
  const ramp = heat < 2 ? heat * 0.5 : 1;
  return def.recoil.horizontal * Math.sin(heat * def.recoil.hFreq) * ramp;
}

/** Distance falloff multiplier. */
export function damageFalloff(def: WeaponDef, dist: number): number {
  if (dist <= def.rangeStart) return 1;
  if (dist >= def.rangeEnd) return def.minFalloff;
  const k = (dist - def.rangeStart) / (def.rangeEnd - def.rangeStart);
  return 1 + (def.minFalloff - 1) * k;
}
