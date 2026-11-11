import {
  BTN, DT, EYE_HEIGHT, MAX_HEALTH, MAX_REWIND_MS, MAX_SHOT_RANGE, PF, SNAPSHOT_EVERY_TICKS, TICK_RATE, WEAPONS,
  collidesAt, computeDamage, createSimState, raycastPlayer, raycastWorld, stepSim,
  type Cmd, type CmdTuple, type HitPart, type MapDef, type MatchInfo, type MatchResult, type ModeDef,
  type RemoteTuple, type S2C, type ScoreRow, type ShotEvent, type SimState, type SpawnPoint, type Team,
} from '@aimstrike/shared';
import type { ServerConfig } from './config';

const TICK_MS = 1000 / TICK_RATE;
/** Commands a player may bank while their packets are delayed, then burn in one tick. */
const MAX_CMD_BUDGET = 12;
const MAX_QUEUE = 30;
/** Ticks without input before the server simulates idle commands (keeps gravity working for stalled clients). */
const IDLE_TICKS = 15;
const HISTORY_LEN = 40;

interface HistoryEntry {
  t: number;
  x: number; y: number; z: number;
  yaw: number;
  life: number;
}

export interface MatchPlayer {
  id: string;
  name: string;
  team: Team;
  connected: boolean;
  ping: number;
  sim: SimState;
  yaw: number;
  pitch: number;
  hp: number;
  alive: boolean;
  life: number;
  spawnYaw: number;
  respawnAt: number;
  protectedUntil: number;
  kills: number;
  deaths: number;
  shots: number;
  hits: number;
  headshots: number;
  queue: Cmd[];
  /** Client render time (server match clock) attached to each queued command, for lag compensation. */
  queueRt: number[];
  budget: number;
  idleTicks: number;
  lastSeq: number;
  lastQueuedSeq: number;
  history: HistoryEntry[];
  preferredWeapon: number;
}

export interface MatchHooks {
  send(id: string, msg: S2C | string): void;
  broadcast(msg: S2C, exceptId?: string): void;
  onEnd(result: MatchResult): void;
}

export interface MatchMemberInit {
  id: string;
  name: string;
  team: Team;
  weapon: number;
  connected: boolean;
  ping: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Authoritative match simulation. Clients only submit input commands; movement,
 * firing, hit detection, damage, eliminations, scores, timers and respawns are
 * all decided here.
 */
export class Match {
  readonly players = new Map<string, MatchPlayer>();
  phase: 'countdown' | 'live' | 'ended' = 'countdown';
  /** Match clock in ms. Advances by exactly one tick per simulation step. */
  now = 0;
  readonly liveAt: number;
  readonly endAt: number;
  readonly scores: [number, number] = [0, 0];
  readonly scoreLimit: number;
  private tickCount = 0;
  private acc = 0;
  private lastWall: number;
  private readonly respawnMs: number;
  private readonly protectionMs: number;
  private readonly shots: ShotEvent[] = [];
  private scoreDirty = false;
  private lastScoreSend = 0;

  constructor(
    readonly map: MapDef,
    readonly mode: ModeDef,
    private readonly cfg: ServerConfig,
    private readonly hooks: MatchHooks,
    members: MatchMemberInit[],
    wallNow: number,
  ) {
    this.lastWall = wallNow;
    this.liveAt = cfg.countdownMs;
    this.endAt = this.liveAt + (cfg.matchDurationSec ?? mode.durationSec) * 1000;
    this.scoreLimit = cfg.scoreLimit ?? mode.scoreLimit;
    this.respawnMs = cfg.respawnMs ?? mode.respawnMs;
    this.protectionMs = cfg.spawnProtectionMs ?? mode.spawnProtectionMs;
    for (const m of members) this.addPlayer(m);
  }

  info(): MatchInfo {
    return {
      mapId: this.map.id,
      modeId: this.mode.id,
      phase: this.phase === 'countdown' ? 'countdown' : 'live',
      startsInMs: Math.max(0, this.liveAt - this.now),
      remainingMs: Math.max(0, this.endAt - Math.max(this.now, this.liveAt)),
      scoreLimit: this.scoreLimit,
    };
  }

  addPlayer(m: MatchMemberInit): void {
    if (this.players.has(m.id)) return;
    const p: MatchPlayer = {
      id: m.id, name: m.name, team: m.team, connected: m.connected, ping: m.ping,
      sim: createSimState(0, 0, 0, m.weapon),
      yaw: 0, pitch: 0, hp: 0, alive: false, life: 0, spawnYaw: 0,
      respawnAt: Infinity, protectedUntil: 0,
      kills: 0, deaths: 0, shots: 0, hits: 0, headshots: 0,
      queue: [], queueRt: [], budget: 0, idleTicks: 0, lastSeq: 0, lastQueuedSeq: 0,
      history: [], preferredWeapon: m.weapon,
    };
    this.players.set(p.id, p);
    if (p.connected) {
      // Everyone present at kickoff spawns immediately; late joiners wait a moment.
      if (this.phase === 'countdown') this.spawn(p);
      else p.respawnAt = this.now + 1000;
    }
    this.scoreDirty = true;
  }

  removePlayer(id: string): void {
    if (this.players.delete(id)) this.scoreDirty = true;
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.players.get(id);
    if (!p || p.connected === connected) return;
    p.connected = connected;
    p.queue.length = 0;
    p.queueRt.length = 0;
    if (!connected) {
      p.alive = false;
      p.respawnAt = Infinity;
    } else {
      // The reconnected client restarts its command sequence from scratch.
      p.lastSeq = 0;
      p.lastQueuedSeq = 0;
      p.respawnAt = this.now + 1000;
    }
    this.scoreDirty = true;
  }

  setPing(id: string, ping: number): void {
    const p = this.players.get(id);
    if (p) p.ping = ping;
  }

  /** Accepts a batch of input commands from a client. Everything is validated before it touches the simulation. */
  queueInput(id: string, rt: number, tuples: CmdTuple[]): void {
    const p = this.players.get(id);
    if (!p || !p.connected) return;
    for (const c of tuples) {
      const seq = c[0];
      // Duplicate / replayed / out-of-order commands are ignored outright.
      if (seq <= p.lastQueuedSeq) continue;
      p.lastQueuedSeq = seq;
      if (this.phase !== 'live' || !p.alive) {
        // Not allowed to act right now: consume the command without simulating it.
        p.lastSeq = seq;
        continue;
      }
      if (p.queue.length >= MAX_QUEUE) {
        // Flooding (or a speed hack) - drop the oldest so time can never run faster than the server's.
        p.queue.shift();
        p.queueRt.shift();
      }
      p.queue.push({ seq, buttons: c[1], yaw: c[2], pitch: c[3], weapon: c[4] });
      p.queueRt.push(rt);
    }
  }

  /** Called on a wall-clock interval; runs however many fixed ticks have elapsed. */
  update(wallNow: number): void {
    this.acc += wallNow - this.lastWall;
    this.lastWall = wallNow;
    if (this.acc > 250) this.acc = 250;
    while (this.acc >= TICK_MS && this.phase !== 'ended') {
      this.acc -= TICK_MS;
      this.tick();
    }
  }

  /** Advances the match by one fixed simulation tick. */
  tick(): void {
    if (this.phase === 'ended') return;
    this.now += TICK_MS;
    this.tickCount++;

    if (this.phase === 'countdown' && this.now >= this.liveAt) {
      this.phase = 'live';
      for (const p of this.players.values()) {
        p.queue.length = 0;
        p.queueRt.length = 0;
        p.protectedUntil = this.now + this.protectionMs;
      }
      this.hooks.broadcast({ t: 'match', match: this.info() });
    }

    if (this.phase === 'live') {
      for (const p of this.players.values()) {
        if (!p.connected) continue;
        if (!p.alive) {
          if (this.now >= p.respawnAt) this.spawn(p);
          continue;
        }
        p.budget = Math.min(MAX_CMD_BUDGET, p.budget + 1);
        let processed = 0;
        while (p.queue.length > 0 && p.budget >= 1 && p.alive) {
          const cmd = p.queue.shift()!;
          const rt = p.queueRt.shift()!;
          p.budget--;
          processed++;
          this.runCommand(p, cmd, rt);
        }
        // A stale backlog only adds input latency for its owner; trim it (the client reconciles).
        while (p.queue.length > 8) {
          p.lastSeq = p.queue.shift()!.seq;
          p.queueRt.shift();
        }
        if (processed > 0) p.idleTicks = 0;
        else if (++p.idleTicks > IDLE_TICKS && p.alive) {
          this.runCommand(p, { seq: p.lastSeq, buttons: 0, yaw: p.yaw, pitch: p.pitch, weapon: p.sim.weapon }, this.now);
        }
      }
    }

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const h = p.history;
      const e = h.length >= HISTORY_LEN ? h.shift()! : ({} as HistoryEntry);
      e.t = this.now; e.x = p.sim.x; e.y = p.sim.y; e.z = p.sim.z; e.yaw = p.yaw; e.life = p.life;
      h.push(e);
    }

    if (this.phase === 'live') this.checkEnd();
    if ((this.phase as string) === 'ended') return;

    if (this.tickCount % SNAPSHOT_EVERY_TICKS === 0) this.sendSnapshots();
    if (this.scoreDirty || this.now - this.lastScoreSend > 2000) this.sendScores();
  }

  private runCommand(p: MatchPlayer, cmd: Cmd, rt: number): void {
    p.lastSeq = cmd.seq;
    p.yaw = cmd.yaw;
    p.pitch = cmd.pitch;
    this.shots.length = 0;
    stepSim(p.sim, cmd, this.map, this.shots);
    for (let i = 0; i < this.shots.length; i++) this.resolveShot(p, this.shots[i], rt);
  }

  private canDamage(a: MatchPlayer, b: MatchPlayer): boolean {
    return a !== b && (!this.mode.teamBased || a.team !== b.team);
  }

  /** Where a player was at match time `t`, interpolated from recorded history (lag compensation). */
  private rewind(p: MatchPlayer, t: number, out: { x: number; y: number; z: number; yaw: number }): void {
    out.x = p.sim.x; out.y = p.sim.y; out.z = p.sim.z; out.yaw = p.yaw;
    const h = p.history;
    for (let i = h.length - 1; i >= 0; i--) {
      const a = h[i];
      if (a.life !== p.life) break;
      if (a.t <= t) {
        const b = h[i + 1];
        if (b && b.life === p.life && b.t > a.t) {
          const k = (t - a.t) / (b.t - a.t);
          out.x = a.x + (b.x - a.x) * k;
          out.y = a.y + (b.y - a.y) * k;
          out.z = a.z + (b.z - a.z) * k;
          out.yaw = a.yaw;
        } else {
          out.x = a.x; out.y = a.y; out.z = a.z; out.yaw = a.yaw;
        }
        return;
      }
      out.x = a.x; out.y = a.y; out.z = a.z; out.yaw = a.yaw;
    }
  }

  private readonly rw = { x: 0, y: 0, z: 0, yaw: 0 };

  private resolveShot(shooter: MatchPlayer, shot: ShotEvent, rt: number): void {
    shooter.shots++;
    // Shooting gives up spawn protection.
    shooter.protectedUntil = 0;

    const { ox, oy, oz, dx, dy, dz } = shot;
    const wallT = raycastWorld(this.map, ox, oy, oz, dx, dy, dz, MAX_SHOT_RANGE);

    // Limited lag compensation: test against where targets were when the shooter saw them,
    // but never more than MAX_REWIND_MS in the past and never in the future.
    const t = Math.min(this.now, Math.max(this.now - MAX_REWIND_MS, rt));

    let bestT = wallT;
    let victim: MatchPlayer | null = null;
    let part: HitPart = 'torso';
    for (const q of this.players.values()) {
      if (!q.alive || !this.canDamage(shooter, q)) continue;
      this.rewind(q, t, this.rw);
      const hit = raycastPlayer(ox, oy, oz, dx, dy, dz, this.rw.x, this.rw.y, this.rw.z, this.rw.yaw, bestT);
      if (hit) {
        bestT = hit.t;
        victim = q;
        part = hit.part;
      }
    }

    this.hooks.broadcast(
      { t: 'shot', id: shooter.id, w: shot.weapon, o: [r2(ox), r2(oy), r2(oz)], e: [r2(ox + dx * bestT), r2(oy + dy * bestT), r2(oz + dz * bestT)] },
      shooter.id,
    );

    if (!victim || this.now < victim.protectedUntil) return;

    const dmg = computeDamage(WEAPONS[shot.weapon], part, bestT, this.cfg.damageMultipliers);
    if (dmg <= 0) return;
    shooter.hits++;
    if (part === 'head') shooter.headshots++;
    victim.hp = Math.max(0, victim.hp - dmg);
    const killed = victim.hp <= 0;
    this.hooks.send(shooter.id, { t: 'hit', victim: victim.id, part, dmg, killed });
    this.hooks.send(victim.id, { t: 'dmg', from: shooter.id, dmg, ax: r2(shooter.sim.x), az: r2(shooter.sim.z) });
    if (killed) this.eliminate(victim, shooter, shot.weapon, part === 'head');
    this.scoreDirty = true;
  }

  private eliminate(victim: MatchPlayer, killer: MatchPlayer, weapon: number, head: boolean): void {
    victim.alive = false;
    victim.deaths++;
    victim.respawnAt = this.now + this.respawnMs;
    // Any commands still queued were issued while alive; consume them so the client's ack stays in step.
    if (victim.queue.length > 0) victim.lastSeq = victim.queue[victim.queue.length - 1].seq;
    victim.queue.length = 0;
    victim.queueRt.length = 0;
    killer.kills++;
    if (this.mode.teamBased) this.scores[killer.team === 'red' ? 0 : 1]++;
    this.hooks.broadcast({ t: 'kill', killer: killer.id, victim: victim.id, weapon, head });
  }

  private pickSpawn(p: MatchPlayer): SpawnPoint {
    const pool = this.mode.teamBased ? this.map.spawns[p.team] : [...this.map.spawns.red, ...this.map.spawns.blue];
    let best = pool[0];
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      let nearestEnemy = 60;
      let blocked = false;
      for (const q of this.players.values()) {
        if (q === p || !q.alive) continue;
        const d = Math.hypot(q.sim.x - s.x, q.sim.z - s.z);
        if (d < 1.2) blocked = true;
        if (this.canDamage(p, q) && d < nearestEnemy) nearestEnemy = d;
      }
      if (collidesAt(this.map, s.x, 0, s.z)) blocked = true;
      // Deterministic tie-breaker spreads players across equally good spawns.
      const score = (blocked ? -1000 : 0) + nearestEnemy + ((p.life * 7 + i * 3) % 5) * 0.01;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  private spawn(p: MatchPlayer): void {
    const s = this.pickSpawn(p);
    p.sim = createSimState(s.x, 0, s.z, p.sim.weapon ?? p.preferredWeapon);
    p.yaw = s.yaw;
    p.spawnYaw = s.yaw;
    p.pitch = 0;
    p.hp = MAX_HEALTH;
    p.alive = true;
    p.life++;
    p.respawnAt = Infinity;
    p.protectedUntil = this.now + this.protectionMs;
    p.queue.length = 0;
    p.queueRt.length = 0;
    p.idleTicks = 0;
    p.budget = 0;
    p.history.length = 0;
  }

  private checkEnd(): void {
    let reason: 'score' | 'time' | null = null;
    let top: MatchPlayer | null = null;
    let topTie = false;
    for (const p of this.players.values()) {
      if (!top || p.kills > top.kills) { top = p; topTie = false; }
      else if (p.kills === top.kills) topTie = true;
    }
    if (this.mode.teamBased) {
      if (this.scores[0] >= this.scoreLimit || this.scores[1] >= this.scoreLimit) reason = 'score';
    } else if (top && top.kills >= this.scoreLimit) reason = 'score';
    if (!reason && this.now >= this.endAt) reason = 'time';
    if (!reason) return;

    let winner: string = 'tie';
    let winnerName = 'Draw';
    if (this.mode.teamBased) {
      if (this.scores[0] > this.scores[1]) { winner = 'red'; winnerName = 'Red Team'; }
      else if (this.scores[1] > this.scores[0]) { winner = 'blue'; winnerName = 'Blue Team'; }
    } else if (top && !topTie && top.kills > 0) {
      winner = top.id;
      winnerName = top.name;
    }
    this.phase = 'ended';
    this.hooks.onEnd({
      winner, winnerName, reason,
      scores: [this.scores[0], this.scores[1]],
      rows: this.rows(),
      returnInMs: this.cfg.resultsMs,
    });
  }

  rows(): ScoreRow[] {
    const rows: ScoreRow[] = [];
    for (const p of this.players.values()) {
      rows.push({
        id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths,
        hsPct: p.hits > 0 ? Math.round((p.headshots / p.hits) * 100) : 0,
        accPct: p.shots > 0 ? Math.round((p.hits / p.shots) * 100) : 0,
        ping: p.ping, connected: p.connected,
      });
    }
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    return rows;
  }

  private sendScores(): void {
    this.scoreDirty = false;
    this.lastScoreSend = this.now;
    this.hooks.broadcast({ t: 'score', sc: [this.scores[0], this.scores[1]], rows: this.rows() });
  }

  private sendSnapshots(): void {
    const remotes: RemoteTuple[] = [];
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      let flags = 0;
      if (p.alive) flags |= PF.ALIVE;
      if (p.alive && this.now < p.protectedUntil) flags |= PF.PROTECTED;
      if (p.sim.onGround) flags |= PF.GROUND;
      if (p.sim.reload > 0) flags |= PF.RELOADING;
      remotes.push([p.id, r3(p.sim.x), r3(p.sim.y), r3(p.sim.z), r3(p.yaw), r3(p.pitch), flags, p.sim.weapon]);
    }
    // The shared tail is serialised once and spliced into every client's message.
    const left = Math.max(0, Math.round(this.endAt - Math.max(this.now, this.liveAt)));
    const tail = `,"left":${left},"sc":[${this.scores[0]},${this.scores[1]}],"p":${JSON.stringify(remotes)}}`;
    const st = r2(this.now);
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      const respawnIn = p.alive || p.respawnAt === Infinity ? 0 : Math.max(0, Math.round(p.respawnAt - this.now));
      this.hooks.send(
        p.id,
        `{"t":"s","st":${st},"ack":${p.lastSeq},"me":${JSON.stringify(p.sim)},"hp":${p.hp},"alive":${p.alive},` +
          `"respawnIn":${respawnIn},"life":${p.life},"yaw":${p.spawnYaw}${tail}`,
      );
    }
  }
}

export { BTN, DT, EYE_HEIGHT };
