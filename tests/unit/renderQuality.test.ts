import { expect, it } from 'vitest';
import type { RenderQuality } from '../../src/settings/settings';
import { renderPixelRatio } from '../../src/game/rendering/renderQuality';

it.each([
  [1, 'low', 0.5],
  [1, 'medium', 0.75],
  [1, 'high', 1],
  [2, 'low', 1],
  [2, 'medium', 1.5],
  [2, 'high', 2],
  [4, 'low', 1],
  [4, 'medium', 1.5],
  [4, 'high', 2],
  [1.25, 'low', 0.625],
  [1.25, 'medium', 0.9375],
  [1.25, 'high', 1.25],
  [0.5, 'low', 0.25],
  [Number.MAX_VALUE, 'high', 2],
] as const)('maps DPR %s at %s to %s', (dpr, quality, expected) => {
  expect(renderPixelRatio(dpr, quality)).toBe(expected);
});

it.each([0, -1, NaN, Infinity, -Infinity])('rejects invalid DPR %s', (dpr) => {
  expect(() => renderPixelRatio(dpr, 'high')).toThrow(/pixel ratio/i);
});

it.each(['auto', 'High', '', undefined, null, 1])(
  'rejects invalid runtime quality %s',
  (quality) => {
    // Runtime data must still be checked at this public boundary.
    expect(() => renderPixelRatio(1, quality as RenderQuality)).toThrow();
  },
);

it('rejects underflow rather than returning a zero drawing ratio', () => {
  expect(() => renderPixelRatio(Number.MIN_VALUE, 'low')).toThrow(
    /pixel ratio/i,
  );
  expect(renderPixelRatio(Number.MIN_VALUE, 'high')).toBe(Number.MIN_VALUE);
});
