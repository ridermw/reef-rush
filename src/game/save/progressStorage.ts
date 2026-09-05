import {
  emptyProgress,
  parseProgress,
  progressSchema,
  type Progress,
} from '../progression/progress';

export const PROGRESS_STORAGE_KEY = 'reef-rush.progress';
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export type StorageProvider = () => StorageLike;

export type ProgressRead =
  | { readonly status: 'empty' | 'loaded'; readonly progress: Progress }
  | {
      readonly status: 'invalid';
      readonly reason:
        'unsupported-version' | 'malformed-json' | 'invalid-schema';
      readonly raw: string;
      readonly cause: unknown;
    }
  | { readonly status: 'unavailable'; readonly cause: unknown };

function browserStorage(): StorageLike {
  return window.localStorage;
}

export function readProgress(
  provider: StorageProvider = browserStorage,
): ProgressRead {
  let raw: string | null;
  try {
    raw = provider().getItem(PROGRESS_STORAGE_KEY);
  } catch (cause) {
    return Object.freeze({ status: 'unavailable', cause });
  }
  if (raw === null) {
    return Object.freeze({ status: 'empty', progress: emptyProgress() });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (cause) {
    return Object.freeze<ProgressRead>({
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
    payload.version !== 1
  ) {
    return Object.freeze({
      status: 'invalid',
      reason: 'unsupported-version',
      raw,
      cause: new Error(`Unsupported progress version: ${payload.version}.`),
    });
  }
  const parsed = progressSchema.safeParse(payload);
  if (!parsed.success) {
    return Object.freeze({
      status: 'invalid',
      reason: 'invalid-schema',
      raw,
      cause: parsed.error,
    });
  }
  return Object.freeze({ status: 'loaded', progress: parsed.data });
}

export function saveProgress(
  input: unknown,
  provider: StorageProvider = browserStorage,
): void {
  const progress = parseProgress(input);
  let storage: StorageLike;
  try {
    storage = provider();
  } catch (cause) {
    throw new Error('Progress storage is unavailable.', { cause });
  }
  const current = readProgress(() => storage);
  if (current.status === 'unavailable') {
    throw new Error('Progress storage is unavailable.', {
      cause: current.cause,
    });
  }
  if (current.status === 'invalid') {
    throw new Error('Refusing to overwrite an invalid progress save.', {
      cause: current,
    });
  }
  const serialized = JSON.stringify(progress);
  try {
    storage.setItem(PROGRESS_STORAGE_KEY, serialized);
  } catch (cause) {
    throw new Error('Failed to save progress.', { cause });
  }
}
