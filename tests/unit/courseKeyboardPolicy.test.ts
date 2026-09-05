import { describe, expect, it } from 'vitest';
import { SCENE_FISH_TUNING } from '../../src/game/core/sceneRuntimeTuning';
import type { FishState } from '../../src/game/player/fishTypes';
import { stepFishMotion } from '../../src/game/player/stepFishMotion';
import {
  courseKeyboardPolicy,
  type CourseKey,
  type CourseKeyboardInput,
} from '../fixtures/courseKeyboardPolicy';

// Unchanged-policy baseline, first Kelp run, step 443: correction toward CP2.
const observed: CourseKeyboardInput = {
  observation: {
    steps: 443,
    fish: {
      position: [-4.285148584666791, -4, 34.06638411602992],
      velocity: [-0.1950337781275634, 0, 0.8022760877718998],
      yaw: -0.5203089736082553,
      pitch: -0.509548401403255,
      roll: 0.017577340223795805,
      dashEnergy: 1,
      isSubmerged: true,
    },
  },
  target: [-6, -4.5, 40],
};

function withInterval(steps: number): CourseKeyboardInput {
  return {
    ...observed,
    previous: {
      ...observed.observation,
      steps: observed.observation.steps - steps,
    },
  };
}

function actuate(input: CourseKeyboardInput, keys: CourseKey[], steps: number) {
  let fish: FishState = {
    ...input.observation.fish,
    position: [...input.observation.fish.position],
    velocity: [...input.observation.fish.velocity],
  };
  for (let step = 0; step < steps; step++) {
    fish = stepFishMotion(
      fish,
      {
        steerX: Number(keys.includes('a')) - Number(keys.includes('d')),
        steerY:
          Number(keys.includes('ArrowUp')) - Number(keys.includes('ArrowDown')),
        throttle: Number(keys.includes('w')) - Number(keys.includes('s')),
        brakeHeld: keys.includes('Shift'),
        dashPressed: false,
        pausePressed: false,
      },
      SCENE_FISH_TUNING,
      { current: [0, 0, 0], waterSurfaceY: 0 },
      1 / 60,
    ).next;
  }
  return fish;
}

describe('native course keyboard heading policy', () => {
  it('lets absolute pitch relax instead of pitching up past a shallower negative target over the observed 19 steps', () => {
    const input = withInterval(19);
    const decision = courseKeyboardPolicy(input);
    const neutral = actuate(input, ['w'], 19);
    const opposite = actuate(input, ['w', 'ArrowUp'], 19);
    expect(neutral.pitch).toBeCloseTo(-0.104602, 5);
    expect(opposite.pitch).toBeGreaterThan(0.7);
    expect(Math.abs(neutral.pitch - decision.targetPitch)).toBeLessThan(0.03);
    expect(decision.keys).not.toContain('ArrowUp');
    expect(
      Math.abs(actuate(input, decision.keys, 19).pitch - decision.targetPitch),
    ).toBeLessThanOrEqual(Math.abs(neutral.pitch - decision.targetPitch));
  });

  it('does use Up over one observed step when it is closer than neutral, not a blanket ban on opposite pitch', () => {
    const input = withInterval(1);
    const decision = courseKeyboardPolicy(input);
    expect(decision.keys).toContain('ArrowUp');
    expect(
      Math.abs(actuate(input, decision.keys, 1).pitch - decision.targetPitch),
    ).toBeLessThan(
      Math.abs(actuate(input, ['w'], 1).pitch - decision.targetPitch),
    );
  });

  it('does not hold rate yaw through alignment during the same measured interval', () => {
    const input = withInterval(19);
    const decision = courseKeyboardPolicy(input);
    const targetYaw = input.observation.fish.yaw + decision.yawError;
    const neutral = actuate(input, ['w'], 19);
    const turning = actuate(input, ['w', 'a'], 19);
    expect(Math.abs(turning.yaw - targetYaw)).toBeGreaterThan(
      Math.abs(neutral.yaw - targetYaw),
    );
    expect(decision.keys).not.toContain('a');
    expect(decision.keys).not.toContain('d');
  });

  it('uses the native positive-yaw key when a short interval needs that turn', () => {
    const decision = courseKeyboardPolicy(withInterval(1));
    expect(decision.keys).toContain('a');
    expect(decision.keys).not.toContain('d');
  });

  it('uses the native negative-yaw key across the wrapped angle boundary', () => {
    const input: CourseKeyboardInput = {
      ...withInterval(1),
      observation: {
        ...observed.observation,
        fish: {
          ...observed.observation.fish,
          position: [0, -4, 0],
          yaw: -Math.PI + 0.1,
          pitch: 0,
        },
      },
      target: [0, -4, -10],
    };
    const decision = courseKeyboardPolicy(input);
    expect(decision.keys).toContain('d');
    expect(decision.keys).not.toContain('a');
    expect(actuate(input, decision.keys, 1).yaw).toBeLessThan(
      input.observation.fish.yaw,
    );
  });

  it('starts with one physics step and bounds stale observation intervals', () => {
    expect(courseKeyboardPolicy(observed)).toEqual(
      courseKeyboardPolicy(withInterval(1)),
    );
    expect(courseKeyboardPolicy(withInterval(0))).toEqual(
      courseKeyboardPolicy(withInterval(1)),
    );
    expect(courseKeyboardPolicy(withInterval(43)).horizonSteps).toBe(43);
    expect(courseKeyboardPolicy(withInterval(400))).toEqual(
      courseKeyboardPolicy(withInterval(60)),
    );
  });

  it.each([1, 3, 19, 43, 60])(
    'emits no conflicting native keys over %i observed physics steps',
    (steps) => {
      const { keys } = courseKeyboardPolicy(withInterval(steps));
      for (const pair of [
        ['a', 'd'],
        ['ArrowUp', 'ArrowDown'],
        ['w', 's'],
      ] satisfies CourseKey[][]) {
        expect(
          keys.filter((key) => pair.some((candidate) => candidate === key))
            .length,
        ).toBeLessThanOrEqual(1);
      }
    },
  );

  it('returns repeatable decisions without changing observations or target', () => {
    const input = withInterval(19);
    const before = structuredClone(input);
    expect(courseKeyboardPolicy(input)).toEqual(courseKeyboardPolicy(input));
    expect(input).toEqual(before);
  });
});
