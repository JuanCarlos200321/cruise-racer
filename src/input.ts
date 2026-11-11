import type { Helm } from './sim/physics';

export type Action = 'camera' | 'reset' | 'pause' | 'confirm' | 'back' | 'left' | 'right';

const KEY_ACTIONS: Record<string, Action> = {
  KeyC: 'camera',
  KeyR: 'reset',
  Escape: 'pause',
  KeyP: 'pause',
  Enter: 'confirm',
  Space: 'confirm',
  Backspace: 'back',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyA: 'left',
  KeyD: 'right',
};

/** Standard gamepad button indices. */
const PAD_ACTIONS: Record<number, Action> = {
  0: 'confirm',
  1: 'back',
  2: 'reset',
  3: 'camera',
  9: 'pause',
  14: 'left',
  15: 'right',
};
const PAD_ASTERN = 6;
const PAD_AHEAD = 7;
const STICK_DEADZONE = 0.12;

/** Keyboard and gamepad input: a continuous helm plus one-shot actions. */
export class Input {
  private readonly held = new Set<string>();
  private readonly padHeld = new Set<number>();
  private readonly listeners: ((action: Action) => void)[] = [];

  constructor() {
    window.addEventListener('keydown', (event) => {
      if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
      if (event.repeat) return;
      this.held.add(event.code);
      const action = KEY_ACTIONS[event.code];
      if (action) this.emit(action);
    });
    window.addEventListener('keyup', (event) => this.held.delete(event.code));
    window.addEventListener('blur', () => this.held.clear());
  }

  onAction(listener: (action: Action) => void): void {
    this.listeners.push(listener);
  }

  /** Call once per frame so gamepad buttons raise actions. */
  poll(): void {
    const pad = this.gamepad();
    if (!pad) return;
    for (const [index, action] of Object.entries(PAD_ACTIONS)) {
      const i = Number(index);
      const pressed = pad.buttons[i]?.pressed ?? false;
      if (pressed && !this.padHeld.has(i)) this.emit(action);
      if (pressed) this.padHeld.add(i);
      else this.padHeld.delete(i);
    }
  }

  helm(): Helm {
    const key = (...codes: string[]): number => (codes.some((c) => this.held.has(c)) ? 1 : 0);
    let throttle = key('KeyW', 'ArrowUp') - key('KeyS', 'ArrowDown');
    let rudder = key('KeyD', 'ArrowRight') - key('KeyA', 'ArrowLeft');

    const pad = this.gamepad();
    if (pad) {
      const padThrottle = (pad.buttons[PAD_AHEAD]?.value ?? 0) - (pad.buttons[PAD_ASTERN]?.value ?? 0);
      const stick = pad.axes[0] ?? 0;
      if (Math.abs(padThrottle) > 0.05) throttle = padThrottle;
      if (Math.abs(stick) > STICK_DEADZONE) rudder = stick;
    }
    return { throttle, rudder };
  }

  private gamepad(): Gamepad | null {
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (pad && pad.connected) return pad;
    }
    return null;
  }

  private emit(action: Action): void {
    for (const listener of this.listeners) listener(action);
  }
}
