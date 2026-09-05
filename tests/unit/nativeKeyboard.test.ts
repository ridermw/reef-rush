import type { Page } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { setNativeKeys } from '../fixtures/nativeKeyboard';
import { deferred } from '../fixtures/originalAssets';

function keyboard() {
  return {
    up: vi.fn<Page['keyboard']['up']>().mockResolvedValue(),
    down: vi.fn<Page['keyboard']['down']>().mockResolvedValue(),
  };
}

it('leaves retained keys held without emitting redundant native edges', async () => {
  const input = keyboard();
  const held = new Set(['a', 'w']);
  const desired = new Set(['a', 'w']);
  await setNativeKeys(input, held, desired);
  expect(input.up).not.toHaveBeenCalled();
  expect(input.down).not.toHaveBeenCalled();
  expect(held).toEqual(desired);
});

it('replaces only changed keys without mutating the desired set', async () => {
  const input = keyboard();
  const held = new Set(['a', 'w']);
  const desired = new Set(['d', 'w', 'Shift']);
  await setNativeKeys(input, held, desired);
  expect(input.up.mock.calls).toEqual([['a']]);
  expect(input.down.mock.calls).toEqual([['d'], ['Shift']]);
  expect(held).toEqual(desired);
  expect([...desired]).toEqual(['d', 'w', 'Shift']);
});

it('settles failed releases and retains uncertain keys without pressing replacements', async () => {
  const input = keyboard();
  const gate = deferred<void>();
  const failure = new Error('Release acknowledgement failed');
  input.up.mockImplementation((key) =>
    key === 'a' ? Promise.reject(failure) : gate.promise,
  );
  const held = new Set(['a', 'w']);
  let finished = false;
  const operation = setNativeKeys(input, held, new Set(['d'])).catch(
    (error: unknown) => {
      finished = true;
      return error;
    },
  );
  try {
    await vi.waitFor(() => expect(input.up).toHaveBeenCalledTimes(2));
    expect(finished).toBe(false);
    expect(input.down).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
    await operation;
  }
  expect(await operation).toMatchObject({
    name: 'AggregateError',
    errors: [failure],
  });
  expect([...held]).toEqual(['a']);
  expect(input.down).not.toHaveBeenCalled();
});

it('reports every failed press and tracks every possibly delivered key for cleanup', async () => {
  const input = keyboard();
  const first = new Error('First acknowledgement failed');
  const second = new Error('Second acknowledgement failed');
  input.down.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
  const held = new Set<string>();
  await expect(
    setNativeKeys(input, held, new Set(['a', 'w'])),
  ).rejects.toMatchObject({
    name: 'AggregateError',
    errors: [first, second],
  });
  expect([...held]).toEqual(['a', 'w']);
});
