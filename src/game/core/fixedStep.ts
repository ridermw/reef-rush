export interface FixedStepResult {
  steps: number;
  alpha: number;
  droppedSeconds: number;
}

export class FixedStepRunner {
  private accumulatorSeconds = 0;

  constructor(
    private readonly stepSeconds = 1 / 60,
    private readonly maxFrameSeconds = 0.1,
    private readonly maxSteps = 5,
  ) {
    if (stepSeconds <= 0) {
      throw new Error('stepSeconds must be positive');
    }

    if (maxFrameSeconds <= 0) {
      throw new Error('maxFrameSeconds must be positive');
    }

    if (maxSteps <= 0) {
      throw new Error('maxSteps must be positive');
    }
  }

  advance(frameSeconds: number, step: (dt: number) => void): FixedStepResult {
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
      step(this.stepSeconds);
      this.accumulatorSeconds -= this.stepSeconds;
      steps += 1;
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
  }
}
