import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROGRESS_STORAGE_KEY,
  readProgress,
  saveProgress,
  type StorageLike,
} from '../../src/game/save/progressStorage';
import {
  emptyProgress,
  unlockedCourseIds,
  updateProgress,
} from '../../src/game/progression/progress';
import { RaceSession } from '../../src/game/race/RaceSession';
import { courseFixture } from '../fixtures/courseDefinition';

const key = 'reef-rush.progress';
const unrelated = 'reef-rush.unrelated-test-key';
const progress = updateProgress(emptyProgress(), {
  courseId: 'sunlit-shoals',
  elapsedMs: 12_345.678,
  medal: 'silver',
  pearlCount: 2,
  totalPearls: 4,
});

beforeEach(() => {
  window.localStorage.removeItem(key);
  window.localStorage.removeItem(unrelated);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.removeItem(key);
  window.localStorage.removeItem(unrelated);
});

describe('versioned browser saves', () => {
  it.each(
    [1, 2, 4, 8, 16, 2 ** 52, 2 ** 1022].flatMap((scale) =>
      [3, 8].map((bronzeUnits) => ({ scale, bronzeUnits })),
    ),
  )(
    'never persists or unlocks a false medal from a rounded interval: scale $scale bronze $bronzeUnits units',
    ({ scale, bronzeUnits }) => {
      const unit = Number.MIN_VALUE * scale;
      const race = new RaceSession({
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
          gold: unit,
          silver: 2 * unit,
          bronze: bronzeUnits * unit,
        },
      });
      race.start();
      const result = race.step([-0.1, 0, 0], [1e308, 0, 0], 4e-17 * scale).state
        .result;
      expect.soft(result?.medal).toBeNull();
      const current = updateProgress(emptyProgress(), result);
      expect.soft(current.courses['sunlit-shoals']).toEqual({
        bestElapsedMs: result?.elapsedMs,
        bestMedal: null,
        bestPearlCount: 0,
      });
      expect.soft(unlockedCourseIds(current)).toEqual(['sunlit-shoals']);
      saveProgress(current);
      const loaded = readProgress();
      expect(loaded).toEqual({ status: 'loaded', progress: current });
      if (loaded.status !== 'loaded')
        throw new Error('Expected loaded progress.');
      expect
        .soft(loaded.progress.courses['sunlit-shoals']?.bestMedal)
        .toBeNull();
      expect
        .soft(unlockedCourseIds(loaded.progress))
        .toEqual(['sunlit-shoals']);
      expect
        .soft(JSON.parse(window.localStorage.getItem(key) ?? 'null'))
        .toMatchObject({
          courses: { 'sunlit-shoals': { bestMedal: null } },
        });
    },
  );

  it.each([
    {
      mode: 'subnormal dt',
      dt: Number.MIN_VALUE,
      start: -1,
      end: 3,
      elapsedMs: Number.MIN_VALUE * 250,
      fasterDt: Number.MIN_VALUE,
      fasterEnd: 7,
      fasterMs: Number.MIN_VALUE * 125,
    },
    {
      mode: 'normal dt with an under-resolved intersection',
      dt: 1e-15,
      start: -0.1,
      end: 1e308,
      elapsedMs: Number.MIN_VALUE * 202,
      fasterDt: 5e-16,
      fasterEnd: 1e308,
      fasterMs: Number.MIN_VALUE * 101,
    },
  ])(
    'round-trips positive records without a false unlock or an unbeatable zero: $mode',
    ({ dt, start, end, elapsedMs, fasterDt, fasterEnd, fasterMs }) => {
      const finishRace = (duration: number, endpoint: number) => {
        const race = new RaceSession({
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
          medalTimesMs: { gold: 1e-322, silver: 2e-322, bronze: 4e-322 },
        });
        race.start();
        return race.step([start, 0, 0], [endpoint, 0, 0], duration).state
          .result;
      };
      const first = updateProgress(emptyProgress(), finishRace(dt, end));
      expect.soft(first.courses['sunlit-shoals']).toEqual({
        bestElapsedMs: elapsedMs,
        bestMedal: null,
        bestPearlCount: 0,
      });
      expect.soft(unlockedCourseIds(first)).toEqual(['sunlit-shoals']);
      saveProgress(first);
      const loaded = readProgress();
      expect.soft(loaded).toEqual({ status: 'loaded', progress: first });
      if (loaded.status !== 'loaded')
        throw new Error('Expected loaded progress.');
      expect
        .soft(loaded.progress.courses['sunlit-shoals']?.bestElapsedMs)
        .toBe(elapsedMs);
      expect
        .soft(unlockedCourseIds(loaded.progress))
        .toEqual(['sunlit-shoals']);

      const improved = updateProgress(
        loaded.progress,
        finishRace(fasterDt, fasterEnd),
      );
      expect
        .soft(improved.courses['sunlit-shoals']?.bestElapsedMs)
        .toBe(fasterMs);
      expect
        .soft(improved.courses['sunlit-shoals']?.bestElapsedMs)
        .toBeLessThan(elapsedMs);
      saveProgress(improved);
      expect(readProgress()).toEqual({ status: 'loaded', progress: improved });
    },
  );

  it('round-trips immutable v1 progress in actual jsdom Storage at one stable key', () => {
    expect(PROGRESS_STORAGE_KEY).toBe(key);
    window.localStorage.setItem(unrelated, 'keep');
    saveProgress(progress);
    const raw = window.localStorage.getItem(key);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? 'null')).toEqual(progress);
    const loaded = readProgress();
    expect(loaded).toEqual({ status: 'loaded', progress });
    expect(Object.isFrozen(loaded)).toBe(true);
    if (loaded.status !== 'loaded')
      throw new Error('Expected loaded progress.');
    expect(Object.isFrozen(loaded.progress.courses)).toBe(true);
    expect(window.localStorage.getItem(unrelated)).toBe('keep');
    expect(window.localStorage.getItem(`${key}.v1`)).toBeNull();
  });

  it('returns empty progress without writing it', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    expect(readProgress()).toEqual({
      status: 'empty',
      progress: emptyProgress(),
    });
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('writes explicitly requested empty progress with its version intact', () => {
    saveProgress(emptyProgress());
    expect(window.localStorage.getItem(key)).toBe('{"version":1,"courses":{}}');
    expect(readProgress()).toEqual({
      status: 'loaded',
      progress: emptyProgress(),
    });
  });

  it('replaces a valid existing payload with another validated payload', () => {
    window.localStorage.setItem(key, JSON.stringify(emptyProgress()));
    saveProgress(progress, () => window.localStorage);
    expect(readProgress()).toEqual({ status: 'loaded', progress });
  });

  it.each([
    ['{bad json', 'malformed-json'],
    ['', 'malformed-json'],
    ['{"version":2,"courses":{}}', 'unsupported-version'],
    ['  {"version":99,"future":{"keep":true}}  ', 'unsupported-version'],
    ['{"version":0,"courses":{}}', 'unsupported-version'],
    ['{"version":"1","courses":{}}', 'invalid-schema'],
    ['{"version":1,"courses":{"unknown":{}}}', 'invalid-schema'],
    ['{"version":1,"courses":{"__proto__":{}}}', 'invalid-schema'],
    ['{"version":1,"courses":{},"settings":{}}', 'invalid-schema'],
    [
      '{"version":1,"courses":{"sunlit-shoals":{"bestElapsedMs":-1,"bestMedal":"gold","bestPearlCount":2}}}',
      'invalid-schema',
    ],
    ['null', 'invalid-schema'],
    ['[]', 'invalid-schema'],
    ['{}', 'invalid-schema'],
  ] as const)(
    'preserves invalid raw content %s (%s) on reads AND writes',
    (raw, reason) => {
      window.localStorage.setItem(key, raw);
      window.localStorage.setItem(unrelated, 'keep');
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
      const read = readProgress();
      expect(read).toMatchObject({ status: 'invalid', reason, raw });
      expect(read).toHaveProperty('cause');
      expect(() => saveProgress(progress)).toThrow(/invalid.*save/i);
      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(key)).toBe(raw);
      expect(window.localStorage.getItem(unrelated)).toBe('keep');
    },
  );

  it.each([
    {},
    { ...progress, version: 2 },
    { ...progress, courses: { unknown: {} } },
    {
      version: 1,
      courses: {
        'sunlit-shoals': {
          bestElapsedMs: Infinity,
          bestMedal: 'gold',
          bestPearlCount: 0,
        },
      },
    },
  ])('rejects invalid writes before obtaining storage %#', (invalid) => {
    const raw = JSON.stringify(progress);
    window.localStorage.setItem(key, raw);
    const provider = vi.fn(() => window.localStorage);
    expect(() => saveProgress(invalid, provider)).toThrow();
    expect(provider).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(key)).toBe(raw);
  });

  it('exposes provider acquisition failures on both reads and writes', () => {
    const cause = new DOMException('Access denied', 'SecurityError');
    const provider = () => {
      throw cause;
    };
    expect(readProgress(provider)).toEqual({ status: 'unavailable', cause });
    expect(() => saveProgress(progress, provider)).toThrow(/unavailable/i);
    expect(() => saveProgress(progress, provider)).toThrow(
      expect.objectContaining({ cause }),
    );
  });

  it('captures SecurityError from the real localStorage property getter lazily', async () => {
    const cause = new DOMException('Blocked getter', 'SecurityError');
    const getter = vi
      .spyOn(window, 'localStorage', 'get')
      .mockImplementation(() => {
        throw cause;
      });
    vi.resetModules();
    const storage = await import('../../src/game/save/progressStorage');
    expect(getter).not.toHaveBeenCalled();
    expect(storage.readProgress()).toEqual({ status: 'unavailable', cause });
    expect(() => storage.saveProgress(progress)).toThrow(
      expect.objectContaining({ cause }),
    );
  });

  it('captures getItem failures and never attempts a write when the existing save is unreadable', () => {
    const cause = new DOMException('Blocked read', 'SecurityError');
    const storage: StorageLike = {
      getItem: () => {
        throw cause;
      },
      setItem: vi.fn(),
    };
    expect(readProgress(() => storage)).toEqual({
      status: 'unavailable',
      cause,
    });
    expect(() => saveProgress(progress, () => storage)).toThrow(
      expect.objectContaining({ cause }),
    );
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each(['QuotaExceededError', 'SecurityError'])(
    'surfaces %s on setItem with the original cause and old save intact',
    (name) => {
      const raw = JSON.stringify(emptyProgress());
      window.localStorage.setItem(key, raw);
      const cause = new DOMException('Write failed', name);
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw cause;
      });
      expect(() => saveProgress(progress)).toThrow(/failed to save/i);
      expect(() => saveProgress(progress)).toThrow(
        expect.objectContaining({ cause }),
      );
      expect(window.localStorage.getItem(key)).toBe(raw);
    },
  );

  it('uses the same provided storage object for read-before-write without reopening it', () => {
    const provider = vi.fn(() => window.localStorage);
    saveProgress(progress, provider);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(progress));
  });

  it('imports without window in SSR and reports storage unavailable instead of crashing', async () => {
    vi.stubGlobal('window', undefined);
    vi.resetModules();
    const storage = await import('../../src/game/save/progressStorage');
    expect(storage.readProgress()).toMatchObject({ status: 'unavailable' });
    expect(() => storage.saveProgress(progress)).toThrow(/unavailable/i);
  });
});
