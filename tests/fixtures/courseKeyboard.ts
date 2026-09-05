import { expect, type Page } from '@playwright/test';
import type { HostSnapshot } from '../../src/game/core/GameHost';
import type { SceneSnapshot } from '../../src/game/core/SceneRuntime';
import type { CourseDefinition } from '../../src/game/course/courseDefinition';
import {
  advanceCourseWaypoint,
  courseSteeringTarget,
  courseWaypoints,
} from './courseTraversal';
import { keyboardSurface, snapshot } from '../browser/acceptance-helpers';
import {
  courseKeyboardPolicy,
  type CourseKey,
  type KeyboardObservation,
} from './courseKeyboardPolicy';
import { releaseNativeKeys, setNativeKeys } from './nativeKeyboard';

// Binary native keys, not the normalized fixed-step controller. The authored
// policy advances only on observed checkpoint crossings and actual pearl IDs.
export async function driveCourseByKeyboard(
  page: Page,
  course: CourseDefinition,
  onCheckpoint?: (state: HostSnapshot) => Promise<void>,
) {
  await keyboardSurface(page);
  const goals = courseWaypoints(course);
  const held = new Set<CourseKey>();
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
  let capturedCheckpoint = 0;
  let previous: KeyboardObservation | undefined;
  let failure: { error: unknown } | undefined;
  const keyPolicy: Array<
    KeyboardObservation &
      ReturnType<typeof courseKeyboardPolicy> & {
        goalId: string;
        target: readonly [number, number, number];
        observedStepDelta: number;
        elapsedMs: number;
        approachingCheckpoint: boolean;
      }
  > = [];
  let state = await snapshot(page);
  const initialSteps = state.frame.steps;
  const started = Date.now();
  const deadline = started + 180_000;

  function observe(current: HostSnapshot): SceneSnapshot {
    if (!current.player || !current.race)
      throw new Error(
        `Missing active ${course.courseId} race/player: ${JSON.stringify(current)}`,
      );
    const { player, race, collectedPearlIds } = current;
    expect(race.courseId).toBe(course.courseId);
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
        id: course.checkpoints[race.checkpointIndex - 1].id,
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
      if (onCheckpoint && observed.race.checkpointIndex > capturedCheckpoint) {
        capturedCheckpoint = observed.race.checkpointIndex;
        await onCheckpoint(state);
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
          `Native ${course.courseId} recovery: ${JSON.stringify({ goal, observed, steps: state.frame.steps })}`,
        );
      }
      const observation = { fish: observed.fish, steps: state.frame.steps };
      const decision = courseKeyboardPolicy({
        observation,
        previous,
        target: steering.target,
      });
      keyPolicy.push({
        ...observation,
        ...decision,
        goalId: goal.id,
        target: steering.target,
        observedStepDelta: previous ? observation.steps - previous.steps : 0,
        elapsedMs: observed.race.elapsedMs,
        approachingCheckpoint,
      });
      previous = observation;
      const keys = new Set(decision.keys);
      await setNativeKeys(page.keyboard, held, keys);
      const nextFrame = await page.evaluate(
        ({ previous, courseId }) =>
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
                      `Native ${courseId} stopped advancing: ${JSON.stringify(next)}`,
                    ),
                  );
                } else requestAnimationFrame(read);
              };
              requestAnimationFrame(read);
            },
          ),
        { previous: state.frame.steps, courseId: course.courseId },
      );
      state = nextFrame.state;
      if (state.race) {
        if (
          nextFrame.hud[1] ===
          `${state.race.checkpointIndex} / ${course.checkpoints.length}`
        )
          hudCheckpoints.add(state.race.checkpointIndex);
        if (nextFrame.hud[2] === String(state.race.pearlCount))
          hudPearls.add(state.race.pearlCount);
      }
    }
    observe(state);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try {
      await releaseNativeKeys(page.keyboard, held, failure);
    } finally {
      console.info(
        `Native ${course.courseId} observation: ${JSON.stringify({
          waypoint,
          steps: state.frame.steps - initialSteps,
          wallMs: Date.now() - started,
          milestones,
          recoveries: [...recoveries],
          state,
        })}`,
      );
    }
  }
  expect(state.screen, JSON.stringify({ waypoint, state, milestones })).toBe(
    'results',
  );
  const expectedCheckpoints = course.checkpoints.map((_, index) => index + 1);
  expect(checkpoints).toEqual(expectedCheckpoints);
  const expectedIds = (course.pearls ?? []).map((pearl) => pearl.id);
  expect([...pearlIds]).toEqual(expectedIds);
  expect(state.collectedPearlIds).toEqual(expectedIds);
  for (const checkpoint of expectedCheckpoints.slice(0, -1))
    expect(hudCheckpoints.has(checkpoint)).toBe(true);
  for (let count = 1; count <= expectedIds.length; count++)
    expect(hudPearls.has(count)).toBe(true);
  expect(state.race).toMatchObject({
    status: 'finished',
    checkpointIndex: course.checkpoints.length,
    checkpointCount: course.checkpoints.length,
    pearlCount: expectedIds.length,
    totalPearls: expectedIds.length,
  });
  const result = state.race?.result;
  if (!result)
    throw new Error(`Actual ${course.courseId} finish has no result.`);
  const limits = course.medalTimesMs;
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
    keyPolicy,
  };
}
