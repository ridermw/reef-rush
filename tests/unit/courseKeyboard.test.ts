import { runInNewContext } from 'node:vm';
import type { Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import kelpworks from '../../src/content/courses/kelpworks';
import blacksmoker from '../../src/content/courses/blacksmokerRun';
import { createAudioEngine } from '../../src/game/audio/AudioEngine';
import type { HostSnapshot } from '../../src/game/core/GameHost';
import { RaceSession } from '../../src/game/race/RaceSession';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { snapshot } from '../browser/acceptance-helpers';
import { driveCourseByKeyboard } from '../fixtures/courseKeyboard';

vi.mock('../browser/acceptance-helpers', () => ({
  keyboardSurface: vi.fn(),
  snapshot: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

it.each([kelpworks, blacksmoker])(
  'reports a stalled $courseId from the isolated page realm and releases native keys',
  async (course) => {
    const state: HostSnapshot = {
      preferences: DEFAULT_SETTINGS,
      audio: createAudioEngine().getState(),
      feedback: null,
      screen: 'playing',
      graphicsLost: false,
      player: {
        position: course.spawn.position,
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        roll: 0,
        dashEnergy: 1,
        isSubmerged: true,
      },
      race: new RaceSession(course).start(),
      collectedPearlIds: [],
      lifecycle: 'active',
      cleanupError: null,
      frame: { rendered: 1, steps: 1 },
      resources: {
        canvases: 1,
        rafChains: 1,
        pendingCleanup: 0,
        scene: null,
      },
    };
    vi.mocked(snapshot).mockResolvedValue(state);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const down = vi.fn<Page['keyboard']['down']>();
    const up = vi.fn<Page['keyboard']['up']>();
    const evaluate = vi.fn<Page['evaluate']>();
    evaluate.mockImplementation(async (callback, input: unknown) => {
      if (typeof callback !== 'function')
        throw new Error('Expected an evaluated page function.');
      let now = 0;
      // Like Playwright, this realm receives serialized arguments, not closures.
      const result: unknown = runInNewContext(
        `(${callback.toString()})(input)`,
        {
          input: structuredClone(input),
          window: { __REEF_RUSH_TEST__: { getSnapshot: () => state } },
          performance: { now: () => (now += 5001) },
          requestAnimationFrame: (read: () => void) => read(),
        },
      );
      return await result;
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

    await expect(driveCourseByKeyboard(page as Page, course)).rejects.toThrow(
      `Native ${course.courseId} stopped advancing:`,
    );
    expect(down).toHaveBeenCalledWith('w');
    expect(up.mock.calls).toEqual(down.mock.calls);
  },
);
