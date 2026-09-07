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
  const releases = [...held].filter((key) => !desired.has(key));
  const w = releases.find((key) => key === 'w');
  const s = releases.find((key) => key === 's');
  // S guards uncertain W delivery. Independent steering releases still proceed.
  const groups =
    w !== undefined && s !== undefined
      ? [
          [w, s],
          ...releases
            .filter((key) => key !== w && key !== s)
            .map((key) => [key]),
        ]
      : releases.map((key) => [key]);
  // Independent edges share a batch, but all releases precede replacements.
  await settle(
    groups.map(async (keys) => {
      for (const key of keys) {
        await keyboard.up(key);
        held.delete(key);
      }
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
  await pulseNativeKeys(keyboard, held, [key]);
}

export async function pulseNativeKeys<Key extends string>(
  keyboard: Pick<Page['keyboard'], 'press'>,
  held: Set<Key>,
  keys: readonly Key[],
) {
  const pulseKeys = [...keys];
  const requested = new Set<string>(pulseKeys);
  const existing = new Set<string>(held);
  const active = new Set([...existing, ...requested]);
  if (
    !pulseKeys.length ||
    pulseKeys.length > 3 ||
    requested.size !== pulseKeys.length ||
    pulseKeys.some(
      (key) => !['w', 'a', 'd', 'ArrowUp', 'ArrowDown'].includes(key),
    ) ||
    (active.has('a') && active.has('d')) ||
    (active.has('ArrowUp') && active.has('ArrowDown'))
  )
    throw new Error(
      'Native pulse requires distinct, nonopposing control keys.',
    );
  if (
    requested.has('w') &&
    (pulseKeys[0] !== 'w' || !existing.has('s') || existing.has('Shift'))
  )
    throw new Error(
      'Native pulse propulsion requires W first and held S without Shift.',
    );
  if (pulseKeys.some((key) => held.has(key)))
    throw new Error('Native pulse key is already held.');
  // Any part of the chord can arrive before a rejected acknowledgement.
  for (const key of pulseKeys) held.add(key);
  await keyboard.press(pulseKeys.join('+'), { delay: 100 });
  for (const key of pulseKeys) held.delete(key);
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
