import { afterEach, describe, expect, it } from 'vitest';
import {
  BTN, MAPS, MAX_HEALTH, PF, WEAPONS, computeDamage, createSimState, stepSim,
} from '@aimstrike/shared';
import type { GameServer } from '../src/GameServer';
import type { MatchPlayer } from '../src/Match';
import { TestClient, partCentre, sleep, startMatch, startServer } from './helpers';

let server: GameServer | null = null;
afterEach(async () => { await server?.close(); server = null; });

async function setup(overrides = {}, names = ['Ana', 'Ben'], settings = {}) {
  const s = await startServer(overrides);
  server = s.server;
  const clients = await startMatch(s.port, names, settings);
  const room = [...s.server.rooms.values()][0];
  const match = room.match!;
  const player = (c: TestClient) => match.players.get(c.id)!;
  /** Test-only: place a player. Everything after this goes through the real network path. */
  const place = (c: TestClient, x: number, z: number, weapon = 0) => {
    const p = player(c);
    p.sim = createSimState(x, 0, z, weapon);
    p.yaw = 0;
    p.history.length = 0;
    return p;
  };
  return { ...s, clients, room, match, player, place };
}

const pos = (p: MatchPlayer) => ({ x: p.sim.x, y: p.sim.y, z: p.sim.z });

describe('match start', () => {
  it('spawns everyone at valid team spawn points and starts simultaneously', async () => {
    const { clients, match } = await setup({}, ['Ana', 'Ben', 'Cy', 'Di']);
    const map = MAPS.foundry;
    for (const c of clients) {
      const p = match.players.get(c.id)!;
      expect(p.alive).toBe(true);
      expect(p.hp).toBe(MAX_HEALTH);
      expect(map.spawns[p.team].some((s) => s.x === p.sim.x && s.z === p.sim.z)).toBe(true);
      expect(c.all('match').map((m) => m.match.phase)).toEqual(['countdown', 'live']);
    }
    const spots = new Set([...match.players.values()].map((p) => `${p.sim.x},${p.sim.z}`));
    expect(spots.size).toBe(4);
    expect([...match.players.values()].filter((p) => p.team === 'red').length).toBe(2);
  });

  it('ignores input during the countdown', async () => {
    const s = await startServer({ countdownMs: 600 });
    server = s.server;
    const a = await new TestClient(s.port).connect('Ana');
    a.send({ t: 'create' });
    const code = (await a.wait('lobby')).lobby.code;
    const b = await new TestClient(s.port).connect('Ben');
    b.send({ t: 'join', code });
    await b.wait('lobby');
    b.send({ t: 'ready', ready: true });
    await a.wait('lobby', (m) => m.lobby.members[1]?.ready);
    a.send({ t: 'start' });
    const info = await a.wait('match');
    expect(info.match.phase).toBe('countdown');
    expect(info.match.startsInMs).toBeGreaterThan(400);
    await a.wait('s');
    const x0 = a.snap!.me.x;
    await a.input(12, BTN.FORWARD | BTN.FIRE, -Math.PI / 2);
    await a.wait('s');
    expect(a.snap!.me.x).toBe(x0);
    expect(a.snap!.me.mags[0]).toBe(WEAPONS[0].magSize);
    expect(a.snap!.ack).toBe(12);
  });
});

describe('movement sync', () => {
  it('moves players server-side, shows them to others, and matches client prediction exactly', async () => {
    const { clients: [a, b], player } = await setup();
    const start = { ...player(a).sim, mags: [...player(a).sim.mags], reserves: [...player(a).sim.reserves] };
    const startX = b.snap!.p.find((r) => r[0] === a.id)![1];

    const sent = await a.input(40, (i) => BTN.FORWARD | (i === 10 ? BTN.JUMP : 0), -Math.PI / 2);
    await a.wait('s', (m) => m.ack === 40);

    // Client-side prediction: the same commands through the shared simulation give the server's answer bit-for-bit.
    const predicted = start;
    const x0 = start.x;
    for (const c of sent) stepSim(predicted, { seq: c[0], buttons: c[1], yaw: c[2], pitch: c[3], weapon: c[4] }, MAPS.foundry, null);
    expect(a.snap!.me).toEqual(predicted);
    expect(predicted.x - x0).toBeGreaterThan(2);

    // The other player sees the movement.
    await b.wait('s', (m) => Math.abs(m.p.find((r) => r[0] === a.id)![1] - startX) > 2);
    const seen = b.snap!.p.find((r) => r[0] === a.id)!;
    expect(seen[1]).toBeCloseTo(a.snap!.me.x, 1);
    expect(seen[4]).toBeCloseTo(-Math.PI / 2, 2);
    expect(seen[6] & PF.ALIVE).toBeTruthy();
  });

  it('cannot be sped up by flooding commands, and ignores replayed commands', async () => {
    const { clients: [a], player } = await setup();
    const x0 = player(a).sim.x;
    // 300 commands (5 seconds of movement) sent in ~150 ms.
    for (let k = 0; k < 30; k++) {
      const c: Array<[number, number, number, number, number]> = [];
      for (let i = 0; i < 10; i++) c.push([++a.seq, BTN.FORWARD, -Math.PI / 2, 0, 0]);
      a.send({ t: 'i', rt: 0, c });
      await sleep(5);
    }
    await sleep(300);
    const moved = Math.abs(player(a).sim.x - x0);
    expect(moved).toBeGreaterThan(0.5);
    expect(moved).toBeLessThan(5.4 * 1.2); // nowhere near the 25+ m the flood asked for

    // Replaying an old fire command must not fire again.
    const p = player(a);
    const before = p.sim.mags[0];
    a.send({ t: 'i', rt: 0, c: [[5, BTN.FIRE, 0, 0, 0], [5, BTN.FIRE, 0, 0, 0]] });
    await sleep(100);
    expect(p.sim.mags[0]).toBe(before);
  });
});

describe('shooting', () => {
  it('headshots > torso > feet, with consistent health for shooter and victim', async () => {
    const { clients: [a, b], place, player } = await setup();
    const w = WEAPONS[0];
    const shooter = place(a, -29, 0);
    const target = place(b, -29, -6);
    await sleep(120);

    const results: Record<string, number> = {};
    for (const part of ['feet', 'torso', 'head'] as const) {
      const hit = a.wait('hit');
      const hurt = b.wait('dmg');
      await a.shootAt(pos(shooter), partCentre(part, -29, -6), 0);
      const h = await hit.catch((e) => { throw new Error(`${part}: ${e.message} shots=${shooter.shots} hp=${target.hp}`); });
      expect(h.part).toBe(part);
      expect(h.victim).toBe(b.id);
      expect(h.dmg).toBe(computeDamage(w, part, 6));
      expect((await hurt).from).toBe(a.id);
      results[part] = h.dmg;
      await sleep(250); // let recoil settle so the next shot is on the crosshair
    }
    expect(results.head).toBeGreaterThan(results.torso);
    expect(results.torso).toBeGreaterThan(results.feet);
    expect(results).toEqual({ feet: 18, torso: 30, head: 75 });

    // feet 18 + torso 30 + head 75 = 123 -> eliminated on the third shot.
    expect(player(b).deaths).toBe(1);
    expect(player(a).kills).toBe(1);
    const kill = b.all('kill')[0];
    expect(kill).toMatchObject({ killer: a.id, victim: b.id, head: true, weapon: 0 });
  });

  it('victim and shooter both see the same health after damage', async () => {
    const { clients: [a, b], place } = await setup();
    const shooter = place(a, -29, 0);
    place(b, -29, -6);
    await sleep(120);
    await a.shootAt(pos(shooter), partCentre('torso', -29, -6), 0);
    await b.wait('s', (m) => m.hp === 70);
    expect(b.snap!.alive).toBe(true);
    expect(a.all('hit')).toHaveLength(1);
  });

  it('walls block shots', async () => {
    const { clients: [a, b], place, player } = await setup();
    // The spawn divider wall (x = -22) stands between them.
    const shooter = place(a, -24, -10);
    place(b, -20, -10);
    await sleep(120);
    const shotSeen = b.wait('shot');
    await a.shootAt(pos(shooter), partCentre('torso', -20, -10), 0);
    const shot = await shotSeen;
    await sleep(150);
    expect(a.all('hit')).toHaveLength(0);
    expect(player(b).hp).toBe(MAX_HEALTH);
    expect(player(a).shots).toBe(1);
    // The tracer everyone else sees ends at the wall, not at the target.
    expect(shot.e[0]).toBeCloseTo(-22.3, 1);
  });

  it('teammates cannot damage each other; enemies behind them can still be hit', async () => {
    const { clients, place, player, match } = await setup({}, ['Ana', 'Ben', 'Cy']);
    const [a] = clients;
    const mate = clients.find((c) => c !== a && player(c).team === player(a).team)!;
    const foe = clients.find((c) => player(c).team !== player(a).team)!;
    const shooter = place(a, -29, 0);
    place(mate, -29, -4);
    place(foe, -29, -8);
    await sleep(120);
    const hit = a.wait('hit');
    await a.shootAt(pos(shooter), partCentre('torso', -29, -8), 0);
    expect((await hit).victim).toBe(foe.id);
    expect(player(mate).hp).toBe(MAX_HEALTH);
    expect(match.mode.teamBased).toBe(true);
  });

  it('spawn protection prevents instant eliminations', async () => {
    const { clients: [a, b], place, player } = await setup({ spawnProtectionMs: 5000 });
    const shooter = place(a, -29, 0, 5);
    place(b, -29, -6);
    await sleep(120);
    expect(b.snap!.p.find((r) => r[0] === b.id)![6] & PF.PROTECTED).toBeTruthy();
    await a.shootAt(pos(shooter), partCentre('head', -29, -6), 5);
    await sleep(150);
    expect(player(b).hp).toBe(MAX_HEALTH);
    // Shooting forfeits your own protection.
    expect(player(a).protectedUntil).toBe(0);
  });

  it('lag compensation: hits a moving target where the shooter saw it, within the rewind limit', async () => {
    const { clients: [a, b], place, player, match } = await setup();
    const shooter = place(a, -29, 0);
    const target = place(b, -29, -6);
    await sleep(150);
    const seenAt = a.snap!.st;
    // The target then sidesteps 3 m; the shooter's view (rt = seenAt) still has it at the old spot.
    target.sim.x = -26;
    await sleep(60);
    const cmd = (rt: number) => a.send({ t: 'i', rt, c: [[++a.seq, BTN.FIRE, 0, -0.077, 0], [++a.seq, 0, 0, -0.077, 0]] });
    const hit = a.wait('hit');
    cmd(seenAt);
    expect((await hit).victim).toBe(b.id);
    // A stale/forged timestamp far in the past is clamped and misses.
    await sleep(400);
    const before = player(b).hp;
    cmd(match.now - 5000);
    await sleep(150);
    expect(player(b).hp).toBe(before);
    expect(shooter.shots).toBe(2);
  });

  it('each weapon behaves differently over the network', async () => {
    const { clients: [a, b], place, player } = await setup();
    const perWeapon: number[] = [];
    const dmgPerWeapon: number[] = [];
    for (let w = 0; w < WEAPONS.length; w++) {
      const shooter = place(a, -29, 0, w);
      const target = place(b, -29, -6);
      target.hp = 100000; // soak damage for the measurement
      await sleep(120);
      const shotsBefore = shooter.shots;
      a.log.length = 0;
      const [, , tz] = partCentre('torso', -29, -6);
      await a.input(30, BTN.FIRE, 0, Math.atan2(0.9 - 1.62, -tz), w); // hold the trigger for half a second, aiming low torso
      await a.input(2, 0, 0, 0, w);
      await sleep(80);
      perWeapon.push(shooter.shots - shotsBefore);
      dmgPerWeapon.push(a.all('hit')[0].dmg);
      expect(player(a).sim.mags[w]).toBe(WEAPONS[w].magSize - perWeapon[w]);
    }
    expect(perWeapon).toEqual([5, 1, 8, 3, 3, 1]);
    expect(dmgPerWeapon).toEqual(WEAPONS.map((w) => w.damage));
    expect(new Set(dmgPerWeapon).size).toBe(6);
  });
});

describe('eliminations, respawn and match flow', () => {
  it('eliminated players respawn with full health at a spawn point; scores are consistent for everyone', async () => {
    const { clients: [a, b], place, player } = await setup({ respawnMs: 1500 });
    const shooter = place(a, -29, 0, 5);
    place(b, -29, -6);
    await sleep(120);
    const lifeBefore = player(b).life;
    await a.shootAt(pos(shooter), partCentre('head', -29, -6), 5);
    await b.wait('s', (m) => !m.alive);
    expect(b.snap!.respawnIn).toBeGreaterThan(0);
    // Dead players cannot act.
    await b.input(5, BTN.FIRE | BTN.FORWARD);
    expect(player(b).shots).toBe(0);

    const redIdx = player(a).team === 'red' ? 0 : 1;
    await a.wait('s', (m) => m.sc[redIdx] === 1);
    await b.wait('s', (m) => m.sc[redIdx] === 1);
    const scoreMsg = await b.wait('score', (m) => m.rows.some((r) => r.kills === 1));
    const rowA = scoreMsg.rows.find((r) => r.id === a.id)!;
    expect(rowA).toMatchObject({ kills: 1, deaths: 0, hsPct: 100, accPct: 100 });
    expect(scoreMsg.rows.find((r) => r.id === b.id)).toMatchObject({ kills: 0, deaths: 1 });

    await b.wait('s', (m) => m.alive);
    const p = player(b);
    expect(b.snap!.hp).toBe(MAX_HEALTH);
    expect(p.life).toBe(lifeBefore + 1);
    expect(MAPS.foundry.spawns[p.team].some((s) => s.x === p.sim.x && s.z === p.sim.z)).toBe(true);
    expect(b.snap!.me.mags).toEqual(WEAPONS.map((w) => w.magSize));
  });

  it('ends at the score limit, returns everyone to the same lobby, and can start again', async () => {
    const { clients: [a, b], place, player, room } = await setup({ scoreLimit: 2, respawnMs: 150 });
    const end = Promise.all([a.wait('end'), b.wait('end')]);
    for (let k = 0; k < 2; k++) {
      const shooter = place(a, -29, 0, 5);
      const target = place(b, -29, -6);
      target.alive = true; target.hp = MAX_HEALTH;
      await sleep(120);
      await a.shootAt(pos(shooter), partCentre('head', -29, -6), 5);
      if (k === 0) await b.wait('s', (m) => !m.alive).then(() => b.wait('s', (m) => m.alive));
    }
    const [ea, eb] = await end;
    const winnerTeam = player(a)?.team ?? a.lobby!.members.find((m) => m.id === a.id)!.team;
    expect(ea.result).toEqual(eb.result);
    expect(ea.result.reason).toBe('score');
    expect(ea.result.winner).toBe(winnerTeam);
    expect(Math.max(...ea.result.scores)).toBe(2);
    expect(ea.result.rows.find((r) => r.id === a.id)!.kills).toBe(2);

    // Same lobby, same code, same members, ready flags cleared.
    const back = await b.wait('lobby', (m) => m.lobby.phase === 'lobby');
    expect(back.lobby.code).toBe(room.code);
    expect(back.lobby.members.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(back.lobby.members.every((m) => !m.ready)).toBe(true);

    // And another match can be started without anyone reconnecting.
    b.send({ t: 'ready', ready: true });
    await a.wait('lobby', (m) => m.lobby.members.some((x) => x.ready));
    const again = Promise.all([a, b].map((c) => c.wait('match', (m) => m.match.phase === 'live')));
    a.send({ t: 'start' });
    await again;
    await a.wait('s', (m) => m.sc[0] === 0 && m.sc[1] === 0 && m.alive);
    expect(room.match!.players.get(a.id)!.kills).toBe(0);
  });

  it('ends when time expires; the leading team wins, equal scores tie', async () => {
    const tie = await setup({ matchDurationSec: 0.4 });
    const res = (await tie.clients[1].wait('end')).result;
    expect(res.reason).toBe('time');
    expect(res.winner).toBe('tie');
    await server!.close();

    const lead = await setup({ matchDurationSec: 1.2 });
    const [a, b] = lead.clients;
    const shooter = lead.place(a, -29, 0, 5);
    lead.place(b, -29, -6);
    await sleep(120);
    await a.shootAt(pos(shooter), partCentre('head', -29, -6), 5);
    const res2 = (await b.wait('end')).result;
    expect(res2.reason).toBe('time');
    expect(res2.winner).toBe(lead.player(a).team);
  });

  it('free-for-all: everyone can damage everyone and the top fragger wins', async () => {
    const { clients: [a, b], place, match } = await setup({ scoreLimit: 1 }, ['Ana', 'Ben'], { modeId: 'ffa' });
    expect(match.mode.id).toBe('ffa');
    const shooter = place(a, -29, 0, 5);
    place(b, -29, -6);
    await sleep(120);
    const end = b.wait('end');
    await a.shootAt(pos(shooter), partCentre('head', -29, -6), 5);
    const res = (await end).result;
    expect(res.winner).toBe(a.id);
    expect(res.winnerName).toBe('Ana');
  });
});

describe('disconnects', () => {
  it('a player dropping mid-match does not disturb the match; they can reconnect into it', async () => {
    const { clients: [a, b], port, match, player } = await setup({ reconnectGraceMs: 3000 });
    const bId = b.id;
    const token = b.token;
    b.ws.terminate();
    await a.wait('lobby', (m) => m.lobby.members.find((x) => x.id === bId)?.connected === false);
    const n = a.snapCount;
    await a.input(20, BTN.FORWARD, -Math.PI / 2);
    await sleep(100);
    expect(a.snapCount).toBeGreaterThan(n + 3);
    expect(match.phase).toBe('live');
    expect(a.snap!.p.some((r) => r[0] === bId)).toBe(false);
    expect(player(a).alive).toBe(true);

    const b2 = await new TestClient(port).connect('Ben', token);
    expect(b2.resumed).toBe(true);
    expect(b2.id).toBe(bId);
    const info = b2.all('match')[0] ?? (await b2.wait('match'));
    expect(info.match.phase).toBe('live');
    await b2.wait('s', (m) => m.alive);
    await a.wait('s', (m) => m.p.some((r) => r[0] === bId && (r[6] & PF.ALIVE) !== 0));
    // The resumed client can play again from a fresh command sequence.
    const x0 = b2.snap!.me.x;
    await b2.input(15, BTN.FORWARD, b2.snap!.yaw);
    await b2.wait('s', (m) => m.ack === 15);
    expect(b2.snap!.me.x).not.toBe(x0);
  });

  it('a late joiner is dropped into the running match', async () => {
    const { clients: [a], port, room } = await setup({}, ['Ana', 'Ben', 'Cy']);
    const d = await new TestClient(port).connect('Di');
    d.send({ t: 'join', code: room.code });
    const info = await d.wait('match');
    expect(info.match.phase).toBe('live');
    await d.wait('s', (m) => m.alive, 3000);
    await a.wait('s', (m) => m.p.length === 4);
  });
});
