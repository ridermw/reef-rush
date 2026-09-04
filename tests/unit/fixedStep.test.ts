import { expect, it, vi } from 'vitest';
import { FixedStepRunner } from '../../src/game/core/fixedStep';

it('steps at 60 Hz and reports interpolation', () => {
  const step = vi.fn();
  const runner = new FixedStepRunner(1 / 60);
  const result = runner.advance(1 / 40, step);

  expect(step).toHaveBeenCalledTimes(1);
  expect(result.alpha).toBeCloseTo(0.5, 5);
});
