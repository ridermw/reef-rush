import type { Page } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import * as nativeKeyboard from '../fixtures/nativeKeyboard';
import { deferred } from '../fixtures/originalAssets';

const { setNativeKeys, releaseNativeKeys } = nativeKeyboard;

function keyboard() {
  return {
    up: vi.fn<Page['keyboard']['up']>().mockResolvedValue(),
    down: vi.fn<Page['keyboard']['down']>().mockResolvedValue(),
    press: vi.fn<Page['keyboard']['press']>().mockResolvedValue(),
  };
}

function pulse() {
  expect(nativeKeyboard.pulseNativeKey).toBeTypeOf('function');
  return nativeKeyboard.pulseNativeKey;
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

it('owns a native pulse before acknowledgement and preserves the existing brake after success', async () => {
  const input = keyboard();
  const held = new Set(['Shift']);
  const gate = deferred<void>();
  input.press.mockReturnValue(gate.promise);
  const operation = pulse()(input, held, 'a');
  try {
    expect(input.press).toHaveBeenCalledWith('a', { delay: 100 });
    expect(held).toEqual(new Set(['Shift', 'a']));
  } finally {
    gate.resolve();
    await operation;
  }
  expect(held).toEqual(new Set(['Shift']));
  expect(input.down).not.toHaveBeenCalled();
  expect(input.up).not.toHaveBeenCalled();
});

it.each(['a+ArrowDown', 'Shift'])(
  'rejects %s instead of owning a chord or nonsteering pulse',
  async (key) => {
    const input = keyboard();
    const held = new Set(['Shift']);
    await expect(pulse()(input, held, key)).rejects.toThrow(
      'Native pulse requires one steering key.',
    );
    expect(held).toEqual(new Set(['Shift']));
    expect(input.press).not.toHaveBeenCalled();
    expect(input.down).not.toHaveBeenCalled();
    expect(input.up).not.toHaveBeenCalled();
  },
);

it('rejects an already owned pulse without disturbing native input or ownership', async () => {
  const input = keyboard();
  const held = new Set(['a', 'Shift']);
  await expect(pulse()(input, held, 'a')).rejects.toThrow(
    'Native pulse key is already held.',
  );
  expect(held).toEqual(new Set(['a', 'Shift']));
  expect(input.press).not.toHaveBeenCalled();
  expect(input.down).not.toHaveBeenCalled();
  expect(input.up).not.toHaveBeenCalled();
});

it('retains every possible key when a pulse acknowledgement fails', async () => {
  const input = keyboard();
  const failure = new Error('Pulse acknowledgement failed');
  input.press.mockRejectedValue(failure);
  const held = new Set(['Shift']);
  await expect(pulse()(input, held, 'ArrowDown')).rejects.toBe(failure);
  expect(held).toEqual(new Set(['Shift', 'ArrowDown']));
  expect(input.press).toHaveBeenCalledWith('ArrowDown', { delay: 100 });
  expect(input.up).not.toHaveBeenCalled();
});

it('cleans up every uncertain pulse key and retains both pulse and release errors', async () => {
  const input = keyboard();
  const failure = new Error('Pulse acknowledgement failed');
  const releaseFailure = new Error('Brake release failed');
  input.press.mockRejectedValue(failure);
  input.up.mockImplementation((key) =>
    key === 'Shift' ? Promise.reject(releaseFailure) : Promise.resolve(),
  );
  const held = new Set(['Shift']);
  await expect(pulse()(input, held, 'ArrowDown')).rejects.toBe(failure);
  await expect(
    releaseNativeKeys(input, held, { error: failure }),
  ).rejects.toMatchObject({
    name: 'AggregateError',
    errors: [failure, { name: 'AggregateError', errors: [releaseFailure] }],
  });
  expect(input.up.mock.calls).toEqual([['Shift'], ['ArrowDown']]);
  expect(held).toEqual(new Set(['Shift']));
});
