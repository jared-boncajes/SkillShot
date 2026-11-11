import { describe, expect, it } from 'vitest';
import {
  BTN, DAMAGE_MULTIPLIERS, DT, EYE_HEIGHT, HITBOXES, MAPS, MAP_LIST, MOVE, PLAYER_RADIUS, WEAPONS,
  aimAt, collidesAt, computeDamage, createSimState, damageFalloff, movementSpread, raycastPlayer, raycastWorld,
  stepSim, type Cmd, type HitPart, type ShotEvent,
} from '../src';

const map = MAPS.foundry;
const cmd = (seq: number, buttons: number, yaw = 0, pitch = 0, weapon = 0): Cmd => ({ seq, buttons, yaw, pitch, weapon });

function aimPart(part: HitPart, dist = 6) {
  const h = HITBOXES.find((b) => b.part === part)!;
  const a = aimAt(0, EYE_HEIGHT, 0, h.cx, h.cy, -dist + h.cz);
  const cp = Math.cos(a.pitch);
  return raycastPlayer(0, EYE_HEIGHT, 0, -Math.sin(a.yaw) * cp, Math.sin(a.pitch), -Math.cos(a.yaw) * cp, 0, 0, -dist, 0, 100);
}

describe('hit detection and damage', () => {
  it('identifies each body part from where the ray lands', () => {
    for (const part of ['head', 'torso', 'arms', 'legs', 'feet'] as HitPart[]) {
      expect(aimPart(part)?.part).toBe(part);
    }
  });

  it('misses when aiming past the model', () => {
    expect(raycastPlayer(0, EYE_HEIGHT, 0, 0, 0, -1, 1.5, 0, -6, 0, 100)).toBeNull();
    expect(raycastPlayer(0, 2.2, 0, 0, 0, -1, 0, 0, -6, 0, 100)).toBeNull();
  });

  it('respects player yaw (hitboxes rotate with the model)', () => {
    // An arm sticks out sideways: visible at x=0.32 when facing us, not when the target is turned 90 degrees.
    expect(raycastPlayer(0.32, 1.15, 0, 0, 0, -1, 0, 0, -6, 0, 100)?.part).toBe('arms');
    expect(raycastPlayer(0.32, 1.15, 0, 0, 0, -1, 0, 0, -6, Math.PI / 2, 100)).toBeNull();
  });

  it('orders damage head > torso > arms > legs > feet for every weapon', () => {
    for (const w of WEAPONS) {
      const d = (p: HitPart) => computeDamage(w, p, 5);
      expect(d('head')).toBeGreaterThan(d('torso'));
      expect(d('torso')).toBeGreaterThan(d('arms'));
      expect(d('arms')).toBeGreaterThan(d('legs'));
      expect(d('legs')).toBeGreaterThan(d('feet'));
    }
  });

  it('uses the configured multipliers', () => {
    expect(DAMAGE_MULTIPLIERS).toEqual({ head: 2.5, torso: 1, arms: 0.9, legs: 0.75, feet: 0.6 });
    const w = WEAPONS[0];
    expect(computeDamage(w, 'torso', 5)).toBe(w.damage);
    expect(computeDamage(w, 'feet', 5)).toBe(Math.round(w.damage * 0.6));
    expect(computeDamage(w, 'head', 5)).toBe(Math.round(w.damage * w.headMult));
    expect(computeDamage(w, 'legs', 5, { ...DAMAGE_MULTIPLIERS, legs: 0.5 })).toBe(Math.round(w.damage * 0.5));
  });

  it('applies distance falloff', () => {
    const smg = WEAPONS.find((w) => w.id === 'wasp')!;
    expect(damageFalloff(smg, 5)).toBe(1);
    expect(damageFalloff(smg, 100)).toBe(smg.minFalloff);
    expect(computeDamage(smg, 'torso', 40)).toBeLessThan(computeDamage(smg, 'torso', 5));
    const marksman = WEAPONS.find((w) => w.id === 'longshot')!;
    expect(computeDamage(marksman, 'torso', 100)).toBe(marksman.damage);
  });

  it('walls stop bullets', () => {
    // Spawn divider wall sits at x = -22 between these two points.
    const t = raycastWorld(map, -24, EYE_HEIGHT, -10, 1, 0, 0, 100);
    expect(t).toBeGreaterThan(1.6);
    expect(t).toBeLessThan(1.8);
    // Open lane through the mid exit.
    expect(raycastWorld(map, -24, EYE_HEIGHT, 4, 1, 0, 0, 5)).toBe(5);
  });
});

describe('movement', () => {
  it('accelerates smoothly to run speed and stops with friction', () => {
    const s = createSimState(-27, 0, 0, 0);
    stepSim(s, cmd(1, BTN.FORWARD, -Math.PI / 2), map, null);
    expect(s.vx).toBeGreaterThan(0);
    expect(s.vx).toBeLessThan(MOVE.runSpeed);
    for (let i = 0; i < 30; i++) stepSim(s, cmd(i + 2, BTN.FORWARD, -Math.PI / 2), map, null);
    expect(s.vx).toBeCloseTo(MOVE.runSpeed * WEAPONS[0].moveMul, 5);
    for (let i = 0; i < 30; i++) stepSim(s, cmd(i + 40, 0, -Math.PI / 2), map, null);
    expect(Math.hypot(s.vx, s.vz)).toBe(0);
  });

  it('walking is slower than running, heavier weapons are slower', () => {
    const speed = (buttons: number, weapon: number) => {
      const s = createSimState(-27, 0, 0, weapon);
      for (let i = 0; i < 60; i++) stepSim(s, cmd(i + 1, buttons, 0, 0, weapon), map, null);
      return Math.hypot(s.vx, s.vz);
    };
    expect(speed(BTN.FORWARD | BTN.WALK, 0)).toBeLessThan(speed(BTN.FORWARD, 0) * 0.6);
    expect(speed(BTN.FORWARD, 4)).toBeLessThan(speed(BTN.FORWARD, 0));
    expect(speed(BTN.FORWARD, 2)).toBeGreaterThan(speed(BTN.FORWARD, 0));
  });

  it('cannot pass through walls', () => {
    const s = createSimState(-24, 0, -10, 0);
    for (let i = 0; i < 240; i++) stepSim(s, cmd(i + 1, BTN.FORWARD, -Math.PI / 2), map, null);
    expect(s.x).toBeLessThan(-22.3 - PLAYER_RADIUS + 0.001);
    expect(s.x).toBeGreaterThan(-22.3 - PLAYER_RADIUS - 0.01);
  });

  it('stays inside the map when running into every outer wall', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7, 2.3, -2.1]) {
      const s = createSimState(-27, 0, 0, 0);
      for (let i = 0; i < 1200; i++) stepSim(s, cmd(i + 1, BTN.FORWARD | (i % 50 === 0 ? BTN.JUMP : 0), yaw), map, null);
      expect(Math.abs(s.x)).toBeLessThan(map.halfX);
      expect(Math.abs(s.z)).toBeLessThan(map.halfZ);
      expect(s.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('jumps consistently, lands, and needs a fresh key press to jump again', () => {
    const s = createSimState(-27, 0, 0, 0);
    let peak = 0;
    let airTicks = 0;
    stepSim(s, cmd(1, BTN.JUMP), map, null);
    expect(s.onGround).toBe(false);
    for (let i = 0; i < 120 && !s.onGround; i++) {
      stepSim(s, cmd(i + 2, BTN.JUMP), map, null);
      peak = Math.max(peak, s.y);
      airTicks++;
    }
    expect(peak).toBeGreaterThan(0.8);
    expect(peak).toBeLessThan(1.0);
    expect(airTicks).toBeGreaterThan(25);
    expect(s.y).toBe(0);
    stepSim(s, cmd(200, BTN.JUMP), map, null); // still held -> no bunny hop
    expect(s.onGround).toBe(true);
    stepSim(s, cmd(201, 0), map, null);
    stepSim(s, cmd(202, BTN.JUMP), map, null);
    expect(s.onGround).toBe(false);
  });

  it('can stand on top of low crates', () => {
    // 0.8 m crate at x -13..-11.5, z 5..6.5
    const s = createSimState(-14, 0, 5.75, 0);
    stepSim(s, cmd(1, BTN.FORWARD | BTN.JUMP, -Math.PI / 2), map, null);
    for (let i = 0; i < 24; i++) stepSim(s, cmd(i + 2, BTN.FORWARD, -Math.PI / 2), map, null);
    for (let i = 0; i < 30; i++) stepSim(s, cmd(i + 50, 0, -Math.PI / 2), map, null);
    expect(s.y).toBeCloseTo(0.8, 5);
    expect(s.onGround).toBe(true);
  });

  it('is deterministic', () => {
    const run = () => {
      const s = createSimState(-27, 0, 0, 0);
      const shots: ShotEvent[] = [];
      for (let i = 0; i < 400; i++) {
        const buttons = (i % 90 < 60 ? BTN.FORWARD : BTN.LEFT) | (i % 70 === 0 ? BTN.JUMP : 0) | (i % 40 < 20 ? BTN.FIRE : 0);
        stepSim(s, cmd(i + 1, buttons, i * 0.01, Math.sin(i * 0.1) * 0.3, Math.floor(i / 100) % 6), map, shots);
      }
      return JSON.stringify([s, shots]);
    };
    expect(run()).toBe(run());
  });
});

describe('weapons', () => {
  const hold = (weapon: number, ticks: number, buttonsAt: (i: number) => number) => {
    const s = createSimState(-27, 0, 0, weapon);
    const shots: ShotEvent[] = [];
    const times: number[] = [];
    for (let i = 0; i < ticks; i++) {
      const before = shots.length;
      stepSim(s, cmd(i + 1, buttonsAt(i), 0, 0, weapon), map, shots);
      for (let k = before; k < shots.length; k++) times.push(i);
    }
    return { s, shots, times };
  };

  it('has six weapons with distinct stats', () => {
    expect(WEAPONS.length).toBe(6);
    for (const key of ['damage', 'fireInterval', 'magSize', 'reloadTime', 'rangeStart'] as const) {
      expect(new Set(WEAPONS.map((w) => w[key])).size).toBeGreaterThanOrEqual(5);
    }
    expect(new Set(WEAPONS.map((w) => w.name)).size).toBe(6);
  });

  it('each weapon fires at its own rate when the trigger is held for one second', () => {
    const counts = WEAPONS.map((_, i) => hold(i, 60, () => BTN.FIRE).shots.length);
    // rifle 10, precision 1 (semi), smg 15, burst 3 (one pull), heavy 5, marksman 1
    expect(counts).toEqual([10, 1, 15, 3, 5, 1]);
  });

  it('semi-auto needs a click per shot and respects its fire interval', () => {
    const { times } = hold(1, 120, (i) => (i % 4 < 2 ? BTN.FIRE : 0)); // spam clicking
    expect(times.length).toBeGreaterThan(3);
    for (let i = 1; i < times.length; i++) expect((times[i] - times[i - 1]) * DT).toBeGreaterThanOrEqual(WEAPONS[1].fireInterval - DT);
  });

  it('burst rifle fires exactly three rounds per pull with a delay between bursts', () => {
    const { times } = hold(3, 60, (i) => (i === 0 || i === 6 || i === 40 ? BTN.FIRE : 0));
    expect(times).toEqual([0, 4, 8, 40, 44, 48]);
  });

  it('tracks magazines and reserve, reloads on R and automatically when empty', () => {
    const w = WEAPONS[0];
    const a = hold(0, 20, (i) => (i < 13 ? BTN.FIRE : i === 15 ? BTN.RELOAD : 0));
    expect(a.s.mags[0]).toBe(w.magSize - 3);
    expect(a.s.reload).toBeGreaterThan(0);
    const b = hold(0, 20 + Math.ceil(w.reloadTime * 60) + 2, (i) => (i < 13 ? BTN.FIRE : i === 15 ? BTN.RELOAD : 0));
    expect(b.s.mags[0]).toBe(w.magSize);
    expect(b.s.reserves[0]).toBe(w.reserve - 3);
    // Marksman: 5 shots empty the magazine, then it reloads by itself; no firing while reloading.
    const m = hold(5, 400, (i) => (i % 2 === 0 ? BTN.FIRE : 0));
    expect(m.shots.length).toBe(5 + 1);
    expect(m.s.reserves[5]).toBe(WEAPONS[5].reserve - 5);
  });

  it('never fires with an empty magazine and no reserve', () => {
    const s = createSimState(-27, 0, 0, 0);
    s.mags[0] = 2;
    s.reserves[0] = 0;
    const shots: ShotEvent[] = [];
    for (let i = 0; i < 300; i++) stepSim(s, cmd(i + 1, BTN.FIRE), map, shots);
    expect(shots.length).toBe(2);
  });

  it('switching weapons applies the draw delay', () => {
    const s = createSimState(-27, 0, 0, 0);
    const shots: ShotEvent[] = [];
    stepSim(s, cmd(1, BTN.FIRE, 0, 0, 4), map, shots);
    expect(s.weapon).toBe(4);
    expect(shots.length).toBe(0);
    let first = -1;
    for (let i = 0; i < 120 && first < 0; i++) {
      stepSim(s, cmd(i + 2, BTN.FIRE, 0, 0, 4), map, shots);
      if (shots.length) first = i;
    }
    expect(first * DT).toBeGreaterThanOrEqual(WEAPONS[4].equipTime - 2 * DT);
  });

  it('first shot goes exactly where the crosshair points; recoil is a fixed, repeatable pattern', () => {
    const a = hold(0, 60, () => BTN.FIRE).shots;
    const b = hold(0, 60, () => BTN.FIRE).shots;
    expect(a[0].dx).toBeCloseTo(0, 12);
    expect(a[0].dy).toBeCloseTo(0, 12);
    expect(a[0].dz).toBeCloseTo(-1, 12);
    expect(a[5].dy).toBeGreaterThan(a[1].dy);
    expect(a).toEqual(b);
  });

  it('standing and walking are perfectly accurate; running and jumping are not', () => {
    const def = WEAPONS[0];
    const s = createSimState(-27, 0, 0, 0);
    expect(movementSpread(def, s)).toBe(0);
    for (let i = 0; i < 60; i++) stepSim(s, cmd(i + 1, BTN.FORWARD | BTN.WALK), map, null);
    expect(movementSpread(def, s)).toBe(0);
    for (let i = 0; i < 60; i++) stepSim(s, cmd(i + 100, BTN.FORWARD, Math.PI), map, null);
    expect(movementSpread(def, s)).toBeCloseTo(def.spread.run, 6);
    stepSim(s, cmd(300, BTN.JUMP), map, null);
    expect(movementSpread(def, s)).toBe(def.spread.air);
  });

  it('time-to-kill differs by weapon and by where you aim', () => {
    const ttk = (i: number, part: HitPart) => {
      const w = WEAPONS[i];
      const shots = Math.ceil(100 / computeDamage(w, part, 8));
      if (w.mode === 'burst') {
        const bursts = Math.ceil(shots / w.burstCount);
        return (bursts - 1) * (w.fireInterval + (w.burstCount - 1) * w.burstInterval) + ((shots - 1) % w.burstCount) * w.burstInterval;
      }
      return (shots - 1) * w.fireInterval;
    };
    const body = WEAPONS.map((_, i) => ttk(i, 'torso'));
    const head = WEAPONS.map((_, i) => ttk(i, 'head'));
    for (let i = 0; i < 6; i++) expect(head[i]).toBeLessThan(body[i]);
    // Precision and marksman rifles kill with one headshot; nothing kills with one body shot.
    expect(head[1]).toBe(0);
    expect(head[5]).toBe(0);
    for (const t of body) expect(t).toBeGreaterThan(0);
    // No weapon dominates: body TTKs stay inside a competitive band.
    expect(Math.max(...body) / Math.min(...body)).toBeLessThan(3.5);
  });
});

describe('maps', () => {
  it('every spawn point is clear of geometry and inside the map', () => {
    for (const m of MAP_LIST) {
      for (const team of ['red', 'blue'] as const) {
        expect(m.spawns[team].length).toBeGreaterThanOrEqual(5);
        for (const sp of m.spawns[team]) {
          expect(collidesAt(m, sp.x, 0, sp.z)).toBe(false);
          expect(Math.abs(sp.x)).toBeLessThan(m.halfX);
        }
      }
    }
  });

  it('is mirror-symmetric so neither team has a layout advantage', () => {
    for (const m of MAP_LIST) {
      const key = (b: { min: number[]; max: number[] }) => [...b.min, ...b.max].map((n) => n.toFixed(2)).join(',');
      const set = new Set(m.boxes.map(key));
      for (const b of m.boxes) {
        expect(set.has(key({ min: [-b.max[0], b.min[1], b.min[2]], max: [-b.min[0], b.max[1], b.max[2]] }))).toBe(true);
      }
    }
  });
});
