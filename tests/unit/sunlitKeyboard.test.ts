import type { Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import sunlit from '../../src/content/courses/sunlitShoals';
import { createAudioEngine } from '../../src/game/audio/AudioEngine';
import type { HostSnapshot } from '../../src/game/core/GameHost';
import { RaceSession } from '../../src/game/race/RaceSession';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { driveSunlit } from '../browser/acceptance-helpers';
import type { KeyboardObservation } from '../fixtures/courseKeyboardPolicy';

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

  await expect(driveSunlit(page as Page)).rejects.toBe(stop);

  expect(applied).toHaveLength(2);
  expect(applied[0]).toContain('ArrowDown');
  expect(applied[1]).not.toContain('ArrowUp');
  expect(applied[1]).not.toContain('ArrowDown');
  expect(held.size).toBe(0);
});
