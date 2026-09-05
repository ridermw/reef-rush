import type { Page } from '@playwright/test';

async function settle(operations: Promise<void>[], phase: string) {
  const outcomes = await Promise.allSettled(operations);
  const errors: unknown[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') errors.push(outcome.reason);
  }
  if (errors.length)
    throw new AggregateError(errors, `Native keyboard ${phase} failed.`);
}

export async function setNativeKeys<Key extends string>(
  keyboard: Pick<Page['keyboard'], 'down' | 'up'>,
  held: Set<Key>,
  desired: ReadonlySet<Key>,
) {
  // Independent edges share a batch, but all releases precede replacements.
  await settle(
    [...held]
      .filter((key) => !desired.has(key))
      .map(async (key) => {
        await keyboard.up(key);
        held.delete(key);
      }),
    'release',
  );
  await settle(
    [...desired]
      .filter((key) => !held.has(key))
      .map(async (key) => {
        // A failed acknowledgement can still mean the browser received the key.
        held.add(key);
        await keyboard.down(key);
      }),
    'press',
  );
}

export async function pulseNativeKey<Key extends string>(
  keyboard: Pick<Page['keyboard'], 'press'>,
  held: Set<Key>,
  key: Key,
) {
  if (!['a', 'd', 'ArrowUp', 'ArrowDown'].includes(key))
    throw new Error('Native pulse requires one steering key.');
  if (held.has(key)) throw new Error('Native pulse key is already held.');
  // Rejected acknowledgements can follow delivery; cleanup still owns the key.
  held.add(key);
  await keyboard.press(key, { delay: 100 });
  held.delete(key);
}

export async function releaseNativeKeys<Key extends string>(
  keyboard: Pick<Page['keyboard'], 'down' | 'up'>,
  held: Set<Key>,
  failure?: { error: unknown },
) {
  try {
    await setNativeKeys(keyboard, held, new Set<Key>());
  } catch (error) {
    if (failure)
      throw new AggregateError(
        [failure.error, error],
        'Native driver and keyboard cleanup failed.',
      );
    throw error;
  }
}
