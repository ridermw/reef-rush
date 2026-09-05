import { describe, expect, it } from 'vitest';
import { awardMedal, medalTimesMsSchema } from '../../src/game/race/medals';

const thresholds = { gold: 12_000, silver: 18_000, bronze: 30_000 };

describe('inclusive millisecond medals', () => {
  it.each([
    [0, 'gold'],
    [11_999.999, 'gold'],
    [12_000, 'gold'],
    [12_000.001, 'silver'],
    [12_000 + 1e-9, 'silver'],
    [12_000 + 2 ** -39, 'silver'],
    [17_999.999, 'silver'],
    [18_000, 'silver'],
    [18_000.001, 'bronze'],
    [18_000 + 1e-9, 'bronze'],
    [18_000 + 2 ** -38, 'bronze'],
    [29_999.999, 'bronze'],
    [30_000, 'bronze'],
    [30_000.001, null],
    [30_000 + 1e-9, null],
    [30_000 + 2 ** -38, null],
  ])('awards %s ms as %s', (elapsedMs, expected) => {
    expect(awardMedal(elapsedMs, thresholds)).toBe(expected);
  });

  it.each([-1, NaN, Infinity, -Infinity, '12000', null, undefined])(
    'rejects invalid elapsed time %s',
    (elapsedMs) => {
      expect(() => awardMedal(elapsedMs, thresholds)).toThrow();
    },
  );

  it.each([
    {},
    { ...thresholds, gold: 0 },
    { ...thresholds, silver: -1 },
    { ...thresholds, bronze: Infinity },
    { ...thresholds, gold: NaN },
    { ...thresholds, silver: 12_000 },
    { ...thresholds, bronze: 18_000 },
    { gold: 30_000, silver: 18_000, bronze: 12_000 },
    { ...thresholds, gold: '12000' },
    { ...thresholds, extra: true },
  ])('rejects invalid thresholds %#', (input) => {
    expect(medalTimesMsSchema.safeParse(input).success).toBe(false);
    expect(() => awardMedal(0, input)).toThrow();
  });

  it('owns and freezes parsed thresholds', () => {
    const input = { ...thresholds };
    const parsed = medalTimesMsSchema.parse(input);
    input.gold = 1;
    expect(parsed).toEqual(thresholds);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});
