import { describe, expect, it, vi } from 'vitest';
import {
  PROGRESS_STORAGE_KEY,
  replaceInvalidProgress,
  saveProgress,
  serializeProgressBackup,
  type StorageLike,
} from '../../src/game/save/progressStorage';
import {
  emptyProgress,
  updateProgress,
} from '../../src/game/progression/progress';

const earned = updateProgress(emptyProgress(), {
  courseId: 'sunlit-shoals',
  elapsedMs: 42000,
  medal: null,
  pearlCount: 4,
  totalPearls: 4,
});

function memory(raw: string | null) {
  const state = { raw };
  const storage: StorageLike = {
    getItem: vi.fn(() => state.raw),
    setItem: vi.fn<StorageLike['setItem']>((_key, value) => {
      state.raw = value;
    }),
  };
  const provider = vi.fn(() => storage);
  return { state, storage, provider };
}

describe('explicit invalid progress replacement', () => {
  it.each(['{broken', '', '{"version":1,"courses":{"unknown":{}}}', 'null'])(
    'replaces only the exact inspected invalid raw value: %s',
    (raw) => {
      const m = memory(raw);
      expect(() => saveProgress(earned, m.provider)).toThrow(/invalid/);
      m.provider.mockClear();
      expect(replaceInvalidProgress?.(raw, earned, m.provider)).toEqual({
        status: 'replaced',
      });
      expect(m.provider).toHaveBeenCalledOnce();
      expect(m.storage.getItem).toHaveBeenLastCalledWith(PROGRESS_STORAGE_KEY);
      expect(m.storage.setItem).toHaveBeenCalledExactlyOnceWith(
        PROGRESS_STORAGE_KEY,
        JSON.stringify(earned),
      );
      expect(m.state.raw).toBe(JSON.stringify(earned));
    },
  );

  it.each([
    ['{different', 'changed'],
    [JSON.stringify(earned), 'loaded'],
    [null, 'empty'],
    ['{"version":99,"secret":"keep"}', 'unsupported-version'],
  ])('refuses a now %s save with explicit outcome %s', (raw, status) => {
    const m = memory(raw);
    expect(replaceInvalidProgress?.('{broken', earned, m.provider)).toEqual({
      status,
    });
    expect(m.storage.setItem).not.toHaveBeenCalled();
    expect(m.state.raw).toBe(raw);
  });

  it('refuses an exactly matching future version even through the storage API', () => {
    const raw = '{"version":2,"future":true}';
    const m = memory(raw);
    expect(replaceInvalidProgress?.(raw, earned, m.provider)).toEqual({
      status: 'unsupported-version',
    });
    expect(m.storage.setItem).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, earned],
    [42, earned],
    ['{broken', {}],
    ['{broken', { version: 2, courses: {} }],
  ])(
    'validates the authorization and replacement before storage %#',
    (raw, value) => {
      const m = memory('{broken');
      const result = replaceInvalidProgress(raw, value, m.provider);
      expect(result).toMatchObject({
        status: 'invalid-request',
      });
      expect(result).toHaveProperty('cause');
      expect(m.provider).not.toHaveBeenCalled();
    },
  );

  it.each(['provider', 'read', 'write'])(
    'surfaces %s failure without damaging raw data',
    (failure) => {
      const m = memory('{broken');
      const cause = new Error(`${failure} denied`);
      const deny = () => {
        throw cause;
      };
      if (failure === 'provider') m.provider.mockImplementation(deny);
      if (failure === 'read')
        vi.mocked(m.storage.getItem).mockImplementation(deny);
      if (failure === 'write')
        vi.mocked(m.storage.setItem).mockImplementation(deny);
      expect(replaceInvalidProgress?.('{broken', earned, m.provider)).toEqual({
        status: failure === 'write' ? 'write-failed' : 'unavailable',
        cause,
      });
      expect(m.state.raw).toBe('{broken');
    },
  );

  it('rechecks cancellation immediately before the write', () => {
    const m = memory('{broken');
    const request = new AbortController();
    vi.mocked(m.storage.getItem).mockImplementation(() => {
      request.abort();
      return m.state.raw;
    });
    expect(
      replaceInvalidProgress?.('{broken', earned, m.provider, request.signal),
    ).toEqual({
      status: 'cancelled',
    });
    expect(m.storage.setItem).not.toHaveBeenCalled();
  });
});

describe('lossless local progress backup', () => {
  it('round-trips raw UTF-16 including lone surrogates through a JSON envelope and UTF-8', () => {
    const raw = '  {broken\n\ud800</script>\udfff\u0000\ud83e\udeb8';
    expect(serializeProgressBackup).toBeTypeOf('function');
    const serialized = serializeProgressBackup(raw);
    const downloaded = new TextDecoder().decode(
      new TextEncoder().encode(serialized),
    );
    expect(JSON.parse(downloaded)).toEqual({
      format: 'reef-rush.progress-backup',
      version: 1,
      raw,
    });
  });
});
