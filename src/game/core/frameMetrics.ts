export interface FrameSummary {
  readonly mean: number;
  readonly p95: number;
  readonly max: number;
}

export interface FrameMetricsSnapshot {
  readonly capacity: number;
  readonly sampleCount: number;
  /** Samples in the current window with nonzero discarded simulation time. */
  readonly droppedSampleCount: number;
  readonly intervalMs: FrameSummary | null;
  readonly cpuWorkMs: FrameSummary | null;
  readonly droppedMs: FrameSummary | null;
}

const capacity = 120;

export function createFrameMetrics() {
  const intervals = new Float64Array(capacity);
  const work = new Float64Array(capacity);
  const dropped = new Float64Array(capacity);
  let next = 0;
  let count = 0;

  function summarize(window: Float64Array): FrameSummary | null {
    if (count === 0) return null;
    const sorted = window.slice(0, count).sort();
    let mean = 0;
    // Nonnegative finite inputs keep each difference finite, unlike a raw sum.
    for (let i = 0; i < count; i++) mean += (sorted[i] - mean) / (i + 1);
    return Object.freeze({
      mean,
      p95: sorted[Math.ceil(count * 0.95) - 1],
      max: sorted[count - 1],
    });
  }

  return {
    record(intervalMs: number, cpuWorkMs: number, droppedMs: number): void {
      if (
        !Number.isFinite(intervalMs) ||
        intervalMs < 0 ||
        !Number.isFinite(cpuWorkMs) ||
        cpuWorkMs < 0 ||
        !Number.isFinite(droppedMs) ||
        droppedMs < 0
      )
        throw new RangeError('Frame durations must be nonnegative and finite.');
      intervals[next] = intervalMs;
      work[next] = cpuWorkMs;
      dropped[next] = droppedMs;
      next = (next + 1) % capacity;
      count = Math.min(count + 1, capacity);
    },
    reset(): void {
      next = 0;
      count = 0;
    },
    getSnapshot(): FrameMetricsSnapshot {
      let droppedSampleCount = 0;
      for (let i = 0; i < count; i++) if (dropped[i] > 0) droppedSampleCount++;
      return Object.freeze({
        capacity,
        sampleCount: count,
        droppedSampleCount,
        intervalMs: summarize(intervals),
        cpuWorkMs: summarize(work),
        droppedMs: summarize(dropped),
      });
    },
  };
}
