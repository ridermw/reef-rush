import type {
  SceneRuntime,
  SceneSnapshot,
} from '../../src/game/core/SceneRuntime';
import type {
  CourseDefinition,
  Vector3,
} from '../../src/game/course/courseDefinition';
import {
  inputFrameSchema,
  type InputFrame,
} from '../../src/game/input/InputFrame';
import type { RaceEvent } from '../../src/game/race/raceTypes';

export const KELPWORKS_STEP_SECONDS = 1 / 60;
export const KELPWORKS_MAX_STEPS = 120 * 60;
export type KelpworksProfile = 'fast' | 'conservative';

export interface KelpworksWaypoint {
  position: Vector3;
  id: string;
  checkpointIndex?: number;
}

export function kelpworksWaypoints(definition: CourseDefinition) {
  return [
    ...definition.checkpoints.map((checkpoint, index) => ({
      position: checkpoint.position,
      id: checkpoint.id,
      checkpointIndex: index,
    })),
    ...(definition.pearls ?? []).map((pearl) => ({
      position: pearl.position,
      id: pearl.id,
    })),
  ].sort((a, b) => a.position[2] - b.position[2]);
}

export function advanceKelpworksWaypoint(
  goals: readonly KelpworksWaypoint[],
  waypoint: number,
  observed: SceneSnapshot,
) {
  while (waypoint < goals.length - 1) {
    const goal = goals[waypoint];
    const awarded =
      goal.checkpointIndex === undefined
        ? observed.collectedPearlIds.includes(goal.id)
        : observed.race.checkpointIndex > goal.checkpointIndex;
    if (!awarded) break;
    waypoint++;
  }
  return waypoint;
}

export function kelpworksSteeringTarget(
  goal: KelpworksWaypoint,
  observed: SceneSnapshot,
  approachingCheckpoint = false,
) {
  if (
    goal.checkpointIndex !== undefined &&
    observed.race.checkpointIndex <= goal.checkpointIndex &&
    (approachingCheckpoint || observed.fish.position[2] >= goal.position[2])
  ) {
    const approach: Vector3 = [
      goal.position[0],
      goal.position[1],
      goal.position[2] - 6,
    ];
    if (
      Math.hypot(
        ...approach.map((value, axis) => value - observed.fish.position[axis]),
      ) > 1
    ) {
      return { target: approach, approachingCheckpoint: true };
    }
  }
  return { target: goal.position, approachingCheckpoint: false };
}

function clampAxis(value: number) {
  return Math.max(-1, Math.min(1, value));
}

export function traverseKelpworks(
  runtime: SceneRuntime,
  profile: KelpworksProfile,
  observe?: (snapshot: SceneSnapshot) => void,
) {
  const goals = kelpworksWaypoints(runtime.definition);
  const events: RaceEvent[] = [];
  const milestones: Array<{ id: string; step: number; position: Vector3 }> = [];
  const collisions: Array<{ step: number; position: Vector3 }> = [];
  let waypoint = 0;
  let approachingCheckpoint = false;
  let steps = 0;
  let dashes = 0;
  let steeringSteps = 0;
  let lastDashStep = -120;
  runtime.start();
  for (
    ;
    steps < KELPWORKS_MAX_STEPS &&
    runtime.getSnapshot().race.status !== 'finished';
    steps++
  ) {
    const snapshot = runtime.getSnapshot();
    observe?.(snapshot);
    const nextWaypoint = advanceKelpworksWaypoint(goals, waypoint, snapshot);
    if (nextWaypoint !== waypoint) approachingCheckpoint = false;
    waypoint = nextWaypoint;
    const steering = kelpworksSteeringTarget(
      goals[waypoint],
      snapshot,
      approachingCheckpoint,
    );
    approachingCheckpoint = steering.approachingCheckpoint;
    const { fish } = snapshot;
    const dx = steering.target[0] - fish.position[0];
    const dy = steering.target[1] - fish.position[1];
    const dz = steering.target[2] - fish.position[2];
    const yawError = Math.atan2(
      Math.sin(Math.atan2(dx, dz) - fish.yaw),
      Math.cos(Math.atan2(dx, dz) - fish.yaw),
    );
    const input: InputFrame = inputFrameSchema.parse({
      steerX: clampAxis(yawError * 3),
      // This is an absolute pitch target, not a pitch-rate command.
      steerY: clampAxis(Math.atan2(dy, Math.hypot(dx, dz)) / (Math.PI / 3)),
      throttle: profile === 'fast' && Math.abs(yawError) < 0.35 ? 0.5 : -0.3,
      brakeHeld: Math.abs(yawError) > 1,
      dashPressed:
        profile === 'fast' &&
        !approachingCheckpoint &&
        Math.abs(yawError) < 0.1 &&
        Math.hypot(dx, dy, dz) > 6 &&
        Math.hypot(...fish.velocity) < 8 &&
        fish.dashEnergy >= 0.35 &&
        steps - lastDashStep >= 120,
      pausePressed: false,
    });
    if (input.dashPressed) lastDashStep = steps;
    if (Math.abs(input.steerX) > 0.01) steeringSteps++;
    const result = runtime.step(input, KELPWORKS_STEP_SECONDS);
    events.push(...result.raceEvents);
    for (const event of result.raceEvents) {
      if (event.type !== 'finish') {
        milestones.push({
          id: event.type === 'checkpoint' ? event.checkpointId : event.pearlId,
          step: steps + 1,
          position: result.snapshot.fish.position,
        });
      }
    }
    for (const event of result.fishEvents) {
      if (event.type === 'dash') dashes++;
      if (event.type === 'collision')
        collisions.push({
          step: steps + 1,
          position: result.snapshot.fish.position,
        });
    }
    runtime.present(1, KELPWORKS_STEP_SECONDS);
  }
  return {
    steps,
    steeringSteps,
    events,
    milestones,
    collisions,
    dashes,
    waypoint,
    snapshot: runtime.getSnapshot(),
  };
}
