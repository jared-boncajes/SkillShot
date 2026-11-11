import { BTN, WEAPON_COUNT } from '@aimstrike/shared';

const KEYMAP: Record<string, number> = {
  KeyW: BTN.FORWARD, ArrowUp: BTN.FORWARD,
  KeyS: BTN.BACK, ArrowDown: BTN.BACK,
  KeyA: BTN.LEFT, ArrowLeft: BTN.LEFT,
  KeyD: BTN.RIGHT, ArrowRight: BTN.RIGHT,
  Space: BTN.JUMP,
  ShiftLeft: BTN.WALK, ShiftRight: BTN.WALK,
  KeyR: BTN.RELOAD,
};

export interface InputEvents {
  onLockChange(locked: boolean): void;
  onScoreboard(show: boolean): void;
  onWeapon(slot: number, relative: boolean): void;
}

/** Keyboard + mouse capture with pointer lock. Raw mouse deltas accumulate until the game consumes them. */
export class Input {
  buttons = 0;
  dx = 0;
  dy = 0;
  locked = false;
  /** Test hook: treat input as active without pointer lock (headless browsers cannot lock). */
  forceActive = false;
  private wheelAcc = 0;
  private readonly off: Array<() => void> = [];

  constructor(private readonly canvas: HTMLCanvasElement, private readonly events: InputEvents) {
    const on = <K extends keyof DocumentEventMap>(target: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.buttons = 0;
      this.events.onLockChange(this.locked);
    });
    on(document, 'pointerlockerror', () => this.events.onLockChange(false));

    on(document, 'mousemove', (e: MouseEvent) => {
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    on(document, 'mousedown', (e: MouseEvent) => {
      if (this.active && e.button === 0) this.buttons |= BTN.FIRE;
    });
    on(document, 'mouseup', (e: MouseEvent) => {
      if (e.button === 0) this.buttons &= ~BTN.FIRE;
    });
    on(document, 'keydown', (e: KeyboardEvent) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        if (!e.repeat) this.events.onScoreboard(true);
        return;
      }
      if (!this.active) return;
      const bit = KEYMAP[e.code];
      if (bit) {
        this.buttons |= bit;
        e.preventDefault();
      } else if (/^Digit[1-9]$/.test(e.code)) {
        const slot = Number(e.code.slice(5)) - 1;
        if (slot < WEAPON_COUNT) this.events.onWeapon(slot, false);
      }
    });
    on(document, 'keyup', (e: KeyboardEvent) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        this.events.onScoreboard(false);
        return;
      }
      const bit = KEYMAP[e.code];
      if (bit) this.buttons &= ~bit;
    });
    on(document, 'wheel', (e: WheelEvent) => {
      if (!this.active) return;
      this.wheelAcc += e.deltaY;
      if (Math.abs(this.wheelAcc) >= 50) {
        this.events.onWeapon(this.wheelAcc > 0 ? 1 : -1, true);
        this.wheelAcc = 0;
      }
    }, { passive: true });
    on(window, 'blur', () => {
      this.buttons = 0;
      this.events.onScoreboard(false);
    });
    on(this.canvas, 'contextmenu', (e: Event) => e.preventDefault());
  }

  get active(): boolean {
    return this.locked || this.forceActive;
  }

  /** Must be called from a user gesture. Unadjusted movement removes OS mouse acceleration where supported. */
  lock(): void {
    if (this.locked) return;
    try {
      const req = this.canvas.requestPointerLock as (opts?: { unadjustedMovement?: boolean }) => Promise<void> | void;
      const p = req.call(this.canvas, { unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          // Raw input unsupported on this platform (or the lock cooldown is active): fall back to a standard lock.
          const q = (this.canvas.requestPointerLock as () => Promise<void> | void).call(this.canvas);
          if (q && typeof q.catch === 'function') q.catch(() => this.events.onLockChange(false));
        });
      }
    } catch {
      this.events.onLockChange(false);
    }
  }

  unlock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  dispose(): void {
    this.unlock();
    for (const fn of this.off) fn();
  }
}
