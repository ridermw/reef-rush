import { describe, expect, it } from 'vitest';
import {
  emptyProgress,
  mergeProgress,
  parseProgress,
  progressSchema,
  unlockedCourseIds,
  updateProgress,
} from '../../src/game/progression/progress';
import type { FinishedRaceResult } from '../../src/game/race/raceTypes';
import { RaceSession } from '../../src/game/race/RaceSession';
import { scaledRatio } from '../../src/game/race/exactArithmetic';
import { courseFixture } from '../fixtures/courseDefinition';

const result: FinishedRaceResult = {
  courseId: 'sunlit-shoals',
  elapsedMs: 12_345.678,
  medal: 'silver',
  pearlCount: 2,
  totalPearls: 4,
};
const best = {
  bestElapsedMs: result.elapsedMs,
  bestMedal: result.medal,
  bestPearlCount: result.pearlCount,
};
const progress = { version: 1, courses: { 'sunlit-shoals': best } };

describe('monotonic progress reconciliation', () => {
  const other = {
    version: 1,
    courses: {
      'sunlit-shoals': {
        bestElapsedMs: 1000,
        bestMedal: 'bronze',
        bestPearlCount: 4,
      },
      kelpworks: best,
    },
  };

  it('unions every course and retains each best field independently', () => {
    const source = {
      ...progress,
      courses: { ...progress.courses, 'blacksmoker-run': best },
    };
    expect(mergeProgress(source, other)).toEqual({
      version: 1,
      courses: {
        'sunlit-shoals': {
          bestElapsedMs: 1000,
          bestMedal: 'silver',
          bestPearlCount: 4,
        },
        kelpworks: best,
        'blacksmoker-run': best,
      },
    });
  });

  it('is commutative, associative and idempotent, including empty records', () => {
    const third = updateProgress(emptyProgress(), {
      ...result,
      medal: 'gold',
      pearlCount: 0,
    });
    expect(mergeProgress(progress, other)).toEqual(
      mergeProgress(other, progress),
    );
    expect(mergeProgress(mergeProgress(progress, other), third)).toEqual(
      mergeProgress(progress, mergeProgress(other, third)),
    );
    expect(mergeProgress(progress, progress)).toEqual(progress);
    expect(mergeProgress(emptyProgress(), progress)).toEqual(progress);
  });

  it('returns a validated deep immutable copy without freezing or changing inputs', () => {
    const source = structuredClone(other);
    const merged = mergeProgress(progress, source);
    source.courses.kelpworks.bestPearlCount = 0;
    expect(merged.courses.kelpworks).toEqual(best);
    expect(Object.isFrozen(source.courses)).toBe(false);
    expect(Object.isFrozen(merged)).toBe(true);
    expect(Object.isFrozen(merged.courses)).toBe(true);
    for (const record of Object.values(merged.courses))
      expect(Object.isFrozen(record)).toBe(true);
    expect(parseProgress(merged)).toEqual(merged);
    expect(progress.courses['sunlit-shoals']).toEqual(best);
  });

  it('rejects invalid records on either side instead of sanitizing or dropping them', () => {
    expect(mergeProgress(progress, progress)).toEqual(progress);
    for (const invalid of [
      null,
      { ...progress, version: 2 },
      { version: 1, courses: { unknown: best } },
      { version: 1, courses: { kelpworks: { ...best, bestElapsedMs: NaN } } },
      { version: 1, courses: { kelpworks: { ...best, bestPearlCount: -1 } } },
      {
        version: 1,
        courses: { kelpworks: { ...best, bestMedal: 'platinum' } },
      },
    ]) {
      expect(() => mergeProgress(invalid, progress)).toThrow();
      expect(() => mergeProgress(progress, invalid)).toThrow();
    }
  });

  it.each([null, 'bronze', 'silver', 'gold'] as const)(
    'preserves the better medal against %s independently of time and pearls',
    (medal) => {
      const medals = [null, 'bronze', 'silver', 'gold'] as const;
      for (const candidate of medals) {
        const left = updateProgress(emptyProgress(), { ...result, medal });
        const right = updateProgress(emptyProgress(), {
          ...result,
          medal: candidate,
        });
        expect(
          mergeProgress(left, right).courses['sunlit-shoals']?.bestMedal,
        ).toBe(
          medals[Math.max(medals.indexOf(medal), medals.indexOf(candidate))],
        );
      }
    },
  );
});

describe('strict immutable v1 progression', () => {
  it('creates isolated frozen empty progress without additional persisted fields', () => {
    const empty = emptyProgress();
    expect(empty).toEqual({ version: 1, courses: {} });
    expect(Object.isFrozen(empty)).toBe(true);
    expect(Object.isFrozen(empty.courses)).toBe(true);
    expect(emptyProgress()).not.toBe(empty);
  });

  it('parses a deep immutable copy and retains fractional milliseconds', () => {
    const source = { version: 1, courses: { 'sunlit-shoals': { ...best } } };
    const parsed = parseProgress(source);
    source.courses['sunlit-shoals'].bestElapsedMs = 0;
    expect(parsed).toEqual(progress);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.courses)).toBe(true);
    expect(Object.isFrozen(parsed.courses['sunlit-shoals'])).toBe(true);
    expect(Object.isFrozen(source.courses)).toBe(false);
  });

  it.each([
    null,
    {},
    { ...progress, version: 2 },
    { ...progress, settings: {} },
    { version: 1, courses: [] },
    { version: 1, courses: { unknown: best } },
    { version: 1, courses: { 'sunlit-shoals': { ...best, history: [] } } },
    {
      version: 1,
      courses: { 'sunlit-shoals': { ...best, bestElapsedMs: -1 } },
    },
    {
      version: 1,
      courses: { 'sunlit-shoals': { ...best, bestElapsedMs: NaN } },
    },
    {
      version: 1,
      courses: { 'sunlit-shoals': { ...best, bestElapsedMs: Infinity } },
    },
    {
      version: 1,
      courses: { 'sunlit-shoals': { ...best, bestMedal: 'platinum' } },
    },
    {
      version: 1,
      courses: { 'sunlit-shoals': { ...best, bestMedal: undefined } },
    },
    {
      version: 1,
      courses: { 'sunlit-shoals': { ...best, bestPearlCount: 0.5 } },
    },
    {
      version: 1,
      courses: { 'sunlit-shoals': { ...best, bestPearlCount: -1 } },
    },
    {
      version: 1,
      courses: { 'sunlit-shoals': { ...best, bestPearlCount: 4097 } },
    },
    {
      version: 1,
      courses: {
        'sunlit-shoals': {
          ...best,
          bestPearlCount: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    },
    JSON.parse('{"version":1,"courses":{"__proto__":{}}}'),
  ])('rejects invalid progress at every public boundary %#', (input) => {
    expect(progressSchema.safeParse(input).success).toBe(false);
    expect(() => parseProgress(input)).toThrow();
    expect(() => updateProgress(input, result)).toThrow();
    expect(() => unlockedCourseIds(input)).toThrow();
  });

  it.each([
    null,
    {},
    { ...result, courseId: 'unknown' },
    { ...result, history: [] },
    { ...result, elapsedMs: -1 },
    { ...result, elapsedMs: NaN },
    { ...result, elapsedMs: Infinity },
    { ...result, elapsedMs: '123' },
    { ...result, medal: 'platinum' },
    { ...result, medal: undefined },
    { ...result, pearlCount: -1 },
    { ...result, pearlCount: 1.5 },
    { ...result, pearlCount: 5 },
    { ...result, pearlCount: Infinity },
    { ...result, totalPearls: -1 },
    { ...result, totalPearls: 1.5 },
    { ...result, totalPearls: 4097 },
    { ...result, totalPearls: Number.MAX_SAFE_INTEGER + 1 },
  ])('validates finished results before any merge %#', (input) => {
    const before = structuredClone(progress);
    expect(() => updateProgress(progress, input)).toThrow();
    expect(progress).toEqual(before);
  });

  it('accepts zero elapsed time, no medal and zero pearls', () => {
    expect(
      updateProgress(emptyProgress(), {
        ...result,
        elapsedMs: 0,
        medal: null,
        pearlCount: 0,
        totalPearls: 0,
      }).courses['sunlit-shoals'],
    ).toEqual({
      bestElapsedMs: 0,
      bestMedal: null,
      bestPearlCount: 0,
    });
  });

  it('accepts the maximum course pearl count', () => {
    expect(
      updateProgress(emptyProgress(), {
        ...result,
        pearlCount: 4096,
        totalPearls: 4096,
      }).courses['sunlit-shoals']?.bestPearlCount,
    ).toBe(4096);
  });
});

describe('independent best records and chained unlocks', () => {
  it.each([0.1, 1e-20])(
    'retains whole/endpoint records and unlocks at a %s second under-resolved fraction',
    (seconds) => {
      const elapsedMs = seconds * 1000;
      const course = {
        ...courseFixture(),
        checkpoints: [
          {
            id: 'finish',
            position: [0, 0, 0],
            direction: [1, 0, 0],
            radius: 1,
          },
        ],
        pearls: [],
        medalTimesMs: {
          gold: elapsedMs / 4,
          silver: elapsedMs / 2,
          bronze: elapsedMs,
        },
      };
      for (const delayMs of [0, 1e-9, 0.001]) {
        const whole = new RaceSession(course);
        const endpoint = new RaceSession(course);
        for (const race of [whole, endpoint]) {
          race.start();
          race.step([-seconds, 0, 0], [-seconds, 0, 0], delayMs / 1000);
        }
        whole.step([-seconds, 0, 0], [1e308, 0, 0], 1e308);
        endpoint.step([-seconds, 0, 0], [0, 0, 0], seconds);
        const expectedMedal = delayMs === 0 ? 'bronze' : null;
        const wholeProgress = updateProgress(
          emptyProgress(),
          whole.getState().result,
        );
        const endpointProgress = updateProgress(
          emptyProgress(),
          endpoint.getState().result,
        );
        expect.soft(wholeProgress).toEqual(endpointProgress);
        expect
          .soft(wholeProgress.courses['sunlit-shoals']?.bestMedal)
          .toBe(expectedMedal);
        expect
          .soft(unlockedCourseIds(wholeProgress))
          .toEqual(
            delayMs === 0 ? ['sunlit-shoals', 'kelpworks'] : ['sunlit-shoals'],
          );
        expect
          .soft(wholeProgress.courses['sunlit-shoals']?.bestElapsedMs)
          .toBe(whole.getState().elapsedMs);
      }
    },
  );

  it.each([24, 30, 60, 75, 90, 120, 144, 165, 240])(
    'preserves medals, unlocks and measured best times across full/clipped %s Hz partitions',
    (hz) => {
      for (const [seconds, boundaryMedal, slowerMedal] of [
        [12, 'gold', 'silver'],
        [18, 'silver', 'bronze'],
        [30, 'bronze', null],
      ] as const) {
        for (const clipped of [false, true]) {
          for (const delayMs of [0, 1e-9, 0.001]) {
            const whole = new RaceSession(courseFixture());
            const split = new RaceSession(courseFixture());
            const leadIn = clipped ? 1 / (2 * hz) : 0;
            // Exact integer coordinates isolate duration quantization.
            const startZ = 20 - 2 * seconds * hz + (clipped ? 1 : 0);
            for (const race of [whole, split]) {
              race.start();
              race.step(
                [0, -3, startZ],
                [0, -3, startZ],
                leadIn + delayMs / 1000,
              );
            }
            whole.step([0, -3, startZ], [0, -3, clipped ? 21 : 20], seconds);
            for (let index = 0; index < seconds * hz; index++) {
              split.step(
                [0, -3, startZ + 2 * index],
                [0, -3, startZ + 2 * (index + 1)],
                1 / hz,
              );
            }
            const medal = delayMs === 0 ? boundaryMedal : slowerMedal;
            const wholeProgress = updateProgress(
              emptyProgress(),
              whole.getState().result,
            );
            const splitProgress = updateProgress(
              emptyProgress(),
              split.getState().result,
            );
            for (const [race, progress] of [
              [whole, wholeProgress],
              [split, splitProgress],
            ] as const) {
              expect(progress.courses['sunlit-shoals']).toEqual({
                bestElapsedMs: race.getState().elapsedMs,
                bestMedal: medal,
                bestPearlCount: 1,
              });
              expect(unlockedCourseIds(progress)).toEqual(
                medal === null
                  ? ['sunlit-shoals']
                  : ['sunlit-shoals', 'kelpworks'],
              );
              expect(
                updateProgress(progress, {
                  ...race.getState().result,
                  elapsedMs: 60_000,
                  medal: null,
                  pearlCount: 0,
                }),
              ).toEqual(progress);
            }
            expect(
              splitProgress.courses['sunlit-shoals']?.bestElapsedMs,
            ).toBeCloseTo(
              wholeProgress.courses['sunlit-shoals']!.bestElapsedMs,
              9,
            );
          }
        }
      }
    },
  );

  it.each([
    [12, 'gold'],
    [18, 'silver'],
    [30, 'bronze'],
    [30.000001, null],
  ] as const)(
    'preserves unlocks and measured best records under 60 Hz partitioning at %s seconds',
    (seconds, medal) => {
      const whole = new RaceSession(courseFixture());
      const split = new RaceSession(courseFixture());
      whole.start();
      split.start();
      whole.step([0, -3, 0], [0, -3, 20], seconds);
      const frames = Math.floor(seconds * 60);
      for (let index = 0; index < frames; index++) {
        split.step(
          [0, -3, (20 * index) / frames],
          [0, -3, (20 * (index + 1)) / frames],
          seconds / frames,
        );
      }
      const wholeProgress = updateProgress(
        emptyProgress(),
        whole.getState().result,
      );
      const splitProgress = updateProgress(
        emptyProgress(),
        split.getState().result,
      );
      expect(splitProgress).toEqual({
        ...wholeProgress,
        courses: {
          'sunlit-shoals': {
            ...wholeProgress.courses['sunlit-shoals'],
            bestElapsedMs: scaledRatio(
              { numerator: BigInt(frames), denominator: 1n },
              seconds / frames,
              1000,
            ),
          },
        },
      });
      expect(splitProgress.courses['sunlit-shoals']?.bestMedal).toBe(medal);
      expect(unlockedCourseIds(splitProgress)).toEqual(
        medal === null ? ['sunlit-shoals'] : ['sunlit-shoals', 'kelpworks'],
      );
      const slower = {
        ...split.getState().result,
        elapsedMs: 60_000,
        medal: null,
      };
      expect(updateProgress(splitProgress, slower)).toEqual(splitProgress);
    },
  );

  it('updates from an actual finished race without modifying the result', () => {
    const race = new RaceSession(courseFixture());
    race.start();
    const finished = race.step([0, -3, 0], [0, -3, 40], 20).state.result;
    expect(finished).toMatchObject({
      elapsedMs: 10_000,
      medal: 'gold',
      pearlCount: 1,
    });
    const updated = updateProgress(emptyProgress(), finished);
    expect(updated.courses['sunlit-shoals']).toEqual({
      bestElapsedMs: 10_000,
      bestMedal: 'gold',
      bestPearlCount: 1,
    });
    expect(finished).toEqual(race.getState().result);
  });

  it('preserves time, medal and pearls independently even when they come from different runs', () => {
    const initial = updateProgress(emptyProgress(), result);
    const faster = updateProgress(initial, {
      ...result,
      elapsedMs: 1000,
      medal: null,
      pearlCount: 0,
    });
    const medal = updateProgress(faster, {
      ...result,
      elapsedMs: 2000,
      medal: 'gold',
      pearlCount: 1,
    });
    const pearls = updateProgress(medal, {
      ...result,
      elapsedMs: 30_000,
      medal: 'bronze',
      pearlCount: 4,
    });
    expect(pearls.courses['sunlit-shoals']).toEqual({
      bestElapsedMs: 1000,
      bestMedal: 'gold',
      bestPearlCount: 4,
    });
    expect(initial.courses['sunlit-shoals']).toEqual(best);
    expect(Object.isFrozen(pearls.courses['sunlit-shoals'])).toBe(true);
  });

  it('is idempotent for duplicates, ties and worse runs', () => {
    const initial = updateProgress(emptyProgress(), result);
    expect(initial).toEqual(progress);
    expect(updateProgress(initial, result)).toEqual(initial);
    expect(
      updateProgress(initial, {
        ...result,
        elapsedMs: 90_000,
        medal: null,
        pearlCount: 0,
      }),
    ).toEqual(initial);
  });

  it('merges course records independently without mutating either input', () => {
    const source = structuredClone(progress);
    const run = { ...result, courseId: 'kelpworks' };
    const updated = updateProgress(source, run);
    expect(updated.courses).toEqual({ 'sunlit-shoals': best, kelpworks: best });
    expect(source).toEqual(progress);
    expect(run).toEqual({ ...result, courseId: 'kelpworks' });
  });

  it('unlocks only Sunlit with no medal earned', () => {
    expect(unlockedCourseIds(emptyProgress())).toEqual(['sunlit-shoals']);
    const noMedal = updateProgress(emptyProgress(), { ...result, medal: null });
    expect(noMedal.courses['sunlit-shoals']?.bestMedal).toBeNull();
    expect(unlockedCourseIds(noMedal)).toEqual(['sunlit-shoals']);
    expect(Object.isFrozen(unlockedCourseIds(noMedal))).toBe(true);
  });

  it.each(['bronze', 'silver', 'gold'])(
    'unlocks the chain after %s or better',
    (medal) => {
      const first = updateProgress(emptyProgress(), { ...result, medal });
      expect(unlockedCourseIds(first)).toEqual(['sunlit-shoals', 'kelpworks']);
      const second = updateProgress(first, {
        ...result,
        courseId: 'kelpworks',
        medal,
      });
      expect(unlockedCourseIds(second)).toEqual([
        'sunlit-shoals',
        'kelpworks',
        'blacksmoker-run',
      ]);
      const worse = updateProgress(second, {
        ...result,
        elapsedMs: 90_000,
        medal: null,
      });
      expect(unlockedCourseIds(worse)).toEqual(unlockedCourseIds(second));
    },
  );

  it('does not skip the chain using orphan later-course records', () => {
    const orphan = updateProgress(emptyProgress(), {
      ...result,
      courseId: 'kelpworks',
      medal: 'gold',
    });
    expect(orphan.courses.kelpworks?.bestMedal).toBe('gold');
    expect(unlockedCourseIds(orphan)).toEqual(['sunlit-shoals']);
    const later = updateProgress(orphan, {
      ...result,
      courseId: 'blacksmoker-run',
      medal: 'gold',
    });
    expect(unlockedCourseIds(later)).toEqual(['sunlit-shoals']);
    const noFirstMedal = updateProgress(later, { ...result, medal: null });
    expect(unlockedCourseIds(noFirstMedal)).toEqual(['sunlit-shoals']);
    const restored = updateProgress(noFirstMedal, {
      ...result,
      medal: 'bronze',
    });
    expect(unlockedCourseIds(restored)).toEqual([
      'sunlit-shoals',
      'kelpworks',
      'blacksmoker-run',
    ]);
  });

  it('keeps Blacksmoker locked when Kelpworks has no medal', () => {
    const first = updateProgress(emptyProgress(), { ...result, medal: 'gold' });
    const second = updateProgress(first, {
      ...result,
      courseId: 'kelpworks',
      medal: null,
    });
    expect(unlockedCourseIds(second)).toEqual(['sunlit-shoals', 'kelpworks']);
  });
});
