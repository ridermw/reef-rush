import type { InputFrame } from './InputFrame';

export type { InputFrame } from './InputFrame';

type ListenerTarget = Pick<
  Window,
  'addEventListener' | 'removeEventListener' | 'innerWidth' | 'innerHeight'
>;

function clampAxis(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function normalizePointerDelta(delta: number, dimension: number): number {
  const halfDimension = Math.max(1, dimension / 2);
  return delta / halfDimension;
}

function getKeyCode(event: KeyboardEvent): string {
  return event.code || event.key;
}

export class InputController {
  private readonly target: ListenerTarget;
  private readonly keyStates = new Set<string>();
  private pendingPointerX = 0;
  private pendingPointerY = 0;
  private dashQueued = false;
  private pauseQueued = false;
  private brakeHeld = false;
  private destroyed = false;

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const keyCode = getKeyCode(event);

    if (event.repeat && (keyCode === 'Space' || keyCode === 'Escape')) {
      return;
    }

    this.keyStates.add(keyCode);

    if (keyCode === 'Space' && !event.repeat) {
      this.dashQueued = true;
    }

    if (keyCode === 'Escape' && !event.repeat) {
      this.pauseQueued = true;
    }

    if (
      keyCode === 'ShiftLeft' ||
      keyCode === 'ShiftRight' ||
      keyCode === 'Shift'
    ) {
      this.brakeHeld = true;
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    const keyCode = getKeyCode(event);
    this.keyStates.delete(keyCode);

    if (
      keyCode === 'ShiftLeft' ||
      keyCode === 'ShiftRight' ||
      keyCode === 'Shift'
    ) {
      this.brakeHeld = false;
    }
  };

  private readonly handleBlur = (): void => {
    this.keyStates.clear();
    this.pendingPointerX = 0;
    this.pendingPointerY = 0;
    this.dashQueued = false;
    this.pauseQueued = false;
    this.brakeHeld = false;
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    this.pendingPointerX += normalizePointerDelta(
      event.movementX,
      this.target.innerWidth,
    );
    this.pendingPointerY += normalizePointerDelta(
      event.movementY,
      this.target.innerHeight,
    );
  };

  constructor(target: ListenerTarget = window) {
    this.target = target;
    this.target.addEventListener('keydown', this.handleKeyDown);
    this.target.addEventListener('keyup', this.handleKeyUp);
    this.target.addEventListener('blur', this.handleBlur);
    this.target.addEventListener('pointermove', this.handlePointerMove);
  }

  readFrame(): InputFrame {
    const horizontal = this.getAxis(
      ['KeyA', 'ArrowLeft'],
      ['KeyD', 'ArrowRight'],
    );
    const vertical = this.getAxis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    const pointerX = this.pendingPointerX;
    const pointerY = this.pendingPointerY;

    this.pendingPointerX = 0;
    this.pendingPointerY = 0;

    const steerX = clampAxis(horizontal + pointerX);
    const steerY = clampAxis(vertical + pointerY);
    const throttle = clampAxis(this.getThrottle());
    const dashPressed = this.dashQueued;
    const pausePressed = this.pauseQueued;

    this.dashQueued = false;
    this.pauseQueued = false;

    return {
      steerX,
      steerY,
      throttle,
      dashPressed,
      brakeHeld: this.brakeHeld,
      pausePressed,
    };
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.target.removeEventListener('keydown', this.handleKeyDown);
    this.target.removeEventListener('keyup', this.handleKeyUp);
    this.target.removeEventListener('blur', this.handleBlur);
    this.target.removeEventListener('pointermove', this.handlePointerMove);
  }

  private getAxis(
    negativeCodes: readonly string[],
    positiveCodes: readonly string[],
  ): number {
    let value = 0;

    for (const code of negativeCodes) {
      if (this.keyStates.has(code)) {
        value -= 1;
      }
    }

    for (const code of positiveCodes) {
      if (this.keyStates.has(code)) {
        value += 1;
      }
    }

    return value;
  }

  private getThrottle(): number {
    if (this.keyStates.has('KeyW') || this.keyStates.has('ArrowUp')) {
      return 1;
    }

    if (this.keyStates.has('KeyS') || this.keyStates.has('ArrowDown')) {
      return -1;
    }

    return 0;
  }
}
