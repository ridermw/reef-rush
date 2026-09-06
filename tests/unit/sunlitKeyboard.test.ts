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
import * as nativeRecording from '../fixtures/nativeInputRecording';
import * as pulseControl from '../fixtures/sunlitPulsePolicy';

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
  press: Page['keyboard']['press'] = vi
    .fn<Page['keyboard']['press']>()
    .mockResolvedValue(),
) {
  const page: Pick<Page, 'evaluate' | 'keyboard'> = {
    evaluate,
    keyboard: {
      down,
      up,
      insertText: vi.fn(),
      press,
      type: vi.fn(),
    },
  };
  return page as Page;
}

function plan(...commands: pulseControl.SunlitPulseCommand[]) {
  const policy = vi
    .spyOn(pulseControl, 'sunlitPulsePolicy')
    .mockImplementation(() => {
      throw new Error('Unexpected extra control decision.');
    });
  for (const command of commands) {
    policy.mockReturnValueOnce(
      Object.freeze({
        ...command,
        worstCost: 0,
        meanCost: 0,
        worstMiss: 0,
        stationaryCost: 1,
        motionSteps: 16800,
      }),
    );
  }
  return policy;
}

it('keeps held W separate from completed steering pulses across observations', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  plan(
    { brakeHeld: false, accelerating: true, pulse: 'a' },
    { brakeHeld: false, accelerating: true, pulse: 'ArrowUp' },
  );
  const stop = new Error('End of pulse sequence');
  const down = vi.fn<Page['keyboard']['down']>().mockResolvedValue();
  const up = vi.fn<Page['keyboard']['up']>().mockResolvedValue();
  const press = vi.fn<Page['keyboard']['press']>().mockResolvedValue();
  const evaluate = vi
    .fn<Page['evaluate']>()
    .mockResolvedValueOnce(snapshot(observations[0]))
    .mockResolvedValueOnce({
      state: snapshot(observations[1]),
      hud: ['0:26.63', '2 / 4', '2'],
    })
    .mockRejectedValue(stop);
  await expect(driveSunlit(nativePage(evaluate, down, up, press))).rejects.toBe(
    stop,
  );
  expect(down.mock.calls).toEqual([['w']]);
  expect(press.mock.calls).toEqual([
    ['a', { delay: 100 }],
    ['ArrowUp', { delay: 100 }],
  ]);
  expect(up.mock.calls).toEqual([['w']]);
});

it('emits no invented native operation for an unchanged cruise', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const policy = plan({ brakeHeld: false, pulse: null });
  const stop = new Error('Next observation');
  const down = vi.fn<Page['keyboard']['down']>().mockResolvedValue();
  const up = vi.fn<Page['keyboard']['up']>().mockResolvedValue();
  const press = vi.fn<Page['keyboard']['press']>().mockResolvedValue();
  const evaluate = vi
    .fn<Page['evaluate']>()
    .mockResolvedValueOnce(snapshot(observations[0]))
    .mockRejectedValue(stop);
  await expect(driveSunlit(nativePage(evaluate, down, up, press))).rejects.toBe(
    stop,
  );
  expect(policy).toHaveBeenCalledTimes(1);
  expect(down).not.toHaveBeenCalled();
  expect(up).not.toHaveBeenCalled();
  expect(press).not.toHaveBeenCalled();
});

it('drains a pending pulse before handling a terminal observation and releasing its base', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const policy = plan({
    brakeHeld: false,
    slowing: true,
    propel: true,
    pulse: 'ArrowDown',
  });
  const gate = deferred<void>();
  const down = vi.fn<Page['keyboard']['down']>().mockResolvedValue();
  const up = vi.fn<Page['keyboard']['up']>().mockResolvedValue();
  let terminal = false;
  const press = vi.fn<Page['keyboard']['press']>(() => {
    terminal = true;
    return gate.promise;
  });
  const ending = snapshot(observations[1]);
  if (!ending.race) throw new Error('Missing terminal fixture race.');
  const finished: HostSnapshot = {
    ...ending,
    screen: 'results',
    race: {
      ...ending.race,
      status: 'finished',
      checkpointIndex: 4,
      pearlCount: 4,
    },
  };
  const evaluate = vi
    .fn<Page['evaluate']>()
    .mockResolvedValueOnce(snapshot(observations[0]))
    .mockImplementation(() => {
      if (!terminal) throw new Error('Terminal fixture was not reached.');
      return Promise.resolve({ state: finished, hud: [] });
    });
  const operation = driveSunlit(nativePage(evaluate, down, up, press)).catch(
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(() => expect(press).toHaveBeenCalledTimes(1));
    expect(terminal).toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(up).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
  }
  // This transport fixture intentionally lacks a complete earned milestone log.
  expect(await operation).toBeInstanceOf(Error);
  expect(policy).toHaveBeenCalledTimes(1);
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(up.mock.calls).toEqual([['s']]);
});

it('enrolls explicit timing capture before reading or driving the course', async () => {
  const failure = new Error('Recording enrollment observed.');
  const record = vi
    .spyOn(nativeRecording, 'recordNativeInput')
    .mockRejectedValue(failure);
  const evaluate = vi
    .fn<Page['evaluate']>()
    .mockRejectedValue(new Error('Unenrolled observation.'));
  const page = nativePage(evaluate, vi.fn(), vi.fn());
  const sink = { attach: vi.fn() };
  await expect(driveSunlit(page, sink)).rejects.toBe(failure);
  expect(record).toHaveBeenCalledWith(page, sink, expect.any(Function));
  expect(evaluate).not.toHaveBeenCalled();
});

it('passes actual route observations and base ownership to the pulse controller', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const policy = plan(
    { brakeHeld: false, slowing: true, propel: true, pulse: 'ArrowDown' },
    { brakeHeld: false, accelerating: true, pulse: null },
  );
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
  const press = vi.fn<Page['keyboard']['press']>().mockResolvedValue();
  await expect(driveSunlit(nativePage(evaluate, down, up, press))).rejects.toBe(
    stop,
  );

  expect(applied).toHaveLength(2);
  expect(applied).toEqual([['s'], ['w']]);
  expect(press).toHaveBeenCalledExactlyOnceWith('w+ArrowDown', { delay: 100 });
  expect(policy.mock.calls.map(([value]) => value)).toEqual([
    {
      fish: observations[0].fish,
      steps: 1522,
      previousSteps: undefined,
      brakeHeld: false,
      slowing: false,
      accelerating: false,
      waypoint: 4,
      approachingCheckpoint: false,
      checkpointIndex: 2,
      collectedPearlIds: ['pearl-entry', 'pearl-bend'],
    },
    {
      fish: observations[1].fish,
      steps: 1598,
      previousSteps: 1522,
      brakeHeld: false,
      slowing: true,
      accelerating: false,
      waypoint: 4,
      approachingCheckpoint: false,
      checkpointIndex: 2,
      collectedPearlIds: ['pearl-entry', 'pearl-bend'],
    },
  ]);
  expect(held.size).toBe(0);
});

it('acknowledges S before pulsing W and observes only after the pulse completes', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  plan({ brakeHeld: false, slowing: true, propel: true, pulse: 'ArrowDown' });
  const base = deferred<void>();
  const pulse = deferred<void>();
  const stop = new Error('Observed the applied keys');
  const down = vi.fn<Page['keyboard']['down']>(() => base.promise);
  const up = vi.fn<Page['keyboard']['up']>().mockResolvedValue();
  const press = vi.fn<Page['keyboard']['press']>(() => pulse.promise);
  const evaluate = vi
    .fn<Page['evaluate']>()
    .mockResolvedValueOnce(snapshot(observations[0]))
    .mockRejectedValue(stop);
  const completed = driveSunlit(nativePage(evaluate, down, up, press)).catch(
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(() => expect(down).toHaveBeenCalledTimes(1));
    expect(down.mock.calls).toEqual([['s']]);
    expect(press).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
    base.resolve();
    await vi.waitFor(() =>
      expect(press).toHaveBeenCalledExactlyOnceWith('w+ArrowDown', {
        delay: 100,
      }),
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
  } finally {
    base.resolve();
    pulse.resolve();
    expect(await completed).toBe(stop);
  }
  expect(up.mock.calls).toEqual([['s']]);
});

it('settles every release before sending the next native key set', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  plan(
    { brakeHeld: true, pulse: 'ArrowDown' },
    { brakeHeld: false, slowing: true, propel: true, pulse: 'a' },
  );
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
    await vi.waitFor(() => expect(up).toHaveBeenCalledTimes(1));
    expect(up.mock.calls).toEqual([['Shift']]);
    expect(down).not.toHaveBeenCalledWith('s');
    expect(evaluate).toHaveBeenCalledTimes(2);
  } finally {
    gate.resolve();
    expect(await completed).toBe(stop);
  }
  expect(down).toHaveBeenLastCalledWith('s');
  expect(up).toHaveBeenLastCalledWith('s');
});

it('releases every possible chord delivery after a failed pulse acknowledgement', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  plan({ brakeHeld: false, slowing: true, propel: true, pulse: 'ArrowDown' });
  const gate = deferred<void>();
  const failure = new Error('Native press acknowledgement failed');
  const down = vi.fn<Page['keyboard']['down']>().mockResolvedValue();
  const up = vi.fn<Page['keyboard']['up']>().mockResolvedValue();
  const press = vi.fn<Page['keyboard']['press']>(() => gate.promise);
  const evaluate = vi
    .fn<Page['evaluate']>()
    .mockResolvedValueOnce(snapshot(observations[0]))
    .mockRejectedValue(
      new Error('Unexpected observation before pulse acknowledgement'),
    );
  let finished = false;
  const completed = driveSunlit(nativePage(evaluate, down, up, press)).catch(
    (error: unknown) => {
      finished = true;
      return error;
    },
  );
  try {
    await vi.waitFor(() => expect(press).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);
    expect(up).not.toHaveBeenCalled();
  } finally {
    if (press.mock.calls.length) gate.reject(failure);
    else gate.resolve();
    await completed;
  }
  expect(await completed).toBe(failure);
  expect(up.mock.calls).toEqual([['w'], ['ArrowDown'], ['s']]);
  expect(evaluate).toHaveBeenCalledTimes(1);
});

it('attempts every cleanup edge and preserves both driver and release failures', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  plan({ brakeHeld: false, slowing: true, propel: true, pulse: 'ArrowDown' });
  const pressFailure = new Error('Press acknowledgement failed');
  const releaseFailure = new Error('Release acknowledgement failed');
  const down = vi.fn<Page['keyboard']['down']>().mockResolvedValue();
  const press = vi
    .fn<Page['keyboard']['press']>()
    .mockRejectedValue(pressFailure);
  const up = vi.fn<Page['keyboard']['up']>((key) =>
    key === 'w' ? Promise.reject(releaseFailure) : Promise.resolve(),
  );
  const evaluate = vi
    .fn<Page['evaluate']>()
    .mockResolvedValueOnce(snapshot(observations[0]))
    .mockRejectedValue(new Error('Unexpected observation after failed press'));

  const failure: unknown = await driveSunlit(
    nativePage(evaluate, down, up, press),
  ).catch((error: unknown) => error);

  expect(up.mock.calls).toEqual([['w'], ['ArrowDown']]);
  expect(failure).toMatchObject({
    name: 'AggregateError',
    errors: [
      pressFailure,
      { name: 'AggregateError', errors: [releaseFailure] },
    ],
  });
});
