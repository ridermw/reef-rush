import { expect, type Page } from '@playwright/test';
import kelpworks from '../../src/content/courses/kelpworks';
import type { HostSnapshot } from '../../src/game/core/GameHost';
import type { SceneSnapshot } from '../../src/game/core/SceneRuntime';
import {
  advanceCourseWaypoint,
  courseSteeringTarget,
  courseWaypoints,
} from './courseTraversal';
import { keyboardSurface, snapshot } from '../browser/acceptance-helpers';

// Binary native keys, not the normalized fixed-step controller. The authored
// policy advances only on observed checkpoint crossings and actual pearl IDs.
export async function driveKelpworks(
  page: Page,
  onDeepCheckpoint?: (state: HostSnapshot) => Promise<void>,
) {
  await keyboardSurface(page);
  const goals = courseWaypoints(kelpworks);
  const held = new Set<string>();
  const checkpoints: number[] = [];
  const pearlIds = new Set<string>();
  const milestones: Array<{
    id: string;
    steps: number;
    position: readonly [number, number, number];
  }> = [];
  const hudCheckpoints = new Set<number>();
  const hudPearls = new Set<number>();
  const recoveries = new Set<string>();
  let waypoint = 0;
  let approachingCheckpoint = false;
  let capturedDeep = false;
  let state = await snapshot(page);
  const initialSteps = state.frame.steps;
  const started = Date.now();
  const deadline = started + 180_000;

  function observe(current: HostSnapshot): SceneSnapshot {
    if (!current.player || !current.race)
      throw new Error(
        `Missing active Kelpworks race/player: ${JSON.stringify(current)}`,
      );
    const { player, race, collectedPearlIds } = current;
    expect(race.courseId).toBe('kelpworks');
    expect(collectedPearlIds.length).toBe(race.pearlCount);
    if (race.checkpointIndex !== (checkpoints.at(-1) ?? 0)) {
      if (race.status !== 'finished') {
        expect(current.feedback).toMatchObject({
          cue: 'checkpoint',
          text: `Checkpoint ${race.checkpointIndex} cleared`,
          announcement: `Checkpoint ${race.checkpointIndex} cleared`,
        });
      }
      checkpoints.push(race.checkpointIndex);
      milestones.push({
        id: kelpworks.checkpoints[race.checkpointIndex - 1].id,
        steps: current.frame.steps - initialSteps,
        position: player.position,
      });
    }
    for (const id of collectedPearlIds) {
      if (pearlIds.has(id)) continue;
      pearlIds.add(id);
      milestones.push({
        id,
        steps: current.frame.steps - initialSteps,
        position: player.position,
      });
    }
    return { fish: player, race, collectedPearlIds };
  }

  try {
    while (
      state.screen === 'playing' &&
      Date.now() < deadline &&
      state.frame.steps - initialSteps < 9000
    ) {
      const observed = observe(state);
      if (!capturedDeep && observed.race.checkpointIndex === 3) {
        capturedDeep = true;
        await onDeepCheckpoint?.(state);
        state = await snapshot(page);
        continue;
      }
      const next = advanceCourseWaypoint(goals, waypoint, observed);
      if (next !== waypoint) approachingCheckpoint = false;
      waypoint = next;
      const goal = goals[waypoint];
      const steering = courseSteeringTarget(
        goal,
        observed,
        approachingCheckpoint,
      );
      approachingCheckpoint = steering.approachingCheckpoint;
      if (approachingCheckpoint && !recoveries.has(goal.id)) {
        recoveries.add(goal.id);
        console.info(
          `Native Kelpworks recovery: ${JSON.stringify({ goal, observed, steps: state.frame.steps })}`,
        );
      }
      const { fish } = observed;
      const dx = steering.target[0] - fish.position[0];
      const dy = steering.target[1] - fish.position[1];
      const dz = steering.target[2] - fish.position[2];
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
      const nextFrame = await page.evaluate(
        (previous) =>
          new Promise<{ state: HostSnapshot; hud: (string | null)[] }>(
            (resolve, reject) => {
              const start = performance.now();
              const read = () => {
                const next = window.__REEF_RUSH_TEST__!.getSnapshot();
                if (next.screen !== 'playing' || next.frame.steps > previous) {
                  resolve({
                    state: next,
                    hud: [...document.querySelectorAll('.hud-card strong')].map(
                      (element) => element.textContent,
                    ),
                  });
                } else if (performance.now() - start > 5000) {
                  reject(
                    new Error(
                      `Native Kelpworks stopped advancing: ${JSON.stringify(next)}`,
                    ),
                  );
                } else requestAnimationFrame(read);
              };
              requestAnimationFrame(read);
            },
          ),
        state.frame.steps,
      );
      state = nextFrame.state;
      if (state.race) {
        if (nextFrame.hud[1] === `${state.race.checkpointIndex} / 5`)
          hudCheckpoints.add(state.race.checkpointIndex);
        if (nextFrame.hud[2] === String(state.race.pearlCount))
          hudPearls.add(state.race.pearlCount);
      }
    }
    observe(state);
  } finally {
    for (const key of held) await page.keyboard.up(key);
    console.info(
      `Native Kelpworks observation: ${JSON.stringify({
        waypoint,
        steps: state.frame.steps - initialSteps,
        wallMs: Date.now() - started,
        milestones,
        recoveries: [...recoveries],
        state,
      })}`,
    );
  }
  expect(state.screen, JSON.stringify({ waypoint, state, milestones })).toBe(
    'results',
  );
  expect(checkpoints).toEqual([1, 2, 3, 4, 5]);
  const expectedIds = kelpworks.pearls.map((pearl) => pearl.id);
  expect([...pearlIds]).toEqual(expectedIds);
  expect(state.collectedPearlIds).toEqual(expectedIds);
  for (const checkpoint of [1, 2, 3, 4])
    expect(hudCheckpoints.has(checkpoint)).toBe(true);
  for (const count of [1, 2, 3, 4, 5]) expect(hudPearls.has(count)).toBe(true);
  expect(state.race).toMatchObject({
    status: 'finished',
    checkpointIndex: 5,
    checkpointCount: 5,
    pearlCount: 5,
    totalPearls: 5,
  });
  const result = state.race?.result;
  if (!result) throw new Error('Actual Kelpworks finish has no result.');
  const limits = kelpworks.medalTimesMs;
  expect(result.medal).toBe(
    result.elapsedMs <= limits.gold
      ? 'gold'
      : result.elapsedMs <= limits.silver
        ? 'silver'
        : result.elapsedMs <= limits.bronze
          ? 'bronze'
          : null,
  );
  return {
    result,
    steps: state.frame.steps - initialSteps,
    wallMs: Date.now() - started,
    collectedPearlIds: state.collectedPearlIds,
    checkpoints,
    milestones,
    recoveries: [...recoveries],
    hudCheckpoints: [...hudCheckpoints],
    hudPearls: [...hudPearls],
  };
}
