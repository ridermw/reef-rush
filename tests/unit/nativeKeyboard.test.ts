import type { Page } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { InputController } from '../../src/game/input/InputController';
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

function chord() {
  expect(nativeKeyboard.pulseNativeKeys).toBeTypeOf('function');
  return nativeKeyboard.pulseNativeKeys;
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

it.each([['w'], ['w', 'a'], ['w', 'a', 'ArrowUp']])(
  'owns every propulsion chord key before its single public press: %j',
  async (...keys) => {
    const input = keyboard();
    const held = new Set(['s']);
    const gate = deferred<void>();
    input.press.mockImplementation(() => {
      expect(held).toEqual(new Set(['s', ...keys]));
      return gate.promise;
    });
    const operation = chord()(input, held, keys);
    try {
      expect(input.press).toHaveBeenCalledExactlyOnceWith(keys.join('+'), {
        delay: 100,
      });
      expect(held).toEqual(new Set(['s', ...keys]));
    } finally {
      gate.resolve();
      await operation;
    }
    expect(held).toEqual(new Set(['s']));
    expect(input.down).not.toHaveBeenCalled();
    expect(input.up).not.toHaveBeenCalled();
  },
);

it('preserves the caller order for paired steering without requiring propulsion', async () => {
  const input = keyboard();
  const held = new Set(['Shift']);
  await chord()(input, held, ['ArrowDown', 'd']);
  expect(input.press).toHaveBeenCalledExactlyOnceWith('ArrowDown+d', {
    delay: 100,
  });
  expect(held).toEqual(new Set(['Shift']));
});

it.each([
  { keys: [], held: ['s'] },
  { keys: ['a', 'a'], held: ['s'] },
  { keys: ['a', 'd'], held: ['s'] },
  { keys: ['ArrowUp', 'ArrowDown'], held: ['s'] },
  { keys: ['w', 'a', 'd'], held: ['s'] },
  { keys: ['s'], held: [] },
  { keys: ['Shift'], held: [] },
  { keys: ['a+ArrowUp'], held: [] },
  { keys: ['w'], held: [] },
  { keys: ['w', 'ArrowUp'], held: ['s', 'Shift'] },
  { keys: ['a', 'w'], held: ['s'] },
  { keys: ['a'], held: ['d'] },
  { keys: ['ArrowDown'], held: ['ArrowUp'] },
  { keys: ['w', 'a'], held: ['s', 'd'] },
])(
  'rejects an invalid chord without changing ownership: $keys',
  async (example) => {
    const input = keyboard();
    const held = new Set(example.held);
    await expect(chord()(input, held, example.keys)).rejects.toThrow(
      'Native pulse',
    );
    expect(held).toEqual(new Set(example.held));
    expect(input.press).not.toHaveBeenCalled();
    expect(input.down).not.toHaveBeenCalled();
    expect(input.up).not.toHaveBeenCalled();
  },
);

it('rejects any already owned chord member before registering the other keys', async () => {
  const input = keyboard();
  const held = new Set(['s', 'ArrowUp']);
  await expect(chord()(input, held, ['w', 'a', 'ArrowUp'])).rejects.toThrow(
    'Native pulse key is already held.',
  );
  expect(held).toEqual(new Set(['s', 'ArrowUp']));
  expect(input.press).not.toHaveBeenCalled();
});

it('uses its own chord snapshot while an acknowledgement is pending', async () => {
  const input = keyboard();
  const gate = deferred<void>();
  input.press.mockReturnValue(gate.promise);
  const held = new Set(['s']);
  const keys = ['w', 'a'];
  const operation = chord()(input, held, keys);
  keys.splice(0, keys.length, 's');
  gate.resolve();
  await operation;
  expect(input.press).toHaveBeenCalledExactlyOnceWith('w+a', { delay: 100 });
  expect(held).toEqual(new Set(['s']));
});

it('retains all uncertain chord deliveries and aggregates their cleanup failures', async () => {
  const input = keyboard();
  const pulseFailure = new Error('Chord acknowledgement failed');
  const releaseFailure = new Error('W release acknowledgement failed');
  const held = new Set(['s']);
  input.press.mockRejectedValue(pulseFailure);
  input.up.mockImplementation((key) =>
    key === 'w' ? Promise.reject(releaseFailure) : Promise.resolve(),
  );
  await expect(chord()(input, held, ['w', 'a', 'ArrowDown'])).rejects.toBe(
    pulseFailure,
  );
  expect(held).toEqual(new Set(['s', 'w', 'a', 'ArrowDown']));
  await expect(
    releaseNativeKeys(input, held, { error: pulseFailure }),
  ).rejects.toMatchObject({
    name: 'AggregateError',
    errors: [
      pulseFailure,
      { name: 'AggregateError', errors: [releaseFailure] },
    ],
  });
  expect(input.up.mock.calls).toEqual([['w'], ['a'], ['ArrowDown']]);
  expect(held).toEqual(new Set(['s', 'w']));
});

it.each(['success', 'failure before delivery', 'failure after delivery'])(
  'keeps actual S cancellation until W release is acknowledged: %s',
  async (outcome) => {
    const controller = new InputController(window, { isPlaying: () => true });
    const input = keyboard();
    const held = new Set(['s', 'w', 'a']);
    const gate = deferred<void>();
    const failure = new Error('Uncertain W release');
    const throttle: number[] = [];
    const deliver = (key: string, type: 'keydown' | 'keyup') => {
      window.dispatchEvent(
        new KeyboardEvent(type, {
          key,
          code: `Key${key.toUpperCase()}`,
          cancelable: true,
        }),
      );
      throttle.push(controller.readFrame().throttle);
    };
    try {
      for (const key of held) deliver(key, 'keydown');
      throttle.length = 0;
      input.up.mockImplementation((key) => {
        if (key === 'w') {
          if (outcome === 'failure after delivery') deliver(key, 'keyup');
          return gate.promise.then(() => deliver(key, 'keyup'));
        }
        deliver(key, 'keyup');
        return Promise.resolve();
      });
      const operation = releaseNativeKeys(input, held).catch(
        (error: unknown) => error,
      );
      try {
        expect(throttle).not.toContain(1);
        expect(input.up.mock.calls).toEqual([['w'], ['a']]);
        expect(held.has('s')).toBe(true);
        expect(controller.readFrame().throttle).toBe(
          outcome === 'failure after delivery' ? -1 : 0,
        );
      } finally {
        if (outcome === 'success') gate.resolve();
        else gate.reject(failure);
      }
      const error: unknown = await operation;
      if (outcome === 'success') {
        expect(error).toBeUndefined();
        expect(input.up.mock.calls).toEqual([['w'], ['a'], ['s']]);
        expect(held.size).toBe(0);
        expect(controller.readFrame().throttle).toBe(0);
      } else {
        expect(error).toMatchObject({
          name: 'AggregateError',
          errors: [failure],
        });
        expect(input.up.mock.calls).toEqual([['w'], ['a']]);
        expect(held).toEqual(new Set(['s', 'w']));
        input.up.mockImplementation((key) => {
          deliver(key, 'keyup');
          return Promise.resolve();
        });
        await releaseNativeKeys(input, held);
        expect(held.size).toBe(0);
      }
      expect(throttle).not.toContain(1);
    } finally {
      controller.destroy();
    }
  },
);

it('withholds replacement keys when the cancellation guard cannot be released safely', async () => {
  const input = keyboard();
  const failure = new Error('W release failed');
  input.up.mockRejectedValueOnce(failure);
  const held = new Set(['s', 'w']);
  await expect(
    setNativeKeys(input, held, new Set(['d'])),
  ).rejects.toMatchObject({
    name: 'AggregateError',
    errors: [failure],
  });
  expect(input.up.mock.calls).toEqual([['w']]);
  expect(input.down).not.toHaveBeenCalled();
  expect(held).toEqual(new Set(['s', 'w']));
});
