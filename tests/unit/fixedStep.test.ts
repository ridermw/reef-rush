import { expect, it, vi } from 'vitest';
import { FixedStepRunner } from '../../src/game/core/fixedStep';

it('steps at 60 Hz and reports interpolation', () => {
  const step = vi.fn();
  const runner = new FixedStepRunner(1 / 60);
  const result = runner.advance(1 / 40, step);

  expect(step).toHaveBeenCalledTimes(1);
  expect(result.alpha).toBeCloseTo(0.5, 5);
});

it('aborts catchup when a callback resets the runner without negative alpha', () => {
  const runner = new FixedStepRunner();
  let steps = 0;
  const result = runner.advance(0.1, () => {
    steps += 1;
    runner.reset();
  });
  expect(result).toMatchObject({ steps: 1, alpha: 0 });
  expect(steps).toBe(1);
  expect(runner.advance(1 / 60, () => {}).steps).toBe(1);
});

it('supports an explicit stop after the terminal step', () => {
  const runner = new FixedStepRunner();
  const result = runner.advance(0.1, () => false);
  expect(result).toMatchObject({ steps: 1, alpha: 0 });
});

it.each([NaN, Infinity, -Infinity])(
  'rejects nonfinite frame time %s before mutation',
  (time) => {
    const runner = new FixedStepRunner();
    expect(() => runner.advance(time, () => {})).toThrow();
    expect(runner.advance(1 / 60, () => {}).steps).toBe(1);
  },
);

it.each([
  [NaN, 0.1, 5],
  [Infinity, 0.1, 5],
  [1 / 60, Infinity, 5],
  [1 / 60, NaN, 5],
  [1 / 60, 0.1, 1.5],
  [1 / 60, 0.1, Infinity],
])('rejects invalid configuration %s %s %s', (step, frame, count) => {
  expect(() => new FixedStepRunner(step, frame, count)).toThrow();
});
