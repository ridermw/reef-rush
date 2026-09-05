import type { Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import sunlit from '../../src/content/courses/sunlitShoals';
import { createAudioEngine } from '../../src/game/audio/AudioEngine';
import type { HostSnapshot } from '../../src/game/core/GameHost';
import { RaceSession } from '../../src/game/race/RaceSession';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { driveSunlit } from '../browser/acceptance-helpers';
import type { KeyboardObservation } from '../fixtures/courseKeyboardPolicy';
import { deferred } from '../fixtures/originalAssets';

afterEach(() => vi.restoreAllMocks());

// Consecutive observations from hosted run 33979367198, before checkpoint three.
const observations: KeyboardObservation[] = [
  {
    steps: 1522,
    fish: {
      position: [0.7776996350766423, -4, 46.71769177393481],
      velocity: [0.03606233883620913, 0, 0.09603707573691338],
      yaw: 1.4238224535627158,
      pitch: 0,
      roll: -0.13486676128170497,
      dashEnergy: 1,
      isSubmerged: true,
    },
  },
  {
    steps: 1598,
    fish: {
      position: [0.7801838517189026, -4, 46.72430419921875],
      velocity: [5.298513448898941e-9, 0, 1.4110391999146677e-8],
      yaw: 0.9347518528893861,
      pitch: -0.8494074824243215,
      roll: -0.003936900002545297,
      dashEnergy: 1,
      isSubmerged: true,
    },
  },
];

function snapshot({ fish, steps }: KeyboardObservation): HostSnapshot {
  return {
    preferences: DEFAULT_SETTINGS,
    audio: createAudioEngine().getState(),
    feedback: null,
    screen: 'playing',
    graphicsLost: false,
    player: fish,
    race: {
      ...new RaceSession(sunlit).start(),
      elapsedMs: (steps * 1000) / 60,
      checkpointIndex: 2,
      pearlCount: 2,
    },
    collectedPearlIds: ['pearl-entry', 'pearl-bend'],
    lifecycle: 'active',
    cleanupError: null,
    frame: { rendered: steps, steps, profiled: steps },
    resources: {
      canvases: 1,
      rafChains: 1,
      pendingCleanup: 0,
      scene: null,
    },
  };
}

function nativePage(
  evaluate: Page['evaluate'],
  down: Page['keyboard']['down'],
  up: Page['keyboard']['up'],
) {
  const page: Pick<Page, 'evaluate' | 'keyboard'> = {
    evaluate,
    keyboard: {
      down,
      up,
      insertText: vi.fn(),
      press: vi.fn(),
      type: vi.fn(),
    },
  };
  return page as Page;
}

it('releases pitch instead of commanding an upward overshoot after the recorded native observation gap', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const held = new Set<string>();
  const applied: string[][] = [];
  const stop = new Error('End of recorded observations');
  const down = vi.fn<Page['keyboard']['down']>((key) => {
    held.add(key);
    return Promise.resolve();
  });
  const up = vi.fn<Page['keyboard']['up']>((key) => {
    held.delete(key);
    return Promise.resolve();
  });
  let evaluation = 0;
  const evaluate = vi.fn<Page['evaluate']>(() => {
    evaluation++;
    if (evaluation === 1) return Promise.resolve(snapshot(observations[0]));
    applied.push([...held]);
    if (evaluation === 2) {
      return Promise.resolve({
        state: snapshot(observations[1]),
        hud: ['0:26.63', '2 / 4', '2'],
      });
    }
    return Promise.reject(stop);
  });
  await expect(driveSunlit(nativePage(evaluate, down, up))).rejects.toBe(stop);

  expect(applied).toHaveLength(2);
  expect(applied[0]).toContain('ArrowDown');
  expect(applied[1]).not.toContain('ArrowUp');
  expect(applied[1]).not.toContain('ArrowDown');
  expect(held.size).toBe(0);
});

it('batches the initial native key edges without serial round trips', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const gate = deferred<void>();
  const stop = new Error('Observed the applied keys');
  const down = vi.fn<Page['keyboard']['down']>(() => gate.promise);
  const up = vi.fn<Page['keyboard']['up']>().mockResolvedValue();
  const evaluate = vi
    .fn<Page['evaluate']>()
    .mockResolvedValueOnce(snapshot(observations[0]))
    .mockRejectedValue(stop);
  const completed = driveSunlit(nativePage(evaluate, down, up)).catch(
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(() => expect(down).toHaveBeenCalledTimes(4));
    expect(down.mock.calls).toEqual([['d'], ['ArrowDown'], ['w'], ['Shift']]);
    expect(evaluate).toHaveBeenCalledTimes(1);
  } finally {
    gate.resolve();
    expect(await completed).toBe(stop);
  }
  expect(up.mock.calls).toEqual(down.mock.calls);
});

it('settles every release before sending the next native key set', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const gate = deferred<void>();
  const stop = new Error('Observed the replacement keys');
  const down = vi.fn<Page['keyboard']['down']>().mockResolvedValue();
  const up = vi.fn<Page['keyboard']['up']>((key) =>
    key === 's' ? Promise.resolve() : gate.promise,
  );
  const next = snapshot({
    steps: 1600,
    fish: {
      ...observations[1].fish,
      position: [-4, -5, 59],
      velocity: [0, 0, 5],
      yaw: 0,
      pitch: 0,
    },
  });
  const evaluate = vi
    .fn<Page['evaluate']>()
    .mockResolvedValueOnce(snapshot(observations[0]))
    .mockResolvedValueOnce({ state: next, hud: ['0:26.66', '2 / 4', '2'] })
    .mockRejectedValue(stop);
  const completed = driveSunlit(nativePage(evaluate, down, up)).catch(
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(() => expect(up).toHaveBeenCalledTimes(4));
    expect(down).not.toHaveBeenCalledWith('s');
    expect(evaluate).toHaveBeenCalledTimes(2);
  } finally {
    gate.resolve();
    expect(await completed).toBe(stop);
  }
  expect(down).toHaveBeenLastCalledWith('s');
  expect(up).toHaveBeenLastCalledWith('s');
});

it('settles failed press batches before releasing every possibly delivered key', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const gate = deferred<void>();
  const failure = new Error('Native press acknowledgement failed');
  const down = vi.fn<Page['keyboard']['down']>((key) =>
    key === 'd' ? Promise.reject(failure) : gate.promise,
  );
  const up = vi.fn<Page['keyboard']['up']>().mockResolvedValue();
  const evaluate = vi
    .fn<Page['evaluate']>()
    .mockResolvedValue(snapshot(observations[0]));
  let finished = false;
  const completed = driveSunlit(nativePage(evaluate, down, up)).catch(
    (error: unknown) => {
      finished = true;
      return error;
    },
  );
  try {
    await vi.waitFor(() => expect(down).toHaveBeenCalledTimes(4));
    expect(finished).toBe(false);
    expect(up).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
    await completed;
  }
  expect(await completed).toMatchObject({
    name: 'AggregateError',
    errors: [failure],
  });
  expect(up.mock.calls).toEqual(down.mock.calls);
  expect(evaluate).toHaveBeenCalledTimes(1);
});

it('attempts every cleanup edge and preserves both driver and release failures', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const pressFailure = new Error('Press acknowledgement failed');
  const releaseFailure = new Error('Release acknowledgement failed');
  const down = vi.fn<Page['keyboard']['down']>((key) =>
    key === 'd' ? Promise.reject(pressFailure) : Promise.resolve(),
  );
  const up = vi.fn<Page['keyboard']['up']>((key) =>
    key === 'd' ? Promise.reject(releaseFailure) : Promise.resolve(),
  );
  const evaluate = vi
    .fn<Page['evaluate']>()
    .mockResolvedValue(snapshot(observations[0]));

  const failure: unknown = await driveSunlit(
    nativePage(evaluate, down, up),
  ).catch((error: unknown) => error);

  expect(up.mock.calls).toEqual(down.mock.calls);
  expect(failure).toMatchObject({
    name: 'AggregateError',
    errors: [
      { name: 'AggregateError', errors: [pressFailure] },
      { name: 'AggregateError', errors: [releaseFailure] },
    ],
  });
});
