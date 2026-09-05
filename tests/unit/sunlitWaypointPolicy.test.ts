import { describe, expect, it } from 'vitest';
import sunlit from '../../src/content/courses/sunlitShoals';
import {
  advanceSunlitWaypoint,
  sunlitSteeringTarget,
  sunlitWaypoints,
} from '../fixtures/sunlitWaypointPolicy';

describe('Sunlit browser waypoint advancement', () => {
  it('preserves all eight authored CP/pearl route points and bounded totals', () => {
    expect(sunlitWaypoints.map((goal) => goal.position)).toEqual([
      sunlit.checkpoints[0].position,
      sunlit.pearls[0].position,
      sunlit.checkpoints[1].position,
      sunlit.pearls[1].position,
      sunlit.checkpoints[2].position,
      sunlit.pearls[2].position,
      sunlit.pearls[3].position,
      [0, -4, 93],
    ]);
    expect(
      sunlitWaypoints.map(({ checkpoints, pearls }) => [checkpoints, pearls]),
    ).toEqual([
      [1, 0],
      [1, 1],
      [2, 1],
      [2, 2],
      [3, 2],
      [3, 3],
      [3, 4],
      [4, 4],
    ]);
  });

  describe('Sunlit keyboard recovery targets', () => {
    it.each([
      [0, 0],
      [2, 1],
      [4, 2],
      [7, 3],
    ])(
      'backs up from missed checkpoint goal %i, including the finish plane',
      (waypoint, checkpointIndex) => {
        const checkpoint = sunlit.checkpoints[checkpointIndex];
        const [x, y, z] = checkpoint.position;
        const observed = {
          position: [x + 5, y, z + 0.1] as const,
          checkpointIndex,
          pearlCount: sunlitWaypoints[waypoint].pearls,
        };
        expect(advanceSunlitWaypoint(waypoint, observed)).toBe(waypoint);
        expect(sunlitSteeringTarget(waypoint, observed)).toEqual({
          target: [x, y, z - 6],
          approachingCheckpoint: true,
        });
      },
    );

    it.each([
      [0, -4, 11.5],
      [5, -4, 6],
      [0, -6, 6],
    ] as const)(
      'keeps the upstream approach while at (%s, %s, %s), not just behind the plane',
      (x, y, z) => {
        expect(
          sunlitSteeringTarget(
            0,
            { position: [x, y, z], checkpointIndex: 0, pearlCount: 0 },
            true,
          ),
        ).toEqual({ target: [0, -4, 6], approachingCheckpoint: true });
      },
    );

    it('aims forward again only after reaching the upstream approach', () => {
      const observed = {
        position: [0, -4, 6.5] as const,
        checkpointIndex: 0,
        pearlCount: 0,
      };
      expect(sunlitSteeringTarget(0, observed, true)).toEqual({
        target: sunlit.checkpoints[0].position,
        approachingCheckpoint: false,
      });
      expect(advanceSunlitWaypoint(0, observed)).toBe(0);
      expect(
        sunlitSteeringTarget(0, { ...observed, position: [0, -4, 10] }),
      ).toEqual({
        target: sunlit.checkpoints[0].position,
        approachingCheckpoint: false,
      });
      expect(
        advanceSunlitWaypoint(0, {
          ...observed,
          position: [0, -4, 12.1],
          checkpointIndex: 1,
        }),
      ).toBe(1);
    });

    it('cancels checkpoint recovery when the real crossing is observed', () => {
      expect(
        sunlitSteeringTarget(
          0,
          { position: [0, -4, 12.1], checkpointIndex: 1, pearlCount: 0 },
          true,
        ),
      ).toEqual({
        target: sunlit.checkpoints[0].position,
        approachingCheckpoint: false,
      });
    });

    it.each([1, 3, 5, 6])(
      'steers back to the actual missed pearl at goal %i instead of waiting',
      (waypoint) => {
        const goal = sunlitWaypoints[waypoint];
        const observed = {
          position: [
            goal.position[0] + 1,
            goal.position[1],
            goal.position[2] + 1,
          ] as const,
          checkpointIndex: goal.checkpoints,
          pearlCount: goal.pearls - 1,
        };
        const held = advanceSunlitWaypoint(waypoint, observed);
        expect(held).toBe(waypoint);
        const steering = sunlitSteeringTarget(held, observed);
        expect(steering).toEqual({
          target: goal.position,
          approachingCheckpoint: false,
        });
        expect(steering.target[2]).toBeLessThan(observed.position[2]);
        expect(
          advanceSunlitWaypoint(held, {
            ...observed,
            position: goal.position,
            pearlCount: goal.pearls,
          }),
        ).toBe(waypoint + 1);
      },
    );
  });

  it.each([0, 2, 4])(
    'holds passed-depth checkpoint goal %i until the actual crossing',
    (waypoint) => {
      const goal = sunlitWaypoints[waypoint];
      expect(
        advanceSunlitWaypoint(waypoint, {
          position: [
            goal.position[0] + 5,
            goal.position[1],
            goal.position[2] + 1,
          ],
          checkpointIndex: goal.checkpoints - 1,
          pearlCount: goal.pearls,
        }),
      ).toBe(waypoint);
    },
  );

  it.each([1, 3, 5, 6])(
    'holds passed-depth pearl goal %i until the actual pickup',
    (waypoint) => {
      const goal = sunlitWaypoints[waypoint];
      expect(
        advanceSunlitWaypoint(waypoint, {
          position: [
            goal.position[0] + 1,
            goal.position[1],
            goal.position[2] + 1,
          ],
          checkpointIndex: goal.checkpoints,
          pearlCount: goal.pearls - 1,
        }),
      ).toBe(waypoint);
    },
  );

  it.each([0, 1, 2, 3, 4, 5, 6])(
    'advances goal %i at its depth with its actual cumulative milestones',
    (waypoint) => {
      const goal = sunlitWaypoints[waypoint];
      expect(
        advanceSunlitWaypoint(waypoint, {
          position: goal.position,
          checkpointIndex: goal.checkpoints,
          pearlCount: goal.pearls,
        }),
      ).toBe(waypoint + 1);
    },
  );

  it('still requires depth when a pearl was collected on its near side', () => {
    expect(
      advanceSunlitWaypoint(1, {
        position: [0, -4, 17.5],
        checkpointIndex: 1,
        pearlCount: 1,
      }),
    ).toBe(1);
  });

  it('requires prior milestones rather than rebasing counts after a missed goal', () => {
    const observed = {
      position: [0, -4, 85] as const,
      checkpointIndex: 3,
      pearlCount: 3,
    };
    const held = advanceSunlitWaypoint(0, observed);
    expect(held).toBe(6);
    expect(advanceSunlitWaypoint(held, observed)).toBe(6);
    expect(advanceSunlitWaypoint(held, { ...observed, pearlCount: 4 })).toBe(7);
  });

  it('does not skip the first missing checkpoint even far past the route', () => {
    expect(
      advanceSunlitWaypoint(0, {
        position: [0, -4, 100],
        checkpointIndex: 0,
        pearlCount: 4,
      }),
    ).toBe(0);
  });

  it('accepts later cumulative milestones without advancing past the final goal', () => {
    const observed = {
      position: [0, -4, 100] as const,
      checkpointIndex: 4,
      pearlCount: 4,
    };
    expect(advanceSunlitWaypoint(0, observed)).toBe(7);
    expect(advanceSunlitWaypoint(7, observed)).toBe(7);
  });
});
