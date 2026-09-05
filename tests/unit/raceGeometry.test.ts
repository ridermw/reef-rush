import { describe, expect, it } from 'vitest';
import type { Vector3 } from '../../src/game/course/courseDefinition';
import {
  movementSegment,
  pickupFraction,
  pickupIntersection,
} from '../../src/game/race/raceGeometry';
import {
  compareIntersections,
  scaleIntersection,
  type RaceIntersection,
} from '../../src/game/race/raceIntersection';

describe('retained intersection scaling and ordering', () => {
  it.each([
    [1n, 4n, Number.MIN_VALUE, Number.MIN_VALUE * 250],
    [1n, 16n, Number.MIN_VALUE, Number.MIN_VALUE * 62],
    [3n, 16n, Number.MIN_VALUE, Number.MIN_VALUE * 188],
    [1n, 1n, Number.MIN_VALUE, Number.MIN_VALUE * 1000],
    [1n, 2000n, Number.MAX_VALUE, Number.MAX_VALUE / 2],
  ] as const)(
    'rounds %s/%s of %s seconds only after exact millisecond conversion',
    (numerator, denominator, seconds, expectedMs) => {
      expect(scaleIntersection({ numerator, denominator }, seconds, 1000)).toBe(
        expectedMs,
      );
    },
  );

  it('keeps an irrational millisecond duration finite when seconds * 1000 overflows', () => {
    const contact = pickupIntersection(
      movementSegment([0, 0, 0], [1000, 0, 0]),
      [2, 1, 0],
      1.5,
    );
    if (contact === null) throw new Error('Expected irrational contact.');
    expect('discriminant' in contact).toBe(true);
    expect(Number.MAX_VALUE * 1000).toBe(Infinity);
    const duration = scaleIntersection(contact, Number.MAX_VALUE, 1000);
    const expected = Number.MAX_VALUE * (2 - Math.sqrt(1.25));
    expect(Number.isFinite(duration)).toBe(true);
    expect(Math.abs(duration / expected - 1)).toBeLessThanOrEqual(
      4 * Number.EPSILON,
    );
  });

  it('divides before binary64 overflow when a scaled irrational duration is finite', () => {
    const contact = pickupIntersection(
      movementSegment([0, 0, 0], [1, 0, 0]),
      [2, 1, 0],
      1.5,
    );
    if (contact === null) throw new Error('Expected irrational contact.');
    expect('discriminant' in contact).toBe(true);
    // c/b = 11/8; multiplying before the root-factor division overflows.
    expect(Number.MAX_VALUE * (11 / 8)).toBe(Infinity);
    const duration = scaleIntersection(contact, Number.MAX_VALUE);
    const expected = Number.MAX_VALUE * (2 - Math.sqrt(1.25));
    expect(Number.isFinite(duration)).toBe(true);
    expect(Math.abs(duration / expected - 1)).toBeLessThanOrEqual(
      4 * Number.EPSILON,
    );
  });

  it('orders mixed rational and irrational intersections in both directions', () => {
    const segment = movementSegment([0, 0, 0], [1, 0, 0]);
    const root = (x: number, y: number, radius = 1): RaceIntersection => {
      const contact = pickupIntersection(segment, [x, y, 0], radius);
      if (contact === null) throw new Error('Expected irrational contact.');
      expect('discriminant' in contact).toBe(true);
      return contact;
    };
    const ordered: RaceIntersection[] = [
      { numerator: 0n, denominator: 1n },
      root(1, 0.5),
      { numerator: 1n, denominator: 4n },
      root(1, 0.75),
      { numerator: 1n, denominator: 2n },
      root(1.5, 0.5),
      { numerator: 3n, denominator: 4n },
      root(2, 1, 1.5),
      { numerator: 1n, denominator: 1n },
    ];
    for (const [leftIndex, left] of ordered.entries()) {
      for (const [rightIndex, right] of ordered.entries()) {
        expect(
          compareIntersections(left, right) ===
            Math.sign(leftIndex - rightIndex),
        ).toBe(true);
      }
    }
  });

  it('recognizes tied irrational contacts with differently scaled exact coefficients', () => {
    const contacts = [1, 2, 1e100].map((scale) =>
      pickupIntersection(
        movementSegment([0, 0, 0], [scale, 0, 0]),
        [scale, scale / 2, 0],
        scale,
      ),
    );
    for (const left of contacts) {
      for (const right of contacts) {
        if (left === null || right === null) {
          throw new Error('Expected irrational contacts.');
        }
        expect('discriminant' in left).toBe(true);
        expect(compareIntersections(left, right) === 0).toBe(true);
      }
    }
  });
});

describe('sphere entry precision over finite movement scales', () => {
  it('retains root precision when normalized coefficients are nonzero subnormals', () => {
    const span = 1e154;
    const radius = 1 / 64;
    const gap = 2 ** -47;
    const scale = 2 ** 1023;
    // Independent axial coefficients: c = gap * (2r + gap), D = (span*r)^2.
    for (const normalized of [
      (gap * (2 * radius + gap)) / scale,
      ((span / scale) * radius) ** 2,
    ]) {
      expect(normalized).toBeGreaterThan(0);
      expect(normalized).toBeLessThan(2 ** -1022);
    }
    const entry = pickupFraction(
      movementSegment([0, 0, 0], [-span, 0, 0]),
      [-radius - gap, 0, 0],
      radius,
    );
    expect(entry).not.toBeNull();
    expect(entry).toBeGreaterThan(0);
    if (entry === null) throw new Error('Expected axial contact.');
    expect(Math.abs(entry / (gap / span) - 1)).toBeLessThanOrEqual(
      4 * Number.EPSILON,
    );
  });

  it.each([1e140, 1e150, 1e152, 1e154, 1e156, 1e200])(
    'retains axial relative accuracy across permutations and reflections at span %s',
    (span) => {
      for (const axis of [0, 1, 2]) {
        for (const sign of [-1, 1]) {
          const axial = (value: number): Vector3 => [
            axis === 0 ? sign * value : 0,
            axis === 1 ? sign * value : 0,
            axis === 2 ? sign * value : 0,
          ];
          const radius = 1 / 64;
          const segment = movementSegment([0, 0, 0], axial(span));
          const entries = [2 ** -47, 3 * 2 ** -48].map((gap) => {
            const entry = pickupFraction(segment, axial(radius + gap), radius);
            expect(entry).not.toBeNull();
            expect(entry).toBeGreaterThan(0);
            if (entry === null) throw new Error('Expected axial contact.');
            // Absolute near-zero tolerances cannot detect lost root bits.
            expect(Math.abs(entry / (gap / span) - 1)).toBeLessThanOrEqual(
              4 * Number.EPSILON,
            );
            return entry;
          });
          expect(entries[0]).toBeLessThan(entries[1]);
        }
      }
    },
  );
});
