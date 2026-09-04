import { expect, it } from 'vitest';
import type { InputFrame } from '../../src/game/input/InputFrame';
import {
  type FishState,
  type FishTuning,
  type MotionEnvironment,
  stepFishMotion,
} from '../../src/game/player/stepFishMotion';

const defaultTuning: FishTuning = {
  cruiseSpeed: 7,
  maxSpeed: 16,
  acceleration: 12,
  turnRate: 2.8,
  pitchRate: 2.2,
  drag: 1.6,
  brakeDrag: 5,
  dashImpulse: 8,
  dashCost: 0.35,
  dashRechargePerSecond: 0.2,
  surfaceY: 0,
  breachGravity: 9.81,
};

const stillWater: MotionEnvironment = {
  current: [0, 0, 0],
  waterSurfaceY: 0,
};

const fishState = (overrides: Partial<FishState> = {}): FishState => ({
  position: [0, -2, 0],
  velocity: [0, 0, 7],
  yaw: 0,
  pitch: 0,
  roll: 0,
  dashEnergy: 1,
  isSubmerged: true,
  ...overrides,
});

const inputFrame = (overrides: Partial<InputFrame> = {}): InputFrame => ({
  steerX: 0,
  steerY: 0,
  throttle: 0,
  dashPressed: false,
  brakeHeld: false,
  pausePressed: false,
  ...overrides,
});

const speed = ([x, y, z]: [number, number, number]): number =>
  Math.hypot(x, y, z);

it('spends dash energy once and increases forward speed', () => {
  const result = stepFishMotion(
    fishState({ dashEnergy: 1 }),
    inputFrame({ dashPressed: true, throttle: 1 }),
    defaultTuning,
    stillWater,
    1 / 60,
  );

  expect(result.next.dashEnergy).toBeCloseTo(0.65, 5);
  expect(speed(result.next.velocity)).toBeGreaterThan(
    defaultTuning.cruiseSpeed,
  );
  expect(result.events).toContain('dash');
});

it('banks into a high-speed turn and returns toward level', () => {
  const turning = stepFishMotion(
    fishState({ velocity: [0, 0, 10] }),
    inputFrame({ steerX: 1, throttle: 1 }),
    defaultTuning,
    stillWater,
    1 / 60,
  );

  expect(turning.next.roll).toBeLessThan(0);

  const leveling = stepFishMotion(
    turning.next,
    inputFrame({ throttle: 1 }),
    defaultTuning,
    stillWater,
    1 / 60,
  );

  expect(Math.abs(leveling.next.roll)).toBeLessThan(
    Math.abs(turning.next.roll),
  );
});

it('leaves state unchanged for zero dt', () => {
  const state = fishState({
    position: [3, -1, 4],
    velocity: [1, 2, 3],
    yaw: 0.5,
    pitch: -0.25,
    roll: 0.125,
    dashEnergy: 0.75,
    isSubmerged: false,
  });

  const result = stepFishMotion(
    state,
    inputFrame({ steerX: 1, steerY: 1, throttle: 1, dashPressed: true }),
    defaultTuning,
    stillWater,
    0,
  );

  expect(result.next).toEqual(state);
  expect(result.desiredDelta).toEqual([0, 0, 0]);
  expect(result.events).toEqual([]);
});

it('clamps pitch within the configured limit', () => {
  const result = stepFishMotion(
    fishState({ pitch: 0 }),
    inputFrame({ steerY: 1 }),
    defaultTuning,
    stillWater,
    10,
  );

  expect(result.next.pitch).toBeLessThanOrEqual(Math.PI / 3);
});

it('caps speed at the tuning maximum', () => {
  const result = stepFishMotion(
    fishState({ velocity: [0, 0, 20] }),
    inputFrame({ throttle: 1 }),
    defaultTuning,
    stillWater,
    1 / 60,
  );

  expect(speed(result.next.velocity)).toBeLessThanOrEqual(
    defaultTuning.maxSpeed,
  );
});

it('rejects dash attempts below the energy cost', () => {
  const result = stepFishMotion(
    fishState({ dashEnergy: 0.2 }),
    inputFrame({ dashPressed: true, throttle: 1 }),
    defaultTuning,
    stillWater,
    1 / 60,
  );

  expect(result.next.dashEnergy).toBeGreaterThanOrEqual(0.2);
  expect(result.next.dashEnergy).toBeLessThan(defaultTuning.dashCost);
  expect(result.events).not.toContain('dash');
});

it('recharges dash energy when not dashing', () => {
  const result = stepFishMotion(
    fishState({ dashEnergy: 0.1 }),
    inputFrame(),
    defaultTuning,
    stillWater,
    1,
  );

  expect(result.next.dashEnergy).toBeCloseTo(0.3, 5);
});

it('adds current to the world-space delta', () => {
  const result = stepFishMotion(
    fishState({ velocity: [0, 0, 0] }),
    inputFrame({ brakeHeld: true }),
    defaultTuning,
    { current: [2, 0, 0], waterSurfaceY: 0 },
    1,
  );

  expect(result.desiredDelta[0]).toBeCloseTo(2, 5);
  expect(result.next.position[0]).toBeCloseTo(2, 5);
});

it('applies stronger brake drag while the brake is held', () => {
  const coasting = stepFishMotion(
    fishState({ velocity: [0, 0, 12] }),
    inputFrame({ throttle: 0 }),
    defaultTuning,
    stillWater,
    1 / 60,
  );
  const braking = stepFishMotion(
    fishState({ velocity: [0, 0, 12] }),
    inputFrame({ brakeHeld: true, throttle: 0 }),
    defaultTuning,
    stillWater,
    1 / 60,
  );

  expect(speed(braking.next.velocity)).toBeLessThan(
    speed(coasting.next.velocity),
  );
});

it('suppresses waterline jitter near the surface', () => {
  const result = stepFishMotion(
    fishState({
      position: [0, -0.0000004, 0],
      velocity: [0, 0.0000006, 0],
    }),
    inputFrame(),
    defaultTuning,
    stillWater,
    1,
  );

  expect(result.events).toEqual([]);
});

it('emits splashdown when an airborne fish re-enters the water', () => {
  const result = stepFishMotion(
    fishState({
      position: [0, 1, 0],
      velocity: [0, -2, 0],
      isSubmerged: false,
    }),
    inputFrame(),
    defaultTuning,
    stillWater,
    1,
  );

  expect(result.events).toContain('splashdown');
  expect(result.next.isSubmerged).toBe(true);
});

it('emits breach once when crossing upward and stays quiet while airborne', () => {
  const breaching = stepFishMotion(
    fishState({
      position: [0, -0.001, 0],
      velocity: [0, 0.5, 0],
    }),
    inputFrame(),
    defaultTuning,
    stillWater,
    0.01,
  );

  expect(breaching.events).toContain('breach');
  expect(breaching.next.isSubmerged).toBe(false);

  const airborne = stepFishMotion(
    breaching.next,
    inputFrame(),
    defaultTuning,
    stillWater,
    0.01,
  );

  expect(airborne.events).not.toContain('breach');
  expect(airborne.next.isSubmerged).toBe(false);
});

it('carries breach gravity into consecutive airborne velocities', () => {
  const first = stepFishMotion(
    fishState({
      position: [0, 2, 0],
      velocity: [0, 0, 0],
      isSubmerged: false,
    }),
    inputFrame(),
    defaultTuning,
    stillWater,
    0.1,
  );
  const second = stepFishMotion(
    first.next,
    inputFrame(),
    defaultTuning,
    stillWater,
    0.1,
  );

  expect(first.next.velocity[1]).toBeLessThan(0);
  expect(second.next.velocity[1]).toBeLessThan(first.next.velocity[1]);
  expect(second.desiredDelta[1]).toBeCloseTo(second.next.velocity[1] * 0.1, 5);
});

it('returns deterministic output for equal inputs', () => {
  const state = fishState({
    position: [1, -3, 2],
    velocity: [0.5, -0.25, 8],
    yaw: 0.75,
    pitch: -0.2,
    roll: 0.15,
    dashEnergy: 0.9,
  });
  const frame = inputFrame({ steerX: -0.5, steerY: 0.25, throttle: 1 });
  const environment: MotionEnvironment = {
    current: [0.1, 0, -0.05],
    waterSurfaceY: 0,
  };

  expect(
    stepFishMotion(state, frame, defaultTuning, environment, 1 / 60),
  ).toEqual(stepFishMotion(state, frame, defaultTuning, environment, 1 / 60));
});
