import type {
  StorageLike,
  StorageProvider,
} from '../game/save/progressStorage';
import {
  DEFAULT_SETTINGS,
  parseSettings,
  settingsReadSchema,
  type Settings,
} from './settings';

export const SETTINGS_STORAGE_KEY = 'reef-rush.settings';

export type SettingsRead =
  | { readonly status: 'empty' | 'loaded'; readonly settings: Settings }
  | {
      readonly status: 'invalid';
      readonly reason:
        'unsupported-version' | 'malformed-json' | 'invalid-schema';
      readonly raw: string;
      readonly cause: unknown;
    }
  | { readonly status: 'unavailable'; readonly cause: unknown };

export class SettingsStorageError extends Error {
  constructor(
    readonly code: 'unavailable' | 'invalid-save' | 'write-failed',
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'SettingsStorageError';
  }
}

function browserStorage(): StorageLike {
  return window.localStorage;
}

export function readSettings(
  provider: StorageProvider = browserStorage,
): SettingsRead {
  let raw: string | null;
  try {
    raw = provider().getItem(SETTINGS_STORAGE_KEY);
  } catch (cause) {
    return Object.freeze({ status: 'unavailable', cause });
  }
  if (raw === null) {
    return Object.freeze({ status: 'empty', settings: DEFAULT_SETTINGS });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (cause) {
    return Object.freeze<SettingsRead>({
      status: 'invalid',
      reason: 'malformed-json',
      raw,
      cause,
    });
  }
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'version' in payload &&
    typeof payload.version === 'number' &&
    Number.isSafeInteger(payload.version) &&
    payload.version !== 1 &&
    payload.version !== 2
  ) {
    return Object.freeze({
      status: 'invalid',
      reason: 'unsupported-version',
      raw,
      cause: new Error(`Unsupported settings version: ${payload.version}.`),
    });
  }
  const parsed = settingsReadSchema.safeParse(payload);
  if (!parsed.success) {
    return Object.freeze({
      status: 'invalid',
      reason: 'invalid-schema',
      raw,
      cause: parsed.error,
    });
  }
  return Object.freeze({ status: 'loaded', settings: parsed.data });
}

/** Whole-configuration last writer wins; this does not coordinate tabs. */
export function saveSettings(
  input: unknown,
  provider: StorageProvider = browserStorage,
): void {
  const settings = parseSettings(input);
  let storage: StorageLike;
  try {
    storage = provider();
  } catch (cause) {
    throw new SettingsStorageError(
      'unavailable',
      'Settings storage is unavailable.',
      cause,
    );
  }
  const current = readSettings(() => storage);
  if (current.status === 'unavailable') {
    throw new SettingsStorageError(
      'unavailable',
      'Settings storage is unavailable.',
      current.cause,
    );
  }
  if (current.status === 'invalid') {
    throw new SettingsStorageError(
      'invalid-save',
      'Refusing to overwrite an invalid settings save.',
      current,
    );
  }
  const serialized = JSON.stringify(settings);
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, serialized);
  } catch (cause) {
    throw new SettingsStorageError(
      'write-failed',
      'Failed to save settings.',
      cause,
    );
  }
}
