import type { StorageProvider } from '../game/save/progressStorage';
import {
  DEFAULT_SETTINGS,
  parseSettings,
  settingsPatchSchema,
  type Settings,
} from './settings';
import {
  readSettings,
  saveSettings,
  SettingsStorageError,
  type SettingsRead,
} from './settingsStorage';

export interface SettingsSnapshot {
  readonly settings: Settings;
  readonly status: SettingsRead['status'] | 'saved' | 'session-only';
  readonly notice: string | null;
  readonly error:
    | Extract<SettingsRead, { status: 'invalid' | 'unavailable' }>
    | SettingsStorageError
    | null;
}

export interface SettingsStore {
  getState: () => SettingsSnapshot;
  subscribe: (listener: () => void) => () => void;
  update: (patch: unknown) => void;
}

function failureNotice(code: SettingsStorageError['code']): string {
  switch (code) {
    case 'invalid-save':
      return 'Invalid existing settings preserved. Preferences apply only in this session.';
    case 'unavailable':
      return 'Settings storage is unavailable. Preferences apply only in this session.';
    case 'write-failed':
      return 'Could not save settings. Preferences apply only in this session.';
  }
}

/** Updates replace the saved configuration; even an empty patch retries persistence. */
export function createSettingsStore(provider?: StorageProvider): SettingsStore {
  const initial = readSettings(provider);
  let state: SettingsSnapshot;
  if (initial.status === 'invalid' || initial.status === 'unavailable') {
    state = Object.freeze({
      settings: DEFAULT_SETTINGS,
      status: initial.status,
      notice: failureNotice(
        initial.status === 'invalid' ? 'invalid-save' : 'unavailable',
      ),
      error: initial,
    });
  } else {
    state = Object.freeze({
      settings: initial.settings,
      status: initial.status,
      notice: null,
      error: null,
    });
  }
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (patch) => {
      const validated = settingsPatchSchema.parse(patch);
      const settings = parseSettings({ ...state.settings, ...validated });
      let failure: SettingsStorageError | null = null;
      try {
        saveSettings(settings, provider);
      } catch (error) {
        if (!(error instanceof SettingsStorageError)) throw error;
        failure = error;
      }
      state = Object.freeze({
        settings,
        status: failure ? 'session-only' : 'saved',
        notice: failure ? failureNotice(failure.code) : null,
        error: failure,
      });
      for (const listener of listeners) listener();
    },
  };
}
