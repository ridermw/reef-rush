import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSettingsStore } from '../../src/settings/SettingsStore';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { SETTINGS_STORAGE_KEY as key } from '../../src/settings/settingsStorage';

beforeEach(() => window.localStorage.removeItem(key));
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(key);
});

it('starts with stable immutable defaults, detached store methods, and no startup write', () => {
  const write = vi.spyOn(Storage.prototype, 'setItem');
  const { getState, subscribe, update } = createSettingsStore();
  const state = getState();
  expect(state).toEqual({
    settings: DEFAULT_SETTINGS,
    status: 'empty',
    notice: null,
    error: null,
  });
  expect(getState()).toBe(state);
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state.settings)).toBe(true);
  const listener = vi.fn();
  const unsubscribe = subscribe(listener);
  expect(listener).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  update({ masterVolume: 0.6 });
  expect(listener).toHaveBeenCalledOnce();
  expect(getState()).not.toBe(state);
  expect(state.settings.masterVolume).toBe(0.4);
  expect(Object.isFrozen(getState())).toBe(true);
  expect(Object.isFrozen(getState().settings)).toBe(true);
  unsubscribe();
  update({ musicEnabled: true });
  expect(listener).toHaveBeenCalledOnce();
});

it('loads valid stored settings without rewriting them', () => {
  const settings = { ...DEFAULT_SETTINGS, mouseSensitivity: 1.5 };
  const raw = `  ${JSON.stringify(settings)}  `;
  window.localStorage.setItem(key, raw);
  const write = vi.spyOn(Storage.prototype, 'setItem');
  expect(createSettingsStore().getState()).toEqual({
    settings,
    status: 'loaded',
    notice: null,
    error: null,
  });
  expect(write).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(key)).toBe(raw);
});

it.each([
  ['{bad', 'malformed-json'],
  [' {"version":42,"keep":true} ', 'unsupported-version'],
  [
    JSON.stringify({ ...DEFAULT_SETTINGS, musicEnabled: 'true' }),
    'invalid-schema',
  ],
] as const)(
  'shows defaults and an explicit notice while protecting %s',
  (raw, reason) => {
    window.localStorage.setItem(key, raw);
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const store = createSettingsStore();
    expect(store.getState()).toMatchObject({
      settings: DEFAULT_SETTINGS,
      status: 'invalid',
      error: { status: 'invalid', raw, reason },
    });
    expect(store.getState().notice).toMatch(/invalid.*preserved.*session/i);
    expect(write).not.toHaveBeenCalled();
    store.update({ mouseSensitivity: 2 });
    expect(store.getState()).toMatchObject({
      settings: { ...DEFAULT_SETTINGS, mouseSensitivity: 2 },
      status: 'session-only',
      error: { code: 'invalid-save', cause: { raw, reason } },
    });
    expect(store.getState().notice).toMatch(/invalid.*preserved.*session/i);
    expect(write).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(key)).toBe(raw);
  },
);

it('shows unavailable storage explicitly and still applies valid session changes', () => {
  const cause = new DOMException('Denied', 'SecurityError');
  const store = createSettingsStore(() => {
    throw cause;
  });
  expect(store.getState()).toMatchObject({
    settings: DEFAULT_SETTINGS,
    status: 'unavailable',
    error: { status: 'unavailable', cause },
  });
  expect(store.getState().notice).toMatch(/unavailable.*session/i);
  store.update({ sfxEnabled: false });
  expect(store.getState()).toMatchObject({
    settings: { ...DEFAULT_SETTINGS, sfxEnabled: false },
    status: 'session-only',
    error: { code: 'unavailable', cause },
  });
  expect(store.getState().notice).toMatch(/unavailable.*session/i);
});

it('publishes once per update after applying and persisting the full session configuration', () => {
  const store = createSettingsStore();
  const listener = vi.fn(() => {
    expect(store.getState()).toMatchObject({
      status: 'saved',
      notice: null,
      error: null,
    });
    expect(JSON.parse(window.localStorage.getItem(key) ?? 'null')).toEqual(
      store.getState().settings,
    );
  });
  store.subscribe(listener);
  store.update({ masterVolume: 0.1, reducedMotion: true });
  store.update({ musicEnabled: true });
  expect(store.getState().settings).toEqual({
    ...DEFAULT_SETTINGS,
    masterVolume: 0.1,
    reducedMotion: true,
    musicEnabled: true,
  });
  expect(listener).toHaveBeenCalledTimes(2);
});

it.each([
  { version: 1 },
  { unknown: true },
  { masterVolume: NaN },
  { masterVolume: 1.1 },
  { mouseSensitivity: 0.1 },
  { mouseSteering: 'false' },
  { invertMouseY: undefined },
  null,
])(
  'rejects invalid patches before state, storage, or subscriber changes %#',
  (patch) => {
    const provider = vi.fn(() => window.localStorage);
    const store = createSettingsStore(provider);
    const before = store.getState();
    const subscriber = vi.fn();
    const write = vi.spyOn(Storage.prototype, 'setItem');
    store.subscribe(subscriber);
    provider.mockClear();
    expect(() => store.update(patch)).toThrow();
    expect(store.getState()).toBe(before);
    expect(provider).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
  },
);

it('retains session changes and failure notice across quota errors, then recovers on a later update', () => {
  const store = createSettingsStore();
  const cause = new DOMException('Full', 'QuotaExceededError');
  const write = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw cause;
    });
  const listener = vi.fn();
  store.subscribe(listener);
  store.update({ masterVolume: 0.2 });
  const failed = store.getState();
  expect(failed).toMatchObject({
    settings: { ...DEFAULT_SETTINGS, masterVolume: 0.2 },
    status: 'session-only',
    error: { code: 'write-failed', cause },
  });
  expect(failed.notice).toMatch(/could not save.*session/i);
  expect(store.getState()).toBe(failed);
  store.update({ musicEnabled: true });
  expect(store.getState().status).toBe('session-only');
  expect(store.getState().notice).not.toBeNull();
  expect(listener).toHaveBeenCalledTimes(2);
  write.mockRestore();
  store.update({});
  expect(store.getState()).toEqual({
    settings: { ...DEFAULT_SETTINGS, masterVolume: 0.2, musicEnabled: true },
    status: 'saved',
    notice: null,
    error: null,
  });
  expect(JSON.parse(window.localStorage.getItem(key) ?? 'null')).toEqual(
    store.getState().settings,
  );
  expect(listener).toHaveBeenCalledTimes(3);
});

it('recovers after invalid storage is replaced by valid data, with whole-configuration last-writer semantics', () => {
  window.localStorage.setItem(key, '{"version":3}');
  const store = createSettingsStore();
  store.update({ mouseSteering: false });
  window.localStorage.setItem(
    key,
    JSON.stringify({ ...DEFAULT_SETTINGS, musicEnabled: true }),
  );
  store.update({ masterVolume: 0.6 });
  expect(store.getState()).toEqual({
    settings: { ...DEFAULT_SETTINGS, mouseSteering: false, masterVolume: 0.6 },
    status: 'saved',
    notice: null,
    error: null,
  });
  expect(JSON.parse(window.localStorage.getItem(key) ?? 'null')).toEqual(
    store.getState().settings,
  );
});

it('recovers from an unavailable provider without losing session values', () => {
  let available = false;
  const store = createSettingsStore(() => {
    if (!available) throw new DOMException('Denied', 'SecurityError');
    return window.localStorage;
  });
  store.update({ invertMouseY: true });
  available = true;
  store.update({ sfxEnabled: false });
  expect(store.getState()).toMatchObject({
    settings: { ...DEFAULT_SETTINGS, invertMouseY: true, sfxEnabled: false },
    status: 'saved',
    error: null,
    notice: null,
  });
});

it('does not reinterpret subscriber exceptions as persistence failures', () => {
  const store = createSettingsStore();
  const cause = new Error('Subscriber bug');
  store.subscribe(() => {
    throw cause;
  });
  expect(() => store.update({ musicEnabled: true })).toThrow(cause);
  expect(store.getState()).toMatchObject({
    settings: { musicEnabled: true },
    status: 'saved',
    notice: null,
    error: null,
  });
});

it('never reads or writes progress through startup or updates', () => {
  const values = new Map([['reef-rush.progress', 'preserve these raw bytes']]);
  const getItem = vi.fn((key: string) => values.get(key) ?? null);
  const setItem = vi.fn((key: string, value: string) => {
    values.set(key, value);
  });
  const store = createSettingsStore(() => ({ getItem, setItem }));
  store.update({ reducedMotion: true });
  expect(getItem.mock.calls).toEqual([[key], [key]]);
  expect(setItem).toHaveBeenCalledExactlyOnceWith(
    key,
    JSON.stringify(store.getState().settings),
  );
  expect(values.get('reef-rush.progress')).toBe('preserve these raw bytes');
});
