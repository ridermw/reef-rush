import type { InputFrame } from './InputFrame';

export type TouchAction = 'faster' | 'slower' | 'brake';

function clampAxis(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/** A separate input owner: releasing a finger never releases a physical key. */
export class TouchInput {
  private x = 0;
  private y = 0;
  private readonly actions = new Set<TouchAction>();
  private dashQueued = false;
  private readonly resetListeners = new Set<() => void>();

  constructor(private readonly isPlaying: () => boolean) {}

  setSteering(screenX: number, screenY: number): void {
    if (![screenX, screenY].every(Number.isFinite))
      throw new RangeError('Touch steering axes must be finite.');
    if (!this.isPlaying()) return;
    this.x = -clampAxis(screenX);
    this.y = -clampAxis(screenY);
  }

  setAction(action: TouchAction, held: boolean): void {
    if (!held) this.actions.delete(action);
    else if (this.isPlaying()) this.actions.add(action);
  }

  queueDash(): void {
    if (this.isPlaying()) this.dashQueued = true;
  }

  cancelPendingDash(): void {
    this.dashQueued = false;
  }

  readonly clear = (): void => {
    this.x = 0;
    this.y = 0;
    this.actions.clear();
    this.dashQueued = false;
    for (const listener of this.resetListeners) listener();
  };

  subscribeReset(listener: () => void): () => void {
    this.resetListeners.add(listener);
    return () => {
      this.resetListeners.delete(listener);
    };
  }

  combine(frame: InputFrame): InputFrame {
    if (!this.isPlaying()) return frame;
    const combined = {
      ...frame,
      steerX: clampAxis(frame.steerX + this.x),
      steerY: clampAxis(frame.steerY + this.y),
      throttle: clampAxis(
        frame.throttle +
          Number(this.actions.has('faster')) -
          Number(this.actions.has('slower')),
      ),
      brakeHeld: frame.brakeHeld || this.actions.has('brake'),
      dashPressed: frame.dashPressed || this.dashQueued,
    };
    this.dashQueued = false;
    return combined;
  }
}
