import * as RAPIER from '@dimforge/rapier3d';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputFrame } from '../../src/game/input/InputFrame';
import {
  applyGameplayCollision,
  type GameplayCollisionKind,
} from '../../src/game/physics/collisionGroups';
import { createPhysicsRuntime } from '../../src/game/physics/createPhysicsRuntime';
import {
  MAX_FISH_SLIDE_ITERATIONS,
  moveFish,
} from '../../src/game/physics/moveFish';
import { FishController } from '../../src/game/player/FishController';
import type {
  FishState,
  FishTuning,
  MotionEnvironment,
} from '../../src/game/player/stepFishMotion';

const stillWater: MotionEnvironment = {
  current: [0, 0, 0],
  waterSurfaceY: 0,
};

const controllerTuning: FishTuning = {
  cruiseSpeed: 1,
  maxSpeed: 1,
  acceleration: 120,
  turnRate: 2.8,
  pitchRate: 2.2,
  drag: 0,
  brakeDrag: 0,
  dashImpulse: 0,
  dashCost: 0.2,
  dashRechargePerSecond: 0,
  surfaceY: 0,
  breachGravity: 9.81,
};

const initialFishState: FishState = {
  position: [0, -1, 0],
  velocity: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  roll: 0,
  dashEnergy: 1,
  isSubmerged: true,
};

function inputFrame(overrides: Partial<InputFrame> = {}): InputFrame {
  return {
    steerX: 0,
    steerY: 0,
    throttle: 0,
    dashPressed: false,
    brakeHeld: false,
    pausePressed: false,
    ...overrides,
  };
}

function createCollider(
  runtime: Awaited<ReturnType<typeof createPhysicsRuntime>>,
  kind: GameplayCollisionKind,
  desc: RAPIER.ColliderDesc,
): RAPIER.Collider {
  return runtime.world.createCollider(applyGameplayCollision(desc, kind));
}

describe('Rapier fish movement integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates zero-gravity runtime and disposes the world exactly once', async () => {
    const runtime = await createPhysicsRuntime();

    expect(runtime.world.gravity).toMatchObject({ x: 0, y: 0, z: 0 });

    const freeWorld = vi.spyOn(runtime.world, 'free');
    const freeQueue = vi.spyOn(runtime.eventQueue, 'free');

    runtime.dispose();
    runtime.dispose();

    expect(freeWorld).toHaveBeenCalledTimes(1);
    expect(freeQueue).toHaveBeenCalledTimes(1);
  });

  it('shape-casts movement with a safe impact offset and wall sliding', async () => {
    const runtime = await createPhysicsRuntime();
    const player = createCollider(
      runtime,
      'player',
      RAPIER.ColliderDesc.ball(0.5).setTranslation(0, 0, 0),
    );
    const wall = createCollider(
      runtime,
      'environment',
      RAPIER.ColliderDesc.cuboid(0.1, 2, 4).setTranslation(1, 0, 0),
    );

    const result = moveFish(runtime, player, [1, 0, 1], [1, 0, 1], 1);

    expect(MAX_FISH_SLIDE_ITERATIONS).toBe(3);
    expect(result.position[0]).toBeGreaterThan(0.35);
    expect(result.position[0]).toBeLessThan(0.4);
    expect(result.position[2]).toBeGreaterThan(0.95);
    expect(result.velocity[0]).toBeCloseTo(0, 5);
    expect(result.velocity[2]).toBeGreaterThan(0.95);
    expect(result.contacts).toContainEqual(
      expect.objectContaining({
        colliderHandle: wall.handle,
      }),
    );
    expect(result.contacts[0]?.normal[0] ?? 0).toBeLessThan(-0.9);
  });

  it('connects the pure fish model to collision queries and typed events', async () => {
    const runtime = await createPhysicsRuntime();
    const player = createCollider(
      runtime,
      'player',
      RAPIER.ColliderDesc.ball(0.5).setTranslation(
        ...initialFishState.position,
      ),
    );
    createCollider(
      runtime,
      'checkpoint',
      RAPIER.ColliderDesc.ball(0.6).setTranslation(0, -1, 1),
    );
    createCollider(
      runtime,
      'pearl',
      RAPIER.ColliderDesc.ball(0.6).setTranslation(0.35, -1, 1),
    );
    runtime.world.createCollider(
      applyGameplayCollision(
        RAPIER.ColliderDesc.ball(0.6).setTranslation(-0.35, -1, 1),
        'hazard',
      ).setSensor(true),
    );

    const controller = new FishController({
      runtime,
      collider: player,
      tuning: controllerTuning,
      initialState: initialFishState,
    });

    const firstStep = controller.step(
      inputFrame({ throttle: 1, dashPressed: true, pausePressed: true }),
      stillWater,
      1,
    );

    expect(controller.getState()).toEqual(firstStep.state);
    expect(firstStep.state.position[2]).toBeCloseTo(1, 3);
    expect(firstStep.state.velocity[2]).toBeCloseTo(1, 3);
    expect(firstStep.state.dashEnergy).toBeCloseTo(0.8, 5);
    expect(firstStep.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'dash',
        'pause-requested',
        'checkpoint-entered',
        'pearl-entered',
        'hazard-entered',
      ]),
    );

    const secondStep = controller.step(inputFrame(), stillWater, 0);
    expect(secondStep.events).toEqual([]);
  });
});
