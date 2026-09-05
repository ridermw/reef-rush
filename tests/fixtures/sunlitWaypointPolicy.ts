import sunlit from '../../src/content/courses/sunlitShoals';
import type { Vector3 } from '../../src/game/course/courseDefinition';

export const sunlitWaypoints = [
  { position: sunlit.checkpoints[0].position, checkpoints: 1, pearls: 0 },
  { position: sunlit.pearls[0].position, checkpoints: 1, pearls: 1 },
  { position: sunlit.checkpoints[1].position, checkpoints: 2, pearls: 1 },
  { position: sunlit.pearls[1].position, checkpoints: 2, pearls: 2 },
  { position: sunlit.checkpoints[2].position, checkpoints: 3, pearls: 2 },
  { position: sunlit.pearls[2].position, checkpoints: 3, pearls: 3 },
  { position: sunlit.pearls[3].position, checkpoints: 3, pearls: 4 },
  { position: [0, -4, 93], checkpoints: 4, pearls: 4 },
] satisfies { position: Vector3; checkpoints: number; pearls: number }[];

interface RouteObservation {
  position: Vector3;
  checkpointIndex: number;
  pearlCount: number;
}

export function advanceSunlitWaypoint(
  waypoint: number,
  observed: RouteObservation,
) {
  while (
    waypoint < sunlitWaypoints.length - 1 &&
    observed.position[2] >= sunlitWaypoints[waypoint].position[2] &&
    observed.checkpointIndex >= sunlitWaypoints[waypoint].checkpoints &&
    observed.pearlCount >= sunlitWaypoints[waypoint].pearls
  ) {
    waypoint++;
  }
  return waypoint;
}

export function sunlitSteeringTarget(
  waypoint: number,
  observed: RouteObservation,
  approachingCheckpoint = false,
) {
  const goal = sunlitWaypoints[waypoint];
  if (observed.checkpointIndex < goal.checkpoints) {
    const checkpoint = sunlit.checkpoints[observed.checkpointIndex];
    if (
      approachingCheckpoint ||
      observed.position[2] >= checkpoint.position[2]
    ) {
      // Sunlit planes face +Z. Back up far enough to brake, turn and recross;
      // returning to the plane itself from downstream cannot award a crossing.
      const approach: Vector3 = [
        checkpoint.position[0],
        checkpoint.position[1],
        checkpoint.position[2] - 6,
      ];
      if (
        Math.hypot(
          approach[0] - observed.position[0],
          approach[1] - observed.position[1],
          approach[2] - observed.position[2],
        ) > 1
      ) {
        return { target: approach, approachingCheckpoint: true };
      }
    }
  }
  return {
    target: goal.position,
    approachingCheckpoint: false,
  };
}
