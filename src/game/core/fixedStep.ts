export interface FixedStepResult {
  steps: number;
  alpha: number;
  droppedSeconds: number;
}

export class FixedStepRunner {
  private accumulatorSeconds = 0;
  private resetVersion = 0;

  constructor(
    private readonly stepSeconds = 1 / 60,
    private readonly maxFrameSeconds = 0.1,
    private readonly maxSteps = 5,
  ) {
    if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) {
      throw new Error('stepSeconds must be positive');
    }

    if (!Number.isFinite(maxFrameSeconds) || maxFrameSeconds <= 0) {
      throw new Error('maxFrameSeconds must be positive');
    }

    if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
      throw new Error('maxSteps must be a positive safe integer');
    }
  }

  advance(
    frameSeconds: number,
    step: (dt: number) => void | false,
  ): FixedStepResult {
    if (!Number.isFinite(frameSeconds)) {
      throw new RangeError('frameSeconds must be finite');
    }
    const version = this.resetVersion;
    const positiveFrameSeconds = Math.max(frameSeconds, 0);
    const clampedFrameSeconds = Math.min(
      positiveFrameSeconds,
      this.maxFrameSeconds,
    );
    const droppedSeconds = positiveFrameSeconds - clampedFrameSeconds;

    this.accumulatorSeconds += clampedFrameSeconds;

    let steps = 0;

    while (
      steps < this.maxSteps &&
      this.accumulatorSeconds >= this.stepSeconds
    ) {
      this.accumulatorSeconds -= this.stepSeconds;
      steps += 1;
      const keepGoing = step(this.stepSeconds);
      if (keepGoing === false || version !== this.resetVersion) {
        this.reset();
        break;
      }
    }

    if (
      steps === this.maxSteps &&
      this.accumulatorSeconds >= this.stepSeconds
    ) {
      const droppedRemainderSeconds = this.accumulatorSeconds;
      this.accumulatorSeconds = 0;

      return {
        steps,
        alpha: 0,
        droppedSeconds: droppedSeconds + droppedRemainderSeconds,
      };
    }

    return {
      steps,
      alpha: this.accumulatorSeconds / this.stepSeconds,
      droppedSeconds,
    };
  }

  reset(): void {
    this.accumulatorSeconds = 0;
    this.resetVersion += 1;
  }
}
