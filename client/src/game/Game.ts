import * as THREE from 'three';
import {
  BTN, DT, EYE_HEIGHT, INTERP_DELAY_MS, MAPS, MAX_PITCH, MAX_SHOT_RANGE, MODES, MOVE, PF, WEAPONS, WEAPON_COUNT,
  copySimState, createSimState, lerpAngle, movementSpread, raycastPlayer, raycastWorld, recoilPitch, recoilYaw,
  stepSim, wrapAngle,
  type Cmd, type CmdTuple, type MapDef, type MatchInfo, type ModeDef, type S2C, type ShotEvent, type SimState,
  type SnapshotMsg, type Team,
} from '@aimstrike/shared';
import { net } from '../net/Connection';
import type { Settings } from '../settings';
import { nextN, useStore } from '../store';
import { audio } from './Audio';
import { Effects } from './Effects';
import { Input } from './Input';
import { PlayerModel, teamColor } from './PlayerModel';
import { ViewModel } from './ViewModel';
import { World } from './World';

interface Sample {
  t: number;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  flags: number;
  weapon: number;
}

interface Remote {
  id: string;
  name: string;
  team: Team;
  model: PlayerModel;
  buf: Sample[];
  /** Currently rendered (interpolated) state. */
  x: number; y: number; z: number; yaw: number; pitch: number;
  alive: boolean;
  shown: boolean;
  lastSeen: number;
  stepDist: number;
}

const MAX_PENDING = 90;
const MAX_TICKS_PER_FRAME = 10;
const DEG = Math.PI / 180;

/**
 * The client side of a match: collects input, predicts the local player with
 * the shared simulation, reconciles against server snapshots, interpolates
 * everyone else, and renders. It never decides hits, damage or scores.
 */
export class Game {
  readonly input: Input;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 400);
  private readonly world: World;
  private readonly effects: Effects;
  private readonly view = new ViewModel();
  private readonly map: MapDef;
  private readonly mode: ModeDef;
  private readonly remotes = new Map<string, Remote>();

  // Local prediction state
  private readonly sim: SimState = createSimState(0, 0, 0, 0);
  private pending: Cmd[] = [];
  private outgoing: CmdTuple[] = [];
  private readonly shots: ShotEvent[] = [];
  private seq = 0;
  private yaw = 0;
  private pitch = 0;
  private wantWeapon = 0;
  private alive = false;
  private live: boolean;
  private life = -1;
  private gotSnapshot = false;
  private prevX = 0; private prevY = 0; private prevZ = 0;
  /** Decaying offset that hides small reconciliation corrections instead of snapping the camera. */
  private errX = 0; private errY = 0; private errZ = 0;
  private recP = 0; private recY = 0;
  private stepDist = 0;
  private lastFireHeld = false;
  private selfProtected = false;

  // Clock
  private clockOffset: number | null = null;
  private renderTime = 0;
  private acc = 0;
  private lastFrame = 0;
  private raf = 0;
  private disposed = false;

  // HUD caching
  private fpsFrames = 0;
  private fpsLast = 0;
  private lastSpreadPx = -1;
  private frameDx = 0;
  private frameDy = 0;
  private settings: Settings;
  private readonly unsub: () => void;
  private readonly onResize = () => this.resize();

  constructor(private readonly canvas: HTMLCanvasElement, info: MatchInfo, private readonly myId: string) {
    this.map = MAPS[info.mapId] ?? MAPS.foundry;
    this.mode = MODES[info.modeId] ?? MODES.tdm;
    this.live = info.phase === 'live';
    this.settings = useStore.getState().settings;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.settings.quality !== 'low', powerPreference: 'high-performance' });
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.camera.rotation.order = 'YXZ';
    this.world = new World(this.scene, this.map);
    this.effects = new Effects(this.scene);

    this.input = new Input(canvas, {
      onLockChange: (locked) => {
        const s = useStore.getState();
        if (locked) s.set({ paused: false, pauseTab: 'main' });
        else if (!this.input.forceActive) s.set({ paused: true });
      },
      onScoreboard: (show) => useStore.getState().set({ scoreboard: show }),
      onWeapon: (slot, relative) => {
        this.wantWeapon = relative ? (this.wantWeapon + slot + WEAPON_COUNT) % WEAPON_COUNT : slot;
      },
    });

    this.applySettings(this.settings);
    this.unsub = useStore.subscribe((s) => {
      if (s.settings !== this.settings) this.applySettings(s.settings);
    });
    window.addEventListener('resize', this.onResize);
    this.resize();

    net.gameSink = (msg) => this.handle(msg);
    useStore.getState().set({ paused: true, pauseTab: 'main', scoreboard: false, loading: true });
    this.lastFrame = performance.now();
    this.fpsLast = this.lastFrame;
    this.raf = requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------------ setup

  private applySettings(s: Settings): void {
    this.settings = s;
    const cap = s.quality === 'low' ? 1 : s.quality === 'medium' ? 1.5 : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap) * s.resScale);
    this.world.applyQuality(this.renderer, s.quality);
    audio.setVolumes(s.master, s.sfx, s.music);
    this.resize();
  }

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    // The setting is horizontal FOV at 16:9; keep the vertical FOV fixed across aspect ratios (Hor+).
    this.camera.fov = (2 * Math.atan(Math.tan((this.settings.fov * DEG) / 2) * (9 / 16))) / DEG;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.view.setAspect(aspect);
    this.lastSpreadPx = -1;
  }

  resume(): void {
    audio.unlock();
    this.input.lock();
  }

  // ------------------------------------------------------------------ network

  private handle(msg: S2C): void {
    switch (msg.t) {
      case 's': this.onSnapshot(msg); break;
      case 'match':
        // Sent at kickoff and after a reconnect; either way the server expects a fresh command sequence.
        this.live = msg.match.phase === 'live';
        this.seq = 0;
        this.pending.length = 0;
        this.outgoing.length = 0;
        break;
      case 'shot': {
        const r = this.remotes.get(msg.id);
        const def = WEAPONS[msg.w];
        r?.model.fire();
        this.effects.tracer(msg.o[0], msg.o[1] - 0.25, msg.o[2], msg.e[0], msg.e[1], msg.e[2], def.visual.tracer);
        this.effects.impact(msg.e[0], msg.e[1], msg.e[2]);
        audio.gunshot(msg.w, msg.o);
        break;
      }
      case 'hit': {
        const head = msg.part === 'head';
        useStore.getState().set({ hitMarker: { n: nextN(), head, kill: msg.killed } });
        audio.hit(head);
        const v = this.remotes.get(msg.victim);
        if (v) {
          const h = msg.part === 'head' ? 1.63 : msg.part === 'feet' ? 0.1 : msg.part === 'legs' ? 0.5 : 1.15;
          this.effects.hitSpark(v.x, v.y + h, v.z, head ? 0xffffff : teamColor(v.team));
        }
        if (msg.killed) {
          audio.kill();
          useStore.getState().set({ banner: { n: nextN(), text: 'ELIMINATED', sub: (v?.name ?? 'Opponent') + (head ? '  ·  HEADSHOT' : '') } });
        }
        break;
      }
      case 'dmg': {
        const a = Math.atan2(-(msg.ax - this.sim.x), -(msg.az - this.sim.z));
        useStore.getState().set({ damage: { n: nextN(), angle: wrapAngle(a - this.yaw) } });
        audio.hurt();
        break;
      }
      case 'kill': {
        const s = useStore.getState();
        const members = s.lobby?.members ?? [];
        const k = members.find((m) => m.id === msg.killer);
        const v = members.find((m) => m.id === msg.victim);
        s.pushFeed({
          killer: k?.name ?? '?', victim: v?.name ?? '?', killerTeam: k?.team ?? 'red', victimTeam: v?.team ?? 'blue',
          weapon: msg.weapon, head: msg.head, mine: msg.killer === this.myId || msg.victim === this.myId,
        });
        if (msg.victim === this.myId) {
          s.set({ banner: { n: nextN(), text: 'YOU WERE ELIMINATED', sub: `by ${k?.name ?? 'an opponent'} · ${WEAPONS[msg.weapon].name}` } });
        }
        break;
      }
    }
  }

  private onSnapshot(m: SnapshotMsg): void {
    const now = performance.now();
    // Estimate the server clock from the fastest packets; slow ones only nudge it.
    const sample = m.st - now;
    if (this.clockOffset === null || sample > this.clockOffset || this.clockOffset - sample > 1000) this.clockOffset = sample;
    else this.clockOffset += (sample - this.clockOffset) * 0.02;

    for (let i = 0; i < m.p.length; i++) {
      const t = m.p[i];
      if (t[0] === this.myId) { this.selfProtected = (t[6] & PF.PROTECTED) !== 0; continue; }
      let r = this.remotes.get(t[0]);
      if (!r) r = this.addRemote(t[0]);
      r.lastSeen = now;
      const buf = r.buf;
      const s: Sample = buf.length >= 40 ? buf.shift()! : ({} as Sample);
      s.t = m.st; s.x = t[1]; s.y = t[2]; s.z = t[3]; s.yaw = t[4]; s.pitch = t[5]; s.flags = t[6]; s.weapon = t[7];
      buf.push(s);
    }

    const store = useStore.getState();
    if (!this.gotSnapshot) {
      this.gotSnapshot = true;
      store.set({ loading: false });
    }

    if (m.alive) {
      if (m.life !== this.life || !this.alive) {
        // (Re)spawned: adopt the server state wholesale and face the way the spawn points.
        this.life = m.life;
        this.alive = true;
        copySimState(this.sim, m.me);
        this.pending.length = 0;
        this.yaw = m.yaw;
        this.pitch = 0;
        this.wantWeapon = m.me.weapon;
        this.prevX = this.sim.x; this.prevY = this.sim.y; this.prevZ = this.sim.z;
        this.errX = this.errY = this.errZ = 0;
      } else {
        this.reconcile(m);
      }
    } else if (this.alive) {
      this.alive = false;
      this.pending.length = 0;
      audio.death();
    }

    const hud = store.hud;
    const timeLeft = Math.ceil(m.left / 1000);
    const respawnAt = m.alive || m.respawnIn <= 0 ? 0 : now + m.respawnIn;
    if (
      hud.hp !== m.hp || hud.alive !== m.alive || hud.timeLeft !== timeLeft || hud.live !== this.live ||
      hud.scores[0] !== m.sc[0] || hud.scores[1] !== m.sc[1] || (respawnAt === 0) !== (hud.respawnAt === 0)
    ) {
      store.setHud({ hp: m.hp, alive: m.alive, timeLeft, live: this.live, scores: m.sc, respawnAt });
    }
  }

  /** Server reconciliation: rewind to the authoritative state, then replay inputs the server has not seen yet. */
  private reconcile(m: SnapshotMsg): void {
    const ox = this.sim.x, oy = this.sim.y, oz = this.sim.z;
    copySimState(this.sim, m.me);
    const pending = this.pending;
    let drop = 0;
    while (drop < pending.length && pending[drop].seq <= m.ack) drop++;
    if (drop > 0) pending.splice(0, drop);
    for (let i = 0; i < pending.length; i++) stepSim(this.sim, pending[i], this.map, null);

    const dx = ox - this.sim.x, dy = oy - this.sim.y, dz = oz - this.sim.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 1e-10) return;
    if (d2 > 2.25) {
      // Too far off to smooth (teleport, heavy loss): snap.
      this.errX = this.errY = this.errZ = 0;
      this.prevX = this.sim.x; this.prevY = this.sim.y; this.prevZ = this.sim.z;
      return;
    }
    this.errX += dx; this.errY += dy; this.errZ += dz;
    this.prevX -= dx; this.prevY -= dy; this.prevZ -= dz;
  }

  private addRemote(id: string): Remote {
    const member = useStore.getState().lobby?.members.find((x) => x.id === id);
    const myTeam = useStore.getState().lobby?.members.find((x) => x.id === this.myId)?.team;
    const team = member?.team ?? 'red';
    const name = member?.name ?? 'Player';
    const model = new PlayerModel(team, name, this.mode.teamBased && team === myTeam);
    this.scene.add(model.root);
    const r: Remote = { id, name, team, model, buf: [], x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: false, shown: false, lastSeen: 0, stepDist: 0 };
    this.remotes.set(id, r);
    return r;
  }

  // ------------------------------------------------------------------ simulation

  private tick(): void {
    this.prevX = this.sim.x; this.prevY = this.sim.y; this.prevZ = this.sim.z;
    if (!this.alive || !this.live || !net.open || this.pending.length >= MAX_PENDING) return;

    const paused = !this.input.active;
    const buttons = paused ? 0 : this.input.buttons;
    const cmd: Cmd = { seq: ++this.seq, buttons, yaw: this.yaw, pitch: this.pitch, weapon: this.wantWeapon };

    const sim = this.sim;
    const prevReload = sim.reload;
    const prevWeapon = sim.weapon;
    const wasGround = sim.onGround;
    const prevVy = sim.vy;

    this.shots.length = 0;
    stepSim(sim, cmd, this.map, this.shots);
    this.pending.push(cmd);
    this.outgoing.push([cmd.seq, cmd.buttons, cmd.yaw, cmd.pitch, cmd.weapon]);

    // Immediate local feedback for predicted shots; the server confirms hits separately.
    for (let i = 0; i < this.shots.length; i++) this.localShot(this.shots[i]);

    if (sim.weapon !== prevWeapon) audio.equip();
    else if (prevReload <= 0 && sim.reload > 0) audio.reload(0);
    else if (prevReload > 0 && sim.reload <= 0) audio.reload(1);
    const fire = (buttons & BTN.FIRE) !== 0;
    if (fire && !this.lastFireHeld && sim.mags[sim.weapon] <= 0 && sim.reserves[sim.weapon] <= 0) audio.empty();
    this.lastFireHeld = fire;

    if (!wasGround && sim.onGround && prevVy < -4) audio.land();
    const speed = Math.hypot(sim.vx, sim.vz);
    if (sim.onGround && speed > MOVE.runSpeed * 0.6) {
      this.stepDist += speed * DT;
      if (this.stepDist > 2.3) { this.stepDist = 0; audio.footstep(); }
    }
  }

  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  private localShot(shot: ShotEvent): void {
    const def = WEAPONS[shot.weapon];
    let t = raycastWorld(this.map, shot.ox, shot.oy, shot.oz, shot.dx, shot.dy, shot.dz, MAX_SHOT_RANGE);
    let hitPlayer = false;
    const myTeam = this.myTeam();
    for (const r of this.remotes.values()) {
      if (!r.alive || !r.shown || (this.mode.teamBased && r.team === myTeam)) continue;
      const hit = raycastPlayer(shot.ox, shot.oy, shot.oz, shot.dx, shot.dy, shot.dz, r.x, r.y, r.z, r.yaw, t);
      if (hit) { t = hit.t; hitPlayer = true; }
    }
    const ex = shot.ox + shot.dx * t, ey = shot.oy + shot.dy * t, ez = shot.oz + shot.dz * t;
    // Start the tracer at the barrel rather than between the eyes.
    this.camera.getWorldDirection(this.fwd);
    this.right.crossVectors(this.fwd, this.up.set(0, 1, 0)).normalize();
    const md = this.view.muzzleDistance;
    this.effects.tracer(
      shot.ox + this.fwd.x * md + this.right.x * 0.15, shot.oy + this.fwd.y * md - 0.11, shot.oz + this.fwd.z * md + this.right.z * 0.15,
      ex, ey, ez, def.visual.tracer,
    );
    if (!hitPlayer && t < MAX_SHOT_RANGE) this.effects.impact(ex, ey, ez);
    audio.gunshot(shot.weapon);
    this.view.onShot(shot.weapon);
  }

  private myTeam(): Team | undefined {
    return useStore.getState().lobby?.members.find((x) => x.id === this.myId)?.team;
  }

  // ------------------------------------------------------------------ frame

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    // Mouse look is applied every rendered frame, not once per tick, to keep aim latency minimal.
    this.frameDx = this.input.dx;
    this.frameDy = this.input.dy;
    if (this.input.active && this.alive) {
      const k = this.settings.sensitivity * 0.022 * DEG;
      this.yaw = wrapAngle(this.yaw - this.input.dx * k);
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch - this.input.dy * k));
    }
    this.input.dx = 0;
    this.input.dy = 0;

    this.renderTime = (this.clockOffset === null ? 0 : now + this.clockOffset) - INTERP_DELAY_MS;

    this.acc += dt;
    let ticks = 0;
    while (this.acc >= DT && ticks < MAX_TICKS_PER_FRAME) {
      this.acc -= DT;
      this.tick();
      ticks++;
    }
    if (ticks === MAX_TICKS_PER_FRAME) this.acc = 0;
    if (this.outgoing.length > 0) {
      net.send({ t: 'i', rt: Math.round(this.renderTime * 100) / 100, c: this.outgoing });
      this.outgoing.length = 0;
    }

    this.updateRemotes(now, dt);
    this.updateCamera(dt);
    this.effects.update(dt);
    const speed = Math.hypot(this.sim.vx, this.sim.vz);
    this.view.update(this.sim, dt, speed, this.frameDx, this.frameDy, this.settings.viewBob, this.alive);

    this.renderer.info.reset();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (this.alive) {
      this.renderer.clearDepth();
      this.renderer.render(this.view.scene, this.view.camera);
    }

    this.updateHud(now);
  };

  private updateCamera(dt: number): void {
    const alpha = this.acc / DT;
    const decay = Math.exp(-dt * 12);
    this.errX *= decay; this.errY *= decay; this.errZ *= decay;
    const x = this.prevX + (this.sim.x - this.prevX) * alpha + this.errX;
    const y = this.prevY + (this.sim.y - this.prevY) * alpha + this.errY;
    const z = this.prevZ + (this.sim.z - this.prevZ) * alpha + this.errZ;
    this.camera.position.set(x, y + EYE_HEIGHT, z);

    // Show the recoil offset on screen so the crosshair always marks where the next bullet goes.
    const def = WEAPONS[this.sim.weapon];
    const k = Math.min(1, dt * 30);
    this.recP += (recoilPitch(def, this.sim.heat) - this.recP) * k;
    this.recY += (recoilYaw(def, this.sim.heat) - this.recY) * k;
    this.camera.rotation.set(Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + this.recP)), this.yaw + this.recY, 0);
    this.camera.updateMatrixWorld();
    this.camera.getWorldDirection(this.fwd);
    audio.setListener(x, y + EYE_HEIGHT, z, this.fwd.x, this.fwd.y, this.fwd.z);
  }

  /** Entity interpolation: render other players slightly in the past, between two known snapshots. */
  private updateRemotes(now: number, dt: number): void {
    const rt = this.renderTime;
    for (const r of this.remotes.values()) {
      if (now - r.lastSeen > 1500) {
        r.model.dispose();
        this.remotes.delete(r.id);
        continue;
      }
      const buf = r.buf;
      if (buf.length === 0) continue;
      let a = buf[0], b = buf[0];
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].t <= rt) { a = buf[i]; b = buf[i + 1] ?? buf[i]; break; }
      }
      const span = b.t - a.t;
      const k = span > 0 ? Math.min(1, Math.max(0, (rt - a.t) / span)) : 0;
      const aliveNow = (a.flags & PF.ALIVE) !== 0;
      const teleport = Math.abs(b.x - a.x) + Math.abs(b.z - a.z) > 6 || ((b.flags ^ a.flags) & PF.ALIVE) !== 0;
      const px = r.x, pz = r.z;
      if (teleport) { r.x = a.x; r.y = a.y; r.z = a.z; r.yaw = a.yaw; r.pitch = a.pitch; }
      else {
        r.x = a.x + (b.x - a.x) * k; r.y = a.y + (b.y - a.y) * k; r.z = a.z + (b.z - a.z) * k;
        r.yaw = lerpAngle(a.yaw, b.yaw, k); r.pitch = a.pitch + (b.pitch - a.pitch) * k;
      }

      if (r.alive && !aliveNow) {
        this.effects.eliminate(px, r.y, pz, teamColor(r.team));
        audio.eliminated([px, r.y + 1, pz]);
      }
      r.alive = aliveNow;
      if (!aliveNow) {
        r.model.hide();
        r.shown = false;
        continue;
      }
      const moved = r.shown ? Math.hypot(r.x - px, r.z - pz) : 0;
      const speed = dt > 0 ? Math.min(8, moved / dt) : 0;
      const ground = (a.flags & PF.GROUND) !== 0;
      r.model.update(r.x, r.y, r.z, r.yaw, r.pitch, speed, ground, (a.flags & PF.PROTECTED) !== 0, a.weapon, dt);
      r.shown = true;
      // Running is audible; walking (Shift) is silent.
      if (ground && speed > MOVE.runSpeed * 0.62) {
        r.stepDist += moved;
        if (r.stepDist > 2.3) { r.stepDist = 0; audio.footstep([r.x, r.y, r.z]); }
      }
    }
  }

  private updateHud(now: number): void {
    const store = useStore.getState();
    const sim = this.sim;
    const hud = store.hud;
    const mag = sim.mags[sim.weapon], reserve = sim.reserves[sim.weapon];
    const reloading = sim.reload > 0;
    const prot = this.alive && this.selfProtected;
    if (hud.weapon !== sim.weapon || hud.mag !== mag || hud.reserve !== reserve || hud.reloading !== reloading || hud.protected !== prot) {
      store.setHud({ weapon: sim.weapon, mag, reserve, reloading, protected: prot });
    }

    // Dynamic crosshair gap = the real inaccuracy cone projected onto the screen.
    const spread = this.alive ? movementSpread(WEAPONS[sim.weapon], sim) : 0;
    const px = Math.round((Math.tan(spread) / Math.tan((this.camera.fov * DEG) / 2)) * (this.canvas.clientHeight / 2));
    if (px !== this.lastSpreadPx) {
      this.lastSpreadPx = px;
      document.documentElement.style.setProperty('--xh-spread', `${px}px`);
    }

    this.fpsFrames++;
    if (now - this.fpsLast >= 500) {
      const fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsLast));
      this.fpsFrames = 0;
      this.fpsLast = now;
      if (fps !== store.fps) store.set({ fps });
    }
  }

  /** Read-only view of client state, used by the automated browser test. */
  debugState() {
    return {
      x: this.sim.x, y: this.sim.y, z: this.sim.z, yaw: this.yaw, pitch: this.pitch,
      alive: this.alive, live: this.live, seq: this.seq, pending: this.pending.length,
      weapon: this.sim.weapon, mag: this.sim.mags[this.sim.weapon], equip: this.sim.equip, hp: useStore.getState().hud.hp,
      remotes: [...this.remotes.values()].map((r) => ({ id: r.id, x: r.x, y: r.y, z: r.z, alive: r.alive, team: r.team })),
      drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles,
    };
  }

  /** Test hook: accept input without pointer lock (headless browsers cannot lock the pointer). */
  debugForceInput(): void {
    this.input.forceActive = true;
    useStore.getState().set({ paused: false });
  }

  /** Test hook: aim the view directly. */
  debugLook(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = pitch;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (net.gameSink) net.gameSink = null;
    this.unsub();
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    for (const r of this.remotes.values()) r.model.dispose();
    this.remotes.clear();
    this.effects.dispose();
    this.view.dispose();
    this.world.dispose(this.scene);
    this.renderer.dispose();
    document.documentElement.style.setProperty('--xh-spread', '0px');
  }
}
