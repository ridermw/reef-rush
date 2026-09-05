import type { SceneSnapshot } from '../../src/game/core/SceneRuntime';
import type { Vector3 } from '../../src/game/course/courseDefinition';
import { SCENE_FISH_TUNING } from '../../src/game/core/sceneRuntimeTuning';
import { stepFishMotion } from '../../src/game/player/stepFishMotion';
import type { FishState } from '../../src/game/player/fishTypes';
import { TRAVERSAL_STEP_SECONDS } from './courseTraversal';

export type CourseKey =
  'a' | 'd' | 'ArrowUp' | 'ArrowDown' | 'w' | 's' | 'Shift';

export interface KeyboardObservation {
  fish: SceneSnapshot['fish'];
  steps: number;
}

export interface CourseKeyboardInput {
  observation: KeyboardObservation;
  previous?: KeyboardObservation;
  target: Vector3;
}

export function courseKeyboardPolicy({
  observation: { fish, steps },
  previous,
  target,
}: CourseKeyboardInput) {
  const dx = target[0] - fish.position[0];
  const dy = target[1] - fish.position[1];
  const dz = target[2] - fish.position[2];
  const yawError = Math.atan2(
    Math.sin(Math.atan2(dx, dz) - fish.yaw),
    Math.cos(Math.atan2(dx, dz) - fish.yaw),
  );
  const targetPitch = Math.atan2(dy, Math.max(1, Math.hypot(dx, dz)));
  const speed = Math.hypot(...fish.velocity);
  const throttle = speed > 4 ? -1 : speed < 3 ? 1 : 0;
  const brakeHeld = Math.abs(yawError) > 0.6;
  // Native IPC spanned 1-43 physics steps in the baseline, not one fixed tick.
  // Cap stale intervals at one second; do not project an unbounded browser stall.
  const horizonSteps = Math.max(
    1,
    Math.min(60, previous ? steps - previous.steps : 1),
  );
  const targetYaw = fish.yaw + yawError;
  let best = { steerX: 0, steerY: 0, error: Infinity };
  for (const steerX of [0, -1, 1]) {
    for (const steerY of [0, -1, 1]) {
      let predicted: FishState = {
        ...fish,
        position: [...fish.position],
        velocity: [...fish.velocity],
      };
      for (let step = 0; step < horizonSteps; step++) {
        predicted = stepFishMotion(
          predicted,
          {
            steerX,
            steerY,
            throttle,
            brakeHeld,
            dashPressed: false,
            pausePressed: false,
          },
          SCENE_FISH_TUNING,
          { current: [0, 0, 0], waterSurfaceY: 0 },
          TRAVERSAL_STEP_SECONDS,
        ).next;
      }
      const yaw = Math.atan2(
        Math.sin(targetYaw - predicted.yaw),
        Math.cos(targetYaw - predicted.yaw),
      );
      const error = yaw ** 2 + (targetPitch - predicted.pitch) ** 2;
      if (error < best.error) best = { steerX, steerY, error };
    }
  }
  const keys = new Set<CourseKey>();
  if (best.steerX !== 0) keys.add(best.steerX > 0 ? 'a' : 'd');
  if (best.steerY !== 0) keys.add(best.steerY > 0 ? 'ArrowUp' : 'ArrowDown');
  if (throttle !== 0) keys.add(throttle > 0 ? 'w' : 's');
  if (brakeHeld) keys.add('Shift');
  return { keys: [...keys], yawError, targetPitch, speed, horizonSteps };
}
