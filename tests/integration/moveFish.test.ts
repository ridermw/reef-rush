import * as RAPIER from '@dimforge/rapier3d-compat';
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

const runtimes: Awaited<ReturnType<typeof createPhysicsRuntime>>[] = [];

async function createRuntime() {
  const runtime = await createPhysicsRuntime();
  runtimes.push(runtime);
  return runtime;
}

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
    for (const runtime of runtimes.splice(0)) {
      runtime.dispose();
    }
    vi.restoreAllMocks();
  });

  it('creates zero-gravity runtime and disposes the world exactly once', async () => {
    const runtime = await createRuntime();

    expect(runtime.world.gravity).toMatchObject({ x: 0, y: 0, z: 0 });

    const freeWorld = vi.spyOn(runtime.world, 'free');
    const freeQueue = vi.spyOn(runtime.eventQueue, 'free');

    runtime.dispose();
    runtime.dispose();

    expect(freeWorld).toHaveBeenCalledTimes(1);
    expect(freeQueue).toHaveBeenCalledTimes(1);
  });

  it('shape-casts movement with a safe impact offset and wall sliding', async () => {
    const runtime = await createRuntime();
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
    const runtime = await createRuntime();
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

  it('does not tunnel through a thin blocker between sweep samples', async () => {
    const runtime = await createRuntime();
    const player = createCollider(
      runtime,
      'player',
      RAPIER.ColliderDesc.ball(0.05),
    );
    const wall = createCollider(
      runtime,
      'environment',
      RAPIER.ColliderDesc.cuboid(0.001, 2, 2).setTranslation(1.5, 0, 0),
    );

    const result = moveFish(runtime, player, [100, 0, 0], [100, 0, 0], 1);

    expect(result.position[0]).toBeGreaterThan(1.4);
    expect(result.position[0]).toBeLessThan(1.449);
    expect(result.velocity[0]).toBeCloseTo(0, 5);
    expect(result.contacts[0]?.colliderHandle).toBe(wall.handle);
  });

  it.each(['initial', 'changed'] as const)(
    'slides along the real plane of a collider with %s rotation',
    async (rotationTiming) => {
      const runtime = await createRuntime();
      const player = createCollider(
        runtime,
        'player',
        RAPIER.ColliderDesc.ball(0.2),
      );
      const rotation = {
        x: 0,
        y: Math.sin(Math.PI / 8),
        z: 0,
        w: Math.cos(Math.PI / 8),
      };
      const desc = RAPIER.ColliderDesc.cuboid(0.1, 2, 4).setTranslation(
        1,
        0,
        0,
      );
      if (rotationTiming === 'initial') desc.setRotation(rotation);
      const wall = createCollider(runtime, 'dynamicObstacle', desc);
      if (rotationTiming === 'changed') wall.setRotation(rotation);

      const result = moveFish(runtime, player, [2, 0, 0], [2, 0, 0], 1);

      expect(result.contacts[0]?.normal[0]).toBeCloseTo(-Math.SQRT1_2, 4);
      expect(result.contacts[0]?.normal[2]).toBeCloseTo(Math.SQRT1_2, 4);
      expect(result.velocity[0]).toBeCloseTo(1, 4);
      expect(result.velocity[2]).toBeCloseTo(1, 4);
      expect(result.position[0]).toBeGreaterThan(1.2);
      expect(result.position[2]).toBeGreaterThan(0.6);
    },
  );

  it('uses the latest obstacle translation before a world step', async () => {
    const runtime = await createRuntime();
    const player = createCollider(
      runtime,
      'player',
      RAPIER.ColliderDesc.ball(0.5),
    );
    const wall = createCollider(
      runtime,
      'dynamicObstacle',
      RAPIER.ColliderDesc.cuboid(0.1, 2, 2).setTranslation(8, 0, 0),
    );
    wall.setTranslation({ x: 1, y: 0, z: 0 });

    const result = moveFish(runtime, player, [2, 0, 0], [2, 0, 0], 1);

    expect(result.position[0]).toBeGreaterThan(0.35);
    expect(result.position[0]).toBeLessThan(0.4);
    expect(result.contacts[0]?.colliderHandle).toBe(wall.handle);
  });

  it.each(['removed', 'disabled', 'sensor', 'filtered'] as const)(
    'does not collide with an obstacle that was %s after creation',
    async (change) => {
      const runtime = await createRuntime();
      const player = createCollider(
        runtime,
        'player',
        RAPIER.ColliderDesc.ball(0.5),
      );
      const wall = createCollider(
        runtime,
        'dynamicObstacle',
        RAPIER.ColliderDesc.cuboid(0.1, 2, 2).setTranslation(1, 0, 0),
      );
      if (change === 'removed') runtime.world.removeCollider(wall, false);
      if (change === 'disabled') wall.setEnabled(false);
      if (change === 'sensor') wall.setSensor(true);
      if (change === 'filtered') wall.setCollisionGroups(0);

      const result = moveFish(runtime, player, [2, 0, 0], [2, 0, 0], 1);

      expect(result.position).toEqual([2, 0, 0]);
      expect(result.contacts).toEqual([]);
    },
  );

  it('uses the latest fish translation instead of its creation position', async () => {
    const runtime = await createRuntime();
    const player = createCollider(
      runtime,
      'player',
      RAPIER.ColliderDesc.ball(0.5),
    );
    player.setTranslation({ x: 5, y: 0, z: 0 });

    const result = moveFish(runtime, player, [2, 0, 0], [2, 0, 0], 1);

    expect(result.position).toEqual([7, 0, 0]);
    expect(player.translation()).toMatchObject({ x: 7, y: 0, z: 0 });
  });

  it('includes changed parent body transforms in obstacle queries', async () => {
    const runtime = await createRuntime();
    const player = createCollider(
      runtime,
      'player',
      RAPIER.ColliderDesc.ball(0.5),
    );
    const body = runtime.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(8, 0, 0),
    );
    const wall = runtime.world.createCollider(
      applyGameplayCollision(
        RAPIER.ColliderDesc.cuboid(0.1, 2, 2),
        'dynamicObstacle',
      ),
      body,
    );
    body.setTranslation({ x: 1, y: 0, z: 0 }, false);

    const result = moveFish(runtime, player, [2, 0, 0], [2, 0, 0], 1);

    expect(result.position[0]).toBeGreaterThan(0.35);
    expect(result.position[0]).toBeLessThan(0.4);
    expect(result.contacts[0]?.colliderHandle).toBe(wall.handle);
  });

  it('preserves the local offset of a fish collider attached to a body', async () => {
    const runtime = await createRuntime();
    const body = runtime.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(5, 0, 0)
        .setRotation({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }),
    );
    const player = runtime.world.createCollider(
      applyGameplayCollision(
        RAPIER.ColliderDesc.ball(0.5).setTranslation(0, 0, 1),
        'player',
      ),
      body,
    );

    const result = moveFish(runtime, player, [1, 0, 0], [1, 0, 0], 1);
    runtime.world.propagateModifiedBodyPositionsToColliders();

    expect(result.position[0]).toBeCloseTo(7, 5);
    expect(body.translation().x).toBeCloseTo(6, 5);
    expect(player.translation().x).toBeCloseTo(7, 5);
    expect(player.translation().z).toBeCloseTo(0, 5);
  });
});
