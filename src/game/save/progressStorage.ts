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

export type ProgressReplacement =
  | {
      readonly status:
        | 'replaced'
        | 'changed'
        | 'loaded'
        | 'empty'
        | 'unsupported-version'
        | 'cancelled';
    }
  | {
      readonly status: 'invalid-request' | 'unavailable' | 'write-failed';
      readonly cause: unknown;
    };

/** Explicit authorization is scoped to one exact, replaceable raw snapshot. */
export function replaceInvalidProgress(
  expectedRaw: unknown,
  input: unknown,
  provider: StorageProvider = browserStorage,
  signal?: AbortSignal,
): ProgressReplacement {
  let progress: Progress;
  try {
    if (typeof expectedRaw !== 'string')
      throw new TypeError('Recovery requires the inspected raw save.');
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw new TypeError('Recovery requires a valid cancellation signal.');
    progress = parseProgress(input);
  } catch (cause) {
    return { status: 'invalid-request', cause };
  }
  if (signal?.aborted) return { status: 'cancelled' };
  let storage: StorageLike;
  try {
    storage = provider();
  } catch (cause) {
    return { status: 'unavailable', cause };
  }
  const current = readProgress(() => storage);
  if (current.status === 'unavailable') return current;
  if (current.status !== 'invalid') return { status: current.status };
  if (current.reason === 'unsupported-version')
    return { status: 'unsupported-version' };
  if (current.raw !== expectedRaw) return { status: 'changed' };
  const serialized = JSON.stringify(progress);
  if (signal?.aborted) return { status: 'cancelled' };
  try {
    storage.setItem(PROGRESS_STORAGE_KEY, serialized);
  } catch (cause) {
    return { status: 'write-failed', cause };
  }
  return { status: 'replaced' };
}

export function serializeProgressBackup(raw: string): string {
  // JSON escapes lone UTF-16 surrogates before Blob's UTF-8 conversion.
  return JSON.stringify({
    format: 'reef-rush.progress-backup',
    version: 1,
    raw,
  });
}
