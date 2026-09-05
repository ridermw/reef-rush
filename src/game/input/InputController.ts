import type { InputFrame } from './InputFrame';

export type { InputFrame } from './InputFrame';

type ListenerTarget = Pick<
  Window,
  'addEventListener' | 'removeEventListener' | 'innerWidth' | 'innerHeight'
>;

export interface InputOptions {
  readonly isPlaying?: () => boolean;
  readonly pointerSurface?: HTMLElement;
}

const EDITABLE_TARGETS =
  'input, textarea, select, a, [contenteditable]:not([contenteditable="false"])';

function allowsKeyEvent(
  event: KeyboardEvent,
  excludedTargets: string,
): boolean {
  return (
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !(event.target instanceof Element && event.target.closest(excludedTargets))
  );
}

export function isGameplayKeyEvent(event: KeyboardEvent): boolean {
  return allowsKeyEvent(event, `button, [role="button"], ${EDITABLE_TARGETS}`);
}

export function isPauseKeyEvent(event: KeyboardEvent): boolean {
  return (
    getKeyCode(event) === 'Escape' &&
    !event.repeat &&
    allowsKeyEvent(event, EDITABLE_TARGETS)
  );
}

const GAME_KEYS = new Set([
  'KeyW',
  'KeyS',
  'KeyA',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'Escape',
  'ShiftLeft',
  'ShiftRight',
  'Shift',
]);

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
    if (
      !this.isPlaying() ||
      !(isPauseKeyEvent(event) || isGameplayKeyEvent(event))
    )
      return;
    const keyCode = getKeyCode(event);
    if (!GAME_KEYS.has(keyCode)) return;
    event.preventDefault();

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
    if (!this.isPlaying()) return;
    if (
      this.options.pointerSurface &&
      (!(event.target instanceof Node) ||
        !this.options.pointerSurface.contains(event.target))
    )
      return;
    this.pendingPointerX += normalizePointerDelta(
      event.movementX,
      this.target.innerWidth,
    );
    this.pendingPointerY += normalizePointerDelta(
      event.movementY,
      this.target.innerHeight,
    );
  };

  constructor(
    target: ListenerTarget = window,
    private readonly options: InputOptions = {},
  ) {
    this.target = target;
    this.target.addEventListener('keydown', this.handleKeyDown);
    this.target.addEventListener('keyup', this.handleKeyUp);
    this.target.addEventListener('blur', this.handleBlur);
    this.target.addEventListener('pointermove', this.handlePointerMove);
  }

  private isPlaying(): boolean {
    return this.options.isPlaying?.() ?? true;
  }

  clear(): void {
    this.handleBlur();
  }

  readFrame(): InputFrame {
    const horizontal = this.getAxis(
      ['KeyA', 'ArrowLeft'],
      ['KeyD', 'ArrowRight'],
    );
    const vertical = this.getAxis(['ArrowUp'], ['ArrowDown']);
    const throttle = this.getAxis(['KeyS'], ['KeyW']);
    const pointerX = this.pendingPointerX;
    const pointerY = this.pendingPointerY;

    this.pendingPointerX = 0;
    this.pendingPointerY = 0;

    const steerX = clampAxis(horizontal + pointerX);
    const steerY = clampAxis(vertical + pointerY);
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
}
