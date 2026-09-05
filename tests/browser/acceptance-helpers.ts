import { expect, type Page } from '@playwright/test';
import sunlit from '../../src/content/courses/sunlitShoals';
import type { HostSnapshot } from '../../src/game/core/GameHost';
import {
  advanceSunlitWaypoint,
  sunlitSteeringTarget,
  sunlitWaypoints,
} from '../fixtures/sunlitWaypointPolicy';

export const progressKey = 'reef-rush.progress';

export async function snapshot(page: Page): Promise<HostSnapshot> {
  return page.evaluate(() => {
    const hook = window.__REEF_RUSH_TEST__;
    if (!hook) throw new Error('Read-only acceptance diagnostics are missing.');
    return hook.getSnapshot();
  });
}

export async function screen(page: Page, value: HostSnapshot['screen']) {
  await expect.poll(async () => (await snapshot(page)).screen).toBe(value);
}

export async function frames(page: Page, count = 4) {
  const before = await snapshot(page);
  await page.waitForFunction(
    ({ rendered, count }) =>
      (window.__REEF_RUSH_TEST__?.getSnapshot().frame.rendered ?? 0) >=
      rendered + count,
    { rendered: before.frame.rendered, count },
  );
  return snapshot(page);
}

export async function steps(page: Page, count = 4) {
  const before = await snapshot(page);
  await page.waitForFunction(
    ({ steps, count }) => {
      const state = window.__REEF_RUSH_TEST__?.getSnapshot();
      return state?.screen !== 'playing' || state.frame.steps >= steps + count;
    },
    { steps: before.frame.steps, count },
    { timeout: 10_000 },
  );
  return snapshot(page);
}

export async function wallInterval(page: Page, milliseconds = 600) {
  const start = await page.evaluate(() => performance.now());
  await page.waitForFunction(
    ({ start, milliseconds }) => performance.now() - start >= milliseconds,
    { start, milliseconds },
  );
}

export async function keyboardSurface(page: Page) {
  await page.locator('.hud-header').hover();
  await page.locator('#game-root canvas').focus();
  await expect(page.locator('#game-root canvas')).toBeFocused();
}

export async function selectSunlit(page: Page) {
  await page.getByRole('button', { name: 'Dive in' }).click();
  await expect(
    page.getByRole('heading', { name: 'Choose a course' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Blacksmoker Run - not yet available' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Load Sunlit Shoals' }).click();
}

export async function loadSunlit(page: Page) {
  await selectSunlit(page);
  await screen(page, 'playing');
  await expect(page.locator('#game-root canvas')).toHaveCount(1);
  await keyboardSurface(page);
}

export async function expectDraw(page: Page) {
  const draw = await page.locator('#game-root canvas').evaluate(
    (canvas: HTMLCanvasElement) =>
      new Promise<{ webgl2: boolean; colors: number; width: number }>(
        (resolve) => {
          requestAnimationFrame(() => {
            const gl = canvas.getContext('webgl2');
            if (!gl) {
              resolve({ webgl2: false, colors: 0, width: canvas.width });
              return;
            }
            const pixels = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(
              0,
              0,
              canvas.width,
              canvas.height,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixels,
            );
            const colors = new Set<string>();
            for (let i = 0; i < pixels.length; i += 4 * 101) {
              colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
            }
            resolve({ webgl2: true, colors: colors.size, width: canvas.width });
          });
        },
      ),
  );
  expect(draw.webgl2).toBe(true);
  expect(draw.width).toBeGreaterThan(300);
  expect(draw.colors).toBeGreaterThan(8);
  return draw;
}

export function timeLabel(elapsedMs: number) {
  const seconds = Math.floor(elapsedMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${String(Math.floor((elapsedMs % 1000) / 10)).padStart(2, '0')}`;
}

export async function expectIdle(page: Page) {
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect.poll(async () => (await snapshot(page)).lifecycle).toBe('idle');
  const before = await snapshot(page);
  expect(before.resources).toEqual({
    canvases: 0,
    rafChains: 0,
    pendingCleanup: 0,
    scene: null,
  });
  expect(before.cleanupError).toBeNull();
  await wallInterval(page);
  expect((await snapshot(page)).frame).toEqual(before.frame);
}

// Authored CP/pearl route from the real SceneRuntime and GameHost traversals.
// All control goes through Playwright's native keyboard; snapshots are read-only.
export async function driveSunlit(page: Page) {
  const held = new Set<string>();
  const checkpoints: number[] = [];
  const pearls: number[] = [];
  const hudCheckpoints = new Set<number>();
  const hudPearls = new Set<number>();
  const recoveryWaypoints = new Set<number>();
  let waypoint = 0;
  let approachingCheckpoint = false;
  let nextRecoveryLog = 0;
  let state = await snapshot(page);
  const deadline = Date.now() + 120_000;
  try {
    while (state.screen === 'playing' && Date.now() < deadline) {
      const fish = state.player;
      const race = state.race;
      if (!fish || !race) throw new Error('Missing active race/player.');
      if (race.checkpointIndex !== (checkpoints.at(-1) ?? 0))
        checkpoints.push(race.checkpointIndex);
      if (race.pearlCount !== (pearls.at(-1) ?? 0))
        pearls.push(race.pearlCount);
      const observation = {
        position: fish.position,
        checkpointIndex: race.checkpointIndex,
        pearlCount: race.pearlCount,
      };
      const nextWaypoint = advanceSunlitWaypoint(waypoint, observation);
      while (waypoint < nextWaypoint) {
        console.info(
          `Waypoint ${waypoint}: ${JSON.stringify({ position: fish.position, pitch: fish.pitch, yaw: fish.yaw, checkpoints: race.checkpointIndex, pearls: race.pearlCount })}`,
        );
        waypoint++;
        approachingCheckpoint = false;
      }
      const steering = sunlitSteeringTarget(
        waypoint,
        observation,
        approachingCheckpoint,
      );
      approachingCheckpoint = steering.approachingCheckpoint;
      const goal = sunlitWaypoints[waypoint];
      if (
        !recoveryWaypoints.has(waypoint) &&
        (approachingCheckpoint ||
          (fish.position[2] >= goal.position[2] &&
            (race.checkpointIndex < goal.checkpoints ||
              race.pearlCount < goal.pearls)))
      ) {
        recoveryWaypoints.add(waypoint);
        nextRecoveryLog = 0;
      }
      if (
        recoveryWaypoints.has(waypoint) &&
        state.frame.steps >= nextRecoveryLog
      ) {
        console.info(
          `Recovering waypoint ${waypoint}: ${JSON.stringify({ ...observation, target: steering.target, approachingCheckpoint, yaw: fish.yaw, pitch: fish.pitch, steps: state.frame.steps })}`,
        );
        nextRecoveryLog = state.frame.steps + 120;
      }
      const [x, y, z] = steering.target;
      const dx = x - fish.position[0];
      const dy = y - fish.position[1];
      const dz = z - fish.position[2];
      const yawError = Math.atan2(
        Math.sin(Math.atan2(dx, dz) - fish.yaw),
        Math.cos(Math.atan2(dx, dz) - fish.yaw),
      );
      const pitch = Math.atan2(dy, Math.max(1, Math.hypot(dx, dz)));
      const keys = new Set<string>();
      if (Math.abs(yawError) > 0.025) keys.add(yawError > 0 ? 'a' : 'd');
      if (Math.abs(pitch - fish.pitch) > 0.06)
        keys.add(pitch > fish.pitch ? 'ArrowUp' : 'ArrowDown');
      const speed = Math.hypot(...fish.velocity);
      if (speed > 4) keys.add('s');
      else if (speed < 3) keys.add('w');
      if (Math.abs(yawError) > 0.6) keys.add('Shift');
      for (const key of held) {
        if (!keys.has(key)) {
          await page.keyboard.up(key);
          held.delete(key);
        }
      }
      for (const key of keys) {
        if (!held.has(key)) {
          await page.keyboard.down(key);
          held.add(key);
        }
      }
      const observed = await page.evaluate(
        (previous) =>
          new Promise<{ state: HostSnapshot; hud: (string | null)[] }>(
            (resolve) => {
              const observe = () => {
                const next = window.__REEF_RUSH_TEST__!.getSnapshot();
                if (next.screen !== 'playing' || next.frame.steps > previous) {
                  resolve({
                    state: next,
                    hud: [...document.querySelectorAll('.hud-card strong')].map(
                      (element) => element.textContent,
                    ),
                  });
                } else requestAnimationFrame(observe);
              };
              requestAnimationFrame(observe);
            },
          ),
        state.frame.steps,
      );
      state = observed.state;
      if (state.race) {
        if (observed.hud[1] === `${state.race.checkpointIndex} / 4`)
          hudCheckpoints.add(state.race.checkpointIndex);
        if (observed.hud[2] === String(state.race.pearlCount))
          hudPearls.add(state.race.pearlCount);
      }
    }
  } finally {
    for (const key of held) await page.keyboard.up(key);
  }
  if (state.race?.checkpointIndex !== checkpoints.at(-1))
    checkpoints.push(state.race?.checkpointIndex ?? -1);
  expect(state.screen, JSON.stringify({ waypoint, state })).toBe('results');
  expect(checkpoints).toEqual([1, 2, 3, 4]);
  expect(pearls).toEqual([1, 2, 3, 4]);
  for (const checkpoint of [1, 2, 3])
    expect(hudCheckpoints.has(checkpoint)).toBe(true);
  for (const pearl of [1, 2, 3, 4]) expect(hudPearls.has(pearl)).toBe(true);
  expect(state.race).toMatchObject({
    status: 'finished',
    checkpointIndex: 4,
    checkpointCount: 4,
    pearlCount: 4,
    totalPearls: 4,
  });
  const result = state.race?.result;
  if (!result) throw new Error('The actual finish has no result.');
  const limits = sunlit.medalTimesMs;
  const medal =
    result.elapsedMs <= limits.gold
      ? 'gold'
      : result.elapsedMs <= limits.silver
        ? 'silver'
        : result.elapsedMs <= limits.bronze
          ? 'bronze'
          : null;
  expect(result.medal).toBe(medal);
  await expect(page.getByText('Run complete', { exact: true })).toBeVisible();
  await expect(page.locator('.results-time')).toHaveText(
    timeLabel(result.elapsedMs),
  );
  await expect(
    page.getByText(medal ? `${medal} medal` : 'No medal this run', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText('4 / 4 pearls', { exact: true })).toBeVisible();
  await page.keyboard.press('w');
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  const after = await frames(page);
  expect(after.frame.steps).toBe(state.frame.steps);
  expect(after.race).toEqual(state.race);
  console.info(
    `Real keyboard finish: ${JSON.stringify({ result, steps: state.frame.steps, checkpoints, pearls, hudCheckpoints: [...hudCheckpoints], hudPearls: [...hudPearls], recoveryWaypoints: [...recoveryWaypoints] })}`,
  );
  return result;
}
