import sunlit from '../../src/content/courses/sunlitShoals';
import type { SceneRuntime } from '../../src/game/core/SceneRuntime';
import type { InputFrame } from '../../src/game/input/InputFrame';

export const generatedSunlit = {
  ...sunlit,
  visuals: {
    kind: 'generated' as const,
    waterColor: sunlit.visuals.waterColor,
    seabedColor: sunlit.visuals.seabedColor,
  },
};

export const forwardInput: InputFrame = {
  steerX: 0,
  steerY: 0,
  throttle: 1,
  brakeHeld: false,
  dashPressed: false,
  pausePressed: false,
};

export function traverseSunlit(runtime: SceneRuntime, present = false) {
  runtime.start();
  const points = [
    [0, -4, 12],
    [0, -4, 18],
    [5, -4, 36],
    [5, -4, 40],
    [-4, -5, 60],
    [-4, -5, 64],
    [0, -4, 84],
    [0, -4, 93],
  ];
  const checkpointIds: string[] = [];
  const pearlIds: string[] = [];
  let waypoint = 0;
  let steps = 0;
  let steeringSteps = 0;
  for (
    ;
    steps < 3600 && runtime.getSnapshot().race.status !== 'finished';
    steps++
  ) {
    const fish = runtime.getSnapshot().fish;
    const target = points[waypoint];
    const dx = target[0] - fish.position[0];
    const dy = target[1] - fish.position[1];
    const dz = target[2] - fish.position[2];
    const yawError = Math.atan2(
      Math.sin(Math.atan2(dx, dz) - fish.yaw),
      Math.cos(Math.atan2(dx, dz) - fish.yaw),
    );
    const steerX = Math.max(-1, Math.min(1, yawError * 3));
    if (Math.abs(steerX) > 0.01) steeringSteps++;
    const result = runtime.step(
      {
        ...forwardInput,
        throttle: -0.3,
        steerX,
        steerY: Math.max(
          -1,
          Math.min(1, Math.atan2(dy, Math.hypot(dx, dz)) / (Math.PI / 3)),
        ),
      },
      1 / 60,
    );
    for (const event of result.raceEvents) {
      if (event.type === 'checkpoint') checkpointIds.push(event.checkpointId);
      if (event.type === 'pearl') pearlIds.push(event.pearlId);
    }
    if (
      waypoint < points.length - 1 &&
      result.snapshot.fish.position[2] >= target[2]
    )
      waypoint++;
    if (present) runtime.present(1, 1 / 60);
  }
  return { steps, steeringSteps, checkpointIds, pearlIds };
}
