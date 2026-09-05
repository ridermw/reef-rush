import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StorageLike } from '../../src/game/save/progressStorage';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import {
  readSettings,
  saveSettings,
  SETTINGS_STORAGE_KEY,
  SettingsStorageError,
} from '../../src/settings/settingsStorage';

const key = 'reef-rush.settings';

beforeEach(() => window.localStorage.removeItem(key));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.removeItem(key);
});

it('returns immutable empty defaults without a startup write', () => {
  const write = vi.spyOn(Storage.prototype, 'setItem');
  const remove = vi.spyOn(Storage.prototype, 'removeItem');
  const result = readSettings();
  expect(result).toEqual({ status: 'empty', settings: DEFAULT_SETTINGS });
  expect(Object.isFrozen(result)).toBe(true);
  expect(write).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(key)).toBeNull();
});

it('round-trips immutable settings at exactly one key without touching progress', () => {
  expect(SETTINGS_STORAGE_KEY).toBe(key);
  const progressRaw = 'untouched progress bytes';
  const values = new Map([['reef-rush.progress', progressRaw]]);
  const storage: StorageLike = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const settings = { ...DEFAULT_SETTINGS, musicEnabled: true };
  saveSettings(settings, () => storage);
  const read = readSettings(() => storage);
  expect(read).toEqual({ status: 'loaded', settings });
  expect(Object.isFrozen(read)).toBe(true);
  if (read.status !== 'loaded') throw new Error('Expected loaded settings.');
  expect(Object.isFrozen(read.settings)).toBe(true);
  expect(values.get('reef-rush.progress')).toBe(progressRaw);
  expect(storage.getItem).toHaveBeenCalledTimes(2);
  expect(storage.getItem).toHaveBeenNthCalledWith(1, key);
  expect(storage.getItem).toHaveBeenNthCalledWith(2, key);
  expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
    key,
    JSON.stringify(settings),
  );
});

it.each([
  ['{bad', 'malformed-json'],
  ['', 'malformed-json'],
  ['  {"version":3,"future":"keep"}  ', 'unsupported-version'],
  ['{"version":2}', 'invalid-schema'],
  ['{"version":1,"renderQuality":"low"}', 'invalid-schema'],
  ['{"version":99}', 'unsupported-version'],
  ['{"version":0}', 'unsupported-version'],
  ['{"version":"1"}', 'invalid-schema'],
  ['null', 'invalid-schema'],
  ['[]', 'invalid-schema'],
  ['{}', 'invalid-schema'],
  [JSON.stringify({ ...DEFAULT_SETTINGS, masterVolume: -1 }), 'invalid-schema'],
  [JSON.stringify({ ...DEFAULT_SETTINGS, sfxEnabled: 1 }), 'invalid-schema'],
  [JSON.stringify({ ...DEFAULT_SETTINGS, unexpected: true }), 'invalid-schema'],
] as const)(
  'preserves invalid raw %s on read and rechecks it before writing',
  (raw, reason) => {
    expect(readSettings().status).toBe('empty');
    // The protected value arrives after an earlier successful read.
    window.localStorage.setItem(key, raw);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const read = readSettings();
    expect(read).toMatchObject({ status: 'invalid', reason, raw });
    expect(read).toHaveProperty('cause');
    expect(Object.isFrozen(read)).toBe(true);
    expect(() => saveSettings(DEFAULT_SETTINGS)).toThrow(SettingsStorageError);
    expect(() => saveSettings(DEFAULT_SETTINGS)).toThrow(
      expect.objectContaining<{ code: string; cause: unknown }>({
        code: 'invalid-save',
        cause: expect.objectContaining({ status: 'invalid', reason, raw }),
      }),
    );
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(key)).toBe(raw);
  },
);

it.each([
  {},
  { ...DEFAULT_SETTINGS, version: 3 },
  { ...DEFAULT_SETTINGS, masterVolume: NaN },
  { ...DEFAULT_SETTINGS, mouseSensitivity: Infinity },
  { ...DEFAULT_SETTINGS, extra: true },
])('validates input before acquiring storage %#', (input) => {
  const provider = vi.fn(() => window.localStorage);
  expect(() => saveSettings(input, provider)).toThrow();
  expect(provider).not.toHaveBeenCalled();
});

it('reports provider failures with the original cause', () => {
  const cause = new DOMException('Blocked', 'SecurityError');
  const provider = () => {
    throw cause;
  };
  expect(readSettings(provider)).toEqual({ status: 'unavailable', cause });
  expect(() => saveSettings(DEFAULT_SETTINGS, provider)).toThrow(
    expect.objectContaining({ code: 'unavailable', cause }),
  );
});

it('reads exact legacy bytes without writing and saves normalized v2 only explicitly', () => {
  const legacy = {
    version: 1,
    masterVolume: 0.7,
    sfxEnabled: false,
    musicEnabled: true,
    mouseSteering: false,
    mouseSensitivity: 1.5,
    invertMouseY: true,
    reducedMotion: true,
  };
  const raw = `  ${JSON.stringify(legacy)}\n`;
  window.localStorage.setItem(key, raw);
  const write = vi.spyOn(Storage.prototype, 'setItem');
  const normalized = { ...legacy, version: 2, renderQuality: 'high' };
  expect(readSettings()).toEqual({ status: 'loaded', settings: normalized });
  expect(write).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(key)).toBe(raw);
  saveSettings(legacy);
  expect(write).toHaveBeenCalledExactlyOnceWith(
    key,
    JSON.stringify(normalized),
  );
});

it('reports getItem failures and refuses to write unreadable storage', () => {
  const cause = new DOMException('Blocked read', 'SecurityError');
  const storage: StorageLike = {
    getItem: () => {
      throw cause;
    },
    setItem: vi.fn(),
  };
  expect(readSettings(() => storage)).toEqual({ status: 'unavailable', cause });
  expect(() => saveSettings(DEFAULT_SETTINGS, () => storage)).toThrow(
    expect.objectContaining({ code: 'unavailable', cause }),
  );
  expect(storage.setItem).not.toHaveBeenCalled();
});

it.each(['QuotaExceededError', 'SecurityError'])(
  'surfaces %s and preserves the old raw save',
  (name) => {
    const raw = JSON.stringify(DEFAULT_SETTINGS);
    window.localStorage.setItem(key, raw);
    const cause = new DOMException('Write failed', name);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw cause;
    });
    expect(() =>
      saveSettings({ ...DEFAULT_SETTINGS, masterVolume: 0.2 }),
    ).toThrow(expect.objectContaining({ code: 'write-failed', cause }));
    expect(window.localStorage.getItem(key)).toBe(raw);
  },
);

it('acquires storage once and writes the entire validated configuration, not a merge', () => {
  window.localStorage.setItem(
    key,
    JSON.stringify({ ...DEFAULT_SETTINGS, musicEnabled: true }),
  );
  const provider = vi.fn(() => window.localStorage);
  saveSettings({ ...DEFAULT_SETTINGS, masterVolume: 0.2 }, provider);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(readSettings()).toEqual({
    status: 'loaded',
    settings: { ...DEFAULT_SETTINGS, masterVolume: 0.2 },
  });
});

it('accesses the localStorage getter lazily and exposes its failure', async () => {
  const cause = new DOMException('Blocked getter', 'SecurityError');
  const getter = vi
    .spyOn(window, 'localStorage', 'get')
    .mockImplementation(() => {
      throw cause;
    });
  vi.resetModules();
  const storage = await import('../../src/settings/settingsStorage');
  expect(getter).not.toHaveBeenCalled();
  expect(storage.readSettings()).toEqual({ status: 'unavailable', cause });
  expect(() => storage.saveSettings(DEFAULT_SETTINGS)).toThrow(
    expect.objectContaining({ code: 'unavailable', cause }),
  );
});

it('imports without window and reports storage unavailable', async () => {
  vi.stubGlobal('window', undefined);
  vi.resetModules();
  const storage = await import('../../src/settings/settingsStorage');
  expect(storage.readSettings()).toMatchObject({ status: 'unavailable' });
  expect(() => storage.saveSettings(DEFAULT_SETTINGS)).toThrow(/unavailable/i);
});
