import { WEAPONS } from '@aimstrike/shared';

/**
 * Fully synthesised audio (no sample files): gunshots, hit confirmations,
 * footsteps, UI sounds and a quiet generative menu track. World sounds are
 * positioned with HRTF panners so gunfire and footsteps are directional.
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private noise!: AudioBuffer;
  private musicTimer = 0;
  private musicOn = false;
  private volumes = { master: 0.8, sfx: 0.9, music: 0.35 };

  /** Browsers only allow audio after a user gesture; call this from click/key handlers. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.ratio.value = 8;
      this.master.connect(limiter).connect(ctx.destination);
      this.sfx = ctx.createGain();
      this.sfx.connect(this.master);
      this.music = ctx.createGain();
      this.music.connect(this.master);
      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.applyVolumes();
      if (this.musicOn) this.scheduleMusic();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolumes(master: number, sfx: number, music: number): void {
    this.volumes = { master, sfx, music };
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.02);
    this.sfx.gain.setTargetAtTime(this.volumes.sfx, t, 0.02);
    this.music.gain.setTargetAtTime(this.volumes.music * 0.5, t, 0.05);
  }

  setListener(x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = x; l.positionY.value = y; l.positionZ.value = z;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      l.setPosition(x, y, z);
      l.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /** Output node for a sound: the SFX bus directly, or through a positional panner. */
  private out(pos?: [number, number, number]): AudioNode {
    if (!pos || !this.ctx) return this.sfx;
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 4;
    p.maxDistance = 90;
    p.rolloffFactor = 1.1;
    p.positionX.value = pos[0]; p.positionY.value = pos[1]; p.positionZ.value = pos[2];
    p.connect(this.sfx);
    return p;
  }

  private tone(
    out: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0,
  ): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private burst(out: AudioNode, freq: number, q: number, dur: number, gain: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loopStart = Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  /** Each weapon has its own voice built from its audio profile. */
  gunshot(weapon: number, pos?: [number, number, number]): void {
    if (!this.ctx) return;
    const a = WEAPONS[weapon].audio;
    const out = this.out(pos);
    const g = a.gain * (pos ? 1.0 : 0.55);
    this.tone(out, 'triangle', a.thump * 2.2, a.thump * 0.5, a.decay, g * 0.9);
    this.burst(out, a.crack, 0.7, a.decay * 0.8, g * 0.9);
    this.burst(out, a.crack * 0.3, 0.5, a.decay * 1.6, g * 0.35);
  }

  hit(head: boolean): void {
    if (!this.ctx) return;
    if (head) {
      this.tone(this.sfx, 'sine', 1900, 1850, 0.16, 0.3);
      this.tone(this.sfx, 'sine', 2850, 2800, 0.2, 0.16);
      this.burst(this.sfx, 5000, 2, 0.04, 0.25);
    } else {
      this.tone(this.sfx, 'triangle', 950, 700, 0.06, 0.28);
      this.burst(this.sfx, 2400, 2, 0.03, 0.18);
    }
  }

  kill(): void {
    if (!this.ctx) return;
    this.tone(this.sfx, 'sine', 660, 660, 0.12, 0.25, 0.05);
    this.tone(this.sfx, 'sine', 990, 990, 0.22, 0.25, 0.15);
  }

  hurt(): void {
    if (!this.ctx) return;
    this.tone(this.sfx, 'sine', 180, 70, 0.18, 0.5);
    this.burst(this.sfx, 500, 0.8, 0.08, 0.3);
  }

  death(): void {
    if (!this.ctx) return;
    this.tone(this.sfx, 'sawtooth', 300, 60, 0.5, 0.2);
  }

  eliminated(pos: [number, number, number]): void {
    if (!this.ctx) return;
    const out = this.out(pos);
    this.tone(out, 'sine', 500, 120, 0.3, 0.4);
    this.burst(out, 1800, 1, 0.2, 0.3);
  }

  reload(stage: 0 | 1): void {
    if (!this.ctx) return;
    this.burst(this.sfx, stage === 0 ? 1400 : 2600, 6, 0.05, 0.4);
    this.tone(this.sfx, 'square', stage === 0 ? 240 : 420, 120, 0.04, 0.08, 0.02);
  }

  empty(): void {
    if (!this.ctx) return;
    this.burst(this.sfx, 3200, 8, 0.03, 0.25);
  }

  equip(): void {
    if (!this.ctx) return;
    this.burst(this.sfx, 900, 3, 0.07, 0.22);
    this.burst(this.sfx, 2000, 5, 0.04, 0.2, 0.08);
  }

  footstep(pos?: [number, number, number]): void {
    if (!this.ctx) return;
    const out = this.out(pos);
    this.burst(out, 260 + Math.random() * 80, 1.2, 0.07, pos ? 0.9 : 0.14);
  }

  land(): void {
    if (!this.ctx) return;
    this.burst(this.sfx, 180, 1, 0.1, 0.3);
  }

  ui(kind: 'click' | 'hover' | 'error' | 'ready' = 'click'): void {
    if (!this.ctx) return;
    if (kind === 'click') this.tone(this.sfx, 'triangle', 700, 900, 0.05, 0.12);
    else if (kind === 'hover') this.tone(this.sfx, 'sine', 1200, 1200, 0.02, 0.03);
    else if (kind === 'ready') { this.tone(this.sfx, 'triangle', 600, 600, 0.08, 0.14); this.tone(this.sfx, 'triangle', 900, 900, 0.12, 0.14, 0.08); }
    else this.tone(this.sfx, 'square', 200, 140, 0.15, 0.1);
  }

  countdown(final: boolean): void {
    if (!this.ctx) return;
    this.tone(this.sfx, 'square', final ? 1200 : 600, final ? 1200 : 600, final ? 0.4 : 0.12, 0.12);
  }

  /** Quiet generative pad for the menus, routed through the music volume. */
  setMusic(on: boolean): void {
    if (this.musicOn === on) return;
    this.musicOn = on;
    window.clearTimeout(this.musicTimer);
    if (on && this.ctx) this.scheduleMusic();
  }

  private scheduleMusic(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicOn) return;
    const chords = [[110, 164.8, 220, 261.6], [98, 146.8, 196, 246.9], [87.3, 130.8, 174.6, 220], [98, 146.8, 196, 293.7]];
    const chord = chords[Math.floor(ctx.currentTime / 6) % chords.length];
    const t = ctx.currentTime + 0.05;
    for (const f of chord) {
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 700;
        osc.type = 'sawtooth';
        osc.frequency.value = f;
        osc.detune.value = detune;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.05, t + 2);
        g.gain.linearRampToValueAtTime(0.0001, t + 6.5);
        osc.connect(lp).connect(g).connect(this.music);
        osc.start(t);
        osc.stop(t + 6.6);
      }
    }
    this.musicTimer = window.setTimeout(() => this.scheduleMusic(), 6000);
  }
}

export const audio = new AudioEngine();
