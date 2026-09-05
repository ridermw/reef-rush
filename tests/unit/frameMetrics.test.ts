import { describe, expect, it } from 'vitest';
import { createFrameMetrics } from '../../src/game/core/frameMetrics';

describe('bounded running frame metrics', () => {
  it('reports honest empty summaries and a legitimate zero-duration sample', () => {
    const metrics = createFrameMetrics();
    expect(metrics.getSnapshot()).toEqual({
      capacity: 120,
      sampleCount: 0,
      droppedSampleCount: 0,
      intervalMs: null,
      cpuWorkMs: null,
      droppedMs: null,
    });
    metrics.record(0, 0, 0);
    expect(metrics.getSnapshot()).toEqual({
      capacity: 120,
      sampleCount: 1,
      droppedSampleCount: 0,
      intervalMs: { mean: 0, p95: 0, max: 0 },
      cpuWorkMs: { mean: 0, p95: 0, max: 0 },
      droppedMs: { mean: 0, p95: 0, max: 0 },
    });
  });

  it('uses nearest rank P95 independently for all three windows', () => {
    const metrics = createFrameMetrics();
    for (let i = 1; i <= 20; i++) metrics.record(i, i * 2, i % 2);
    expect(metrics.getSnapshot()).toEqual({
      capacity: 120,
      sampleCount: 20,
      droppedSampleCount: 10,
      intervalMs: { mean: 10.5, p95: 19, max: 20 },
      cpuWorkMs: { mean: 21, p95: 38, max: 40 },
      droppedMs: { mean: 0.5, p95: 1, max: 1 },
    });
    metrics.record(21, 42, 0);
    expect(metrics.getSnapshot().intervalMs?.p95).toBe(20);
  });

  it.each([-1, NaN, Infinity, -Infinity])(
    'rejects %s in any position without partially mutating a full window',
    (invalid) => {
      const metrics = createFrameMetrics();
      for (let i = 0; i < 120; i++) metrics.record(i, i, i);
      const before = metrics.getSnapshot();
      expect(() => metrics.record(invalid, 1, 1)).toThrow(RangeError);
      expect(() => metrics.record(1, invalid, 1)).toThrow(RangeError);
      expect(() => metrics.record(1, 1, invalid)).toThrow(RangeError);
      expect(metrics.getSnapshot()).toEqual(before);
      metrics.record(120, 120, 0);
      expect(metrics.getSnapshot().intervalMs).toEqual({
        mean: 60.5,
        p95: 114,
        max: 120,
      });
    },
  );

  it('overwrites at many multiples of capacity and resets every counter/window', () => {
    const metrics = createFrameMetrics();
    for (let i = 1; i <= 120 * 20 + 17; i++)
      metrics.record(i, 7, i <= 120 ? 1 : 0);
    expect(metrics.getSnapshot()).toEqual({
      capacity: 120,
      sampleCount: 120,
      droppedSampleCount: 0,
      intervalMs: { mean: 2357.5, p95: 2411, max: 2417 },
      cpuWorkMs: { mean: 7, p95: 7, max: 7 },
      droppedMs: { mean: 0, p95: 0, max: 0 },
    });
    metrics.reset();
    expect(metrics.getSnapshot()).toEqual(createFrameMetrics().getSnapshot());
    metrics.record(9, 3, 1);
    expect(metrics.getSnapshot().intervalMs).toEqual({
      mean: 9,
      p95: 9,
      max: 9,
    });
    expect(metrics.getSnapshot().droppedSampleCount).toBe(1);
  });

  it('keeps aggregation finite for extreme finite samples without sum overflow', () => {
    const metrics = createFrameMetrics();
    for (let i = 0; i < 120; i++)
      metrics.record(
        Number.MAX_VALUE,
        i % 2 ? Number.MAX_VALUE : 0,
        Number.MIN_VALUE,
      );
    const snapshot = metrics.getSnapshot();
    expect(snapshot.intervalMs).toEqual({
      mean: Number.MAX_VALUE,
      p95: Number.MAX_VALUE,
      max: Number.MAX_VALUE,
    });
    expect(snapshot.cpuWorkMs!.mean / Number.MAX_VALUE).toBeCloseTo(0.5, 14);
    expect(snapshot.cpuWorkMs!.p95).toBe(Number.MAX_VALUE);
    expect(snapshot.droppedMs!.mean).toBe(Number.MIN_VALUE);
  });

  it('returns independent deeply immutable summaries without exposing windows', () => {
    const metrics = createFrameMetrics();
    metrics.record(10, 4, 2);
    const before = metrics.getSnapshot();
    expect(Object.isFrozen(before)).toBe(true);
    for (const value of Object.values(before)) {
      expect(Array.isArray(value) || ArrayBuffer.isView(value)).toBe(false);
      if (value && typeof value === 'object')
        expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => Object.assign(before.intervalMs!, { mean: 999 })).toThrow();
    metrics.record(20, 8, 0);
    metrics.reset();
    expect(before.intervalMs).toEqual({ mean: 10, p95: 10, max: 10 });
    expect(before.sampleCount).toBe(1);
  });
});
