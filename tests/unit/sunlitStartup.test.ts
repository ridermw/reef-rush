import type { Locator, Page } from '@playwright/test';
import { beforeEach, expect, it, vi } from 'vitest';
import { loadSunlit, selectSunlit } from '../browser/acceptance-helpers';
import * as pulseControl from '../fixtures/sunlitPulsePolicy';

const assertions = vi.hoisted(() => ({
  visible: vi.fn(),
  count: vi.fn(),
  focused: vi.fn(),
}));

vi.mock('@playwright/test', () => ({
  expect: Object.assign(
    () => ({
      toBeVisible: assertions.visible,
      toHaveCount: assertions.count,
      toBeFocused: assertions.focused,
    }),
    {
      poll: (read: () => Promise<unknown>) => ({
        toBe: async (value: unknown) => expect(await read()).toBe(value),
      }),
    },
  ),
}));

vi.mock('../fixtures/sunlitPulsePolicy', () => ({
  sunlitPulsePolicy: vi.fn(),
  prepareSunlitPulsePolicy: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

function startup() {
  let playing = false;
  let unobservedRaceMs = 0;
  const calls: string[] = [];
  let failure: Error | undefined;
  const prepare = vi.mocked(pulseControl.prepareSunlitPulsePolicy);
  prepare.mockImplementation(() => {
    calls.push(`prepare:${playing}`);
  });
  function locator(name: string): Locator {
    const value: Pick<Locator, 'click' | 'press' | 'hover' | 'focus'> = {
      click: () => {
        calls.push(`click:${name}`);
        if (name === 'Load Sunlit Shoals') playing = true;
        return Promise.resolve();
      },
      press: (key) => {
        calls.push(`press:${name}:${key}`);
        if (name === 'Load Sunlit Shoals' && key === 'Enter') playing = true;
        return Promise.resolve();
      },
      hover: () => {
        calls.push(`hover:${playing}`);
        if (playing) unobservedRaceMs += 2589;
        return failure ? Promise.reject(failure) : Promise.resolve();
      },
      focus: () => {
        calls.push(`focus:${playing}`);
        if (playing) unobservedRaceMs += 1179;
        return Promise.resolve();
      },
    };
    return value as Locator;
  }
  const page: Pick<Page, 'getByRole' | 'locator' | 'evaluate'> = {
    getByRole: (_role, options) => locator(String(options?.name)),
    locator,
    evaluate: vi.fn<Page['evaluate']>().mockImplementation(() =>
      Promise.resolve({
        screen: playing ? 'playing' : 'title',
      }),
    ),
  };
  return {
    page: page as Page,
    calls,
    prepare,
    failHover: (error: Error) => {
      failure = error;
    },
    get playing() {
      return playing;
    },
    get unobservedRaceMs() {
      return unobservedRaceMs;
    },
  };
}

it('does pointer placement, focus and planner preflight before starting the timed race', async () => {
  const h = startup();
  await loadSunlit(h.page);
  expect(h.unobservedRaceMs).toBe(0);
  expect(h.calls).toContain('prepare:false');
  expect(h.calls).toContain('hover:false');
  expect(h.calls).toContain('focus:false');
  expect(h.calls.at(-1)).toBe('press:Load Sunlit Shoals:Enter');
  expect(h.playing).toBe(true);
  expect(assertions.visible).toHaveBeenCalledTimes(1);
  expect(assertions.count).toHaveBeenCalledExactlyOnceWith(1);
  expect(assertions.focused).toHaveBeenCalledTimes(1);
});

it('does not start the race if preflight pointer placement fails', async () => {
  const h = startup();
  const failure = new Error('Pointer placement failed');
  h.failHover(failure);
  await expect(loadSunlit(h.page)).rejects.toBe(failure);
  expect(h.playing).toBe(false);
});

it('retains ordinary native click selection for non-driver loading scenarios', async () => {
  const h = startup();
  await selectSunlit(h.page);
  expect(h.calls).toEqual(['click:Dive in', 'click:Load Sunlit Shoals']);
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.playing).toBe(true);
  expect(assertions.visible).toHaveBeenCalledTimes(1);
});
