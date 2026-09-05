import { describe, expect, it } from 'vitest';
import { finishAchievements } from '../../src/game/progression/finishAchievements';
import {
  emptyProgress,
  parseProgress,
} from '../../src/game/progression/progress';
import { formatElapsedMs } from '../../src/app/formatElapsedMs';

const result = {
  courseId: 'sunlit-shoals',
  elapsedMs: 12_345.678,
  medal: 'gold',
  pearlCount: 3,
  totalPearls: 4,
} as const;

describe('finish-time provenance', () => {
  it('distinguishes first completion from a strict new time record and records actual unlocks', () => {
    const achievement = finishAchievements(emptyProgress(), result);
    expect(achievement).toMatchObject({
      firstCompletion: true,
      newTimeRecord: false,
      previousBest: null,
      bestAtFinish: { bestElapsedMs: result.elapsedMs },
      newlyUnlocked: ['kelpworks'],
    });
    expect(Object.isFrozen(achievement)).toBe(true);
    expect(Object.isFrozen(achievement.bestAtFinish)).toBe(true);
    expect(Object.isFrozen(achievement.newlyUnlocked)).toBe(true);
    expect(
      finishAchievements(emptyProgress(), { ...result, medal: null })
        .newlyUnlocked,
    ).toEqual([]);
  });

  it.each([
    [12_345.678, false],
    [15_000, false],
    [12_000, true],
  ])(
    'only claims a strict improvement for a %s ms replay',
    (elapsedMs, newTimeRecord) => {
      const progress = parseProgress({
        version: 1,
        courses: {
          'sunlit-shoals': {
            bestElapsedMs: result.elapsedMs,
            bestMedal: 'gold',
            bestPearlCount: 4,
          },
        },
      });
      expect(
        finishAchievements(progress, { ...result, elapsedMs }),
      ).toMatchObject({
        firstCompletion: false,
        newTimeRecord,
        newlyUnlocked: [],
        previousBest: progress.courses['sunlit-shoals'],
        bestAtFinish: {
          bestElapsedMs: Math.min(elapsedMs, result.elapsedMs),
          bestPearlCount: 4,
        },
      });
    },
  );

  it.each([
    [0, '0:00.00'],
    [999.999, '0:00.99'],
    [59_999.999, '0:59.99'],
    [91_250, '1:31.25'],
    [21_940.483, '0:21.94'],
  ])('preserves floor-centisecond formatting for %s', (value, expected) => {
    expect(formatElapsedMs(value)).toBe(expected);
  });
});
