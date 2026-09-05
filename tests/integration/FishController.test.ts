import * as RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, expect, it } from 'vitest';
import { applyGameplayCollision } from '../../src/game/physics/collisionGroups';
import { createPhysicsRuntime } from '../../src/game/physics/createPhysicsRuntime';
import { FishController } from '../../src/game/player/FishController';
import type { FishState, FishTuning } from '../../src/game/player/fishTypes';

const idleInput = {
  steerX: 0,
  steerY: 0,
  throttle: 0,
  dashPressed: false,
  brakeHeld: false,
  pausePressed: false,
};
const stillWater = {
  current: [0, 0, 0] as [number, number, number],
  waterSurfaceY: 0,
};
const tuning: FishTuning = {
  cruiseSpeed: 0,
  maxSpeed: 20,
  acceleration: 0,
  turnRate: 0,
  pitchRate: 0,
  drag: 0,
  brakeDrag: 0,
  dashImpulse: 0,
  dashCost: 0.2,
  dashRechargePerSecond: 0,
  surfaceY: 0,
  breachGravity: 0,
};
const runtimes: Awaited<ReturnType<typeof createPhysicsRuntime>>[] = [];

async function setup(overrides: Partial<FishState> = {}) {
  const runtime = await createPhysicsRuntime();
  runtimes.push(runtime);
  const collider = runtime.world.createCollider(
    applyGameplayCollision(RAPIER.ColliderDesc.ball(0.1), 'player'),
  );
  const controller = new FishController({
    runtime,
    collider,
    tuning,
    initialState: {
      position: [0, -1, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      roll: 0,
      dashEnergy: 1,
      isSubmerged: true,
      ...overrides,
    },
  });
  return { runtime, controller };
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

it.each([Number.MIN_VALUE, 1e-310])(
  'preserves finite velocity without reciprocal overflow at dt=%s',
  async (dt) => {
    const { controller } = await setup({ velocity: [2, 0, 0] });
    const tinyStep = controller.step(idleInput, stillWater, dt);
    expect(tinyStep.state.velocity).toEqual([2, 0, 0]);

    const normalStep = controller.step(idleInput, stillWater, 1 / 60);
    expect(normalStep.state.velocity).toEqual([2, 0, 0]);
    expect(normalStep.state.position[0]).toBeCloseTo(2 / 60, 6);
  },
);

it('detects a trigger moved into the fish before a world step', async () => {
  const { runtime, controller } = await setup();
  const trigger = runtime.world.createCollider(
    applyGameplayCollision(
      RAPIER.ColliderDesc.ball(0.5).setTranslation(8, -1, 0),
      'checkpoint',
    ),
  );
  trigger.setTranslation({ x: 0, y: -1, z: 0 });

  expect(controller.step(idleInput, stillWater, 0).events).toContainEqual({
    type: 'checkpoint-entered',
    colliderHandle: trigger.handle,
  });
});

it.each(['removed', 'disabled', 'filtered'] as const)(
  'does not enter a trigger that was %s after creation',
  async (change) => {
    const { runtime, controller } = await setup();
    const trigger = runtime.world.createCollider(
      applyGameplayCollision(
        RAPIER.ColliderDesc.ball(0.5).setTranslation(0, -1, 0),
        'checkpoint',
      ),
    );
    if (change === 'removed') runtime.world.removeCollider(trigger, false);
    if (change === 'disabled') trigger.setEnabled(false);
    if (change === 'filtered') trigger.setCollisionGroups(0);

    expect(controller.step(idleInput, stillWater, 0).events).toEqual([]);
  },
);

it('detects the live rotation of a trigger', async () => {
  const { runtime, controller } = await setup();
  const trigger = runtime.world.createCollider(
    applyGameplayCollision(
      RAPIER.ColliderDesc.cuboid(0.1, 2, 4).setTranslation(1, -1, 0),
      'checkpoint',
    ),
  );
  trigger.setRotation({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 });

  expect(controller.step(idleInput, stillWater, 0).events).toContainEqual({
    type: 'checkpoint-entered',
    colliderHandle: trigger.handle,
  });
});

it('keeps a blocked breach submerged with current relative velocity', async () => {
  const { runtime, controller } = await setup({ velocity: [0, 2, 0] });
  runtime.world.createCollider(
    applyGameplayCollision(
      RAPIER.ColliderDesc.cuboid(4, 0.05, 4).setTranslation(0, -0.25, 0),
      'environment',
    ),
  );

  const result = controller.step(
    idleInput,
    { current: [1, 0, 0], waterSurfaceY: 0 },
    1,
  );

  expect(result.state.position[1]).toBeLessThan(0);
  expect(result.state.isSubmerged).toBe(true);
  expect(result.events.map((event) => event.type)).not.toContain('breach');
  expect(result.state.velocity[0]).toBeCloseTo(0, 5);
});

it('keeps a blocked splashdown airborne without subtracting water current', async () => {
  const { runtime, controller } = await setup({
    position: [0, 1, 0],
    velocity: [0, -2, 0],
    isSubmerged: false,
  });
  runtime.world.createCollider(
    applyGameplayCollision(
      RAPIER.ColliderDesc.cuboid(4, 0.05, 4).setTranslation(0, 0.25, 0),
      'environment',
    ),
  );

  const result = controller.step(
    idleInput,
    { current: [1, 0, 0], waterSurfaceY: 0 },
    1,
  );

  expect(result.state.position[1]).toBeGreaterThan(0);
  expect(result.state.isSubmerged).toBe(false);
  expect(result.events.map((event) => event.type)).not.toContain('splashdown');
  expect(result.state.velocity[0]).toBeCloseTo(0, 5);
});

it.each([
  { direction: 1, event: 'breach', submerged: false },
  { direction: -1, event: 'splashdown', submerged: true },
] as const)(
  'emits $event when a slide crosses the surface without an unconstrained crossing',
  async ({ direction, event, submerged }) => {
    const { runtime, controller } = await setup({
      position: [0, -direction * 0.4, 0],
      velocity: [2, 0, 0],
      isSubmerged: !submerged,
    });
    runtime.world.createCollider(
      applyGameplayCollision(
        RAPIER.ColliderDesc.cuboid(0.05, 4, 4)
          .setTranslation(1, -direction * 0.4, 0)
          .setRotation({
            x: 0,
            y: 0,
            z: -direction * Math.sin(Math.PI / 8),
            w: Math.cos(Math.PI / 8),
          }),
        'environment',
      ),
    );

    const result = controller.step(idleInput, stillWater, 1);

    expect(result.state.position[1] * direction).toBeGreaterThan(0.1);
    expect(result.state.isSubmerged).toBe(submerged);
    expect(result.events.map((item) => item.type)).toContain(event);
    expect(controller.step(idleInput, stillWater, 0).events).toEqual([]);
  },
);

it.each([
  { direction: 1, event: 'breach', submerged: false },
  { direction: -1, event: 'splashdown', submerged: true },
] as const)(
  'still emits $event when crossing completes before a collision stops vertical velocity',
  async ({ direction, event, submerged }) => {
    const { runtime, controller } = await setup({
      position: [0, -direction * 0.2, 0],
      velocity: [0, direction * 2, 0],
      isSubmerged: !submerged,
    });
    runtime.world.createCollider(
      applyGameplayCollision(
        RAPIER.ColliderDesc.cuboid(4, 0.05, 4).setTranslation(
          0,
          direction * 0.8,
          0,
        ),
        'environment',
      ),
    );

    const result = controller.step(idleInput, stillWater, 1);

    expect(result.state.position[1] * direction).toBeGreaterThan(0.6);
    expect(result.state.velocity[1]).toBeCloseTo(0, 5);
    expect(result.state.isSubmerged).toBe(submerged);
    expect(result.events.map((item) => item.type)).toContain(event);
  },
);

it('preserves the supplied water state when no time advances', async () => {
  const { controller } = await setup({ isSubmerged: false });

  const result = controller.step(idleInput, stillWater, 0);

  expect(result.state.isSubmerged).toBe(false);
  expect(result.events).toEqual([]);
});
