import * as RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConstructionCleanupError } from '../../src/game/core/resourceCleanup';
import { RotatingGate } from '../../src/game/obstacles/RotatingGate';
import {
  applyGameplayCollision,
  COLLISION_GROUPS,
} from '../../src/game/physics/collisionGroups';
import { createPhysicsRuntime } from '../../src/game/physics/createPhysicsRuntime';
import { moveFish } from '../../src/game/physics/moveFish';
import { courseFixture } from '../fixtures/courseDefinition';

const definition = courseFixture().objects[3];
const runtimes: Awaited<ReturnType<typeof createPhysicsRuntime>>[] = [];

async function setup() {
  const runtime = await createPhysicsRuntime();
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

describe('live rotating solid gates', () => {
  it('creates a kinematic solid with authored dimensions, position and phase', async () => {
    const runtime = await setup();
    const gate = new RotatingGate(runtime, {
      ...definition,
      phase: Math.PI / 2,
    });
    expect(gate.body.isKinematic()).toBe(true);
    expect(gate.collider.isSensor()).toBe(false);
    expect(gate.collider.collisionGroups()).toBe(
      COLLISION_GROUPS.dynamicObstacle,
    );
    expect(gate.collider.solverGroups()).toBe(COLLISION_GROUPS.dynamicObstacle);
    expect(gate.collider.halfExtents()?.x).toBe(3);
    expect(gate.collider.halfExtents()?.y).toBeCloseTo(0.2, 6);
    expect(gate.collider.halfExtents()?.z).toBeCloseTo(0.2, 6);
    expect(gate.collider.translation()).toMatchObject({ x: 0, y: -3, z: 14 });
    expect(gate.collider.rotation().z).toBeCloseTo(Math.SQRT1_2, 6);
    expect(gate.collider.rotation().w).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('publishes updated poses before any world step and survives the next step', async () => {
    const runtime = await setup();
    const gate = new RotatingGate(runtime, definition);
    gate.update(1);
    expect(gate.body.rotation().z).toBeCloseTo(Math.SQRT1_2, 6);
    expect(gate.collider.rotation().z).toBeCloseTo(Math.SQRT1_2, 6);
    runtime.world.step(runtime.eventQueue);
    expect(gate.collider.rotation().z).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('feeds the live gate geometry to fish casts without snapshots', async () => {
    const runtime = await setup();
    const gate = new RotatingGate(runtime, {
      ...definition,
      position: [0, 0, 0],
    });
    const player = runtime.world.createCollider(
      applyGameplayCollision(
        RAPIER.ColliderDesc.ball(0.1).setTranslation(-2, 2, 0),
        'player',
      ),
    );
    gate.update(1);
    const result = moveFish(runtime, player, [4, 0, 0], [4, 0, 0], 1);
    expect(result.contacts[0]?.colliderHandle).toBe(gate.collider.handle);
    expect(result.position[0]).toBeLessThan(-0.29);
    expect(result.velocity[0]).toBeCloseTo(0, 5);
  });

  it.each([0.8, -0.8, 0])(
    'is partition independent for angular speed %s',
    async (angularSpeed) => {
      const runtime = await setup();
      const whole = new RotatingGate(runtime, {
        ...definition,
        phase: -0.3,
        angularSpeed,
      });
      const partitioned = new RotatingGate(runtime, {
        ...definition,
        phase: -0.3,
        angularSpeed,
      });
      whole.update(8);
      for (let i = 0; i < 80; i += 1) partitioned.update(0.1);
      const expected =
        (((-0.3 + angularSpeed * 8) % (2 * Math.PI)) + 2 * Math.PI) %
        (2 * Math.PI);
      expect(whole.angle).toBeCloseTo(expected, 10);
      expect(partitioned.angle).toBeCloseTo(whole.angle, 10);
      for (const component of ['x', 'y', 'z', 'w'] as const) {
        expect(partitioned.collider.rotation()[component]).toBeCloseTo(
          whole.collider.rotation()[component],
          6,
        );
      }
      expect(whole.angle).toBeGreaterThanOrEqual(0);
      expect(whole.angle).toBeLessThan(2 * Math.PI);
    },
  );

  it('normalizes long-running rotations without overflow for finite dt', async () => {
    const gate = new RotatingGate(await setup(), {
      ...definition,
      phase: 0.3,
      angularSpeed: 4 * Math.PI,
    });
    gate.update(Number.MAX_VALUE);
    expect(gate.angle).toBeCloseTo(0.3, 10);
    expect(Number.isFinite(gate.angle)).toBe(true);
    expect(gate.angle).toBeGreaterThanOrEqual(0);
    expect(gate.angle).toBeLessThan(2 * Math.PI);
    const { x, y, z, w } = gate.collider.rotation();
    expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 6);
  });

  it('does not advance for zero dt', async () => {
    const gate = new RotatingGate(await setup(), { ...definition, phase: 0.3 });
    const rotation = gate.collider.rotation();
    const angle = gate.angle;
    gate.update(0);
    expect(gate.angle).toBe(angle);
    expect(gate.collider.rotation()).toEqual(rotation);
  });

  it.each([
    [1, 0, 0],
    [0, 1, 0],
    [Math.SQRT1_2, Math.SQRT1_2, 0],
  ] as const)(
    'rotates about the authored unit axis (%s, %s, %s)',
    async (x, y, z) => {
      const gate = new RotatingGate(await setup(), {
        ...definition,
        axis: [x, y, z],
      });
      gate.update(1);
      expect(gate.collider.rotation().x).toBeCloseTo(x * Math.SQRT1_2, 6);
      expect(gate.collider.rotation().y).toBeCloseTo(y * Math.SQRT1_2, 6);
      expect(gate.collider.rotation().z).toBeCloseTo(z * Math.SQRT1_2, 6);
    },
  );

  it.each([-1, NaN, Infinity, -Infinity])(
    'rejects invalid delta %s without changing its pose',
    async (dt) => {
      const gate = new RotatingGate(await setup(), definition);
      const rotation = gate.collider.rotation();
      expect(() => gate.update(dt)).toThrow(
        'dt must be finite and nonnegative',
      );
      expect(gate.collider.rotation()).toEqual(rotation);
    },
  );

  it.each([
    { halfExtents: [0, 1, 1] },
    { axis: [0, 2, 0] },
    { axis: [0, 0, 0] },
    { phase: Infinity },
    { angularSpeed: NaN },
    { position: [0, Infinity, 0] },
  ])('validates direct construction before allocating %j', async (override) => {
    const runtime = await setup();
    expect(
      () => new RotatingGate(runtime, { ...definition, ...override }),
    ).toThrow();
    expect(runtime.world.bodies.len()).toBe(0);
    expect(runtime.world.colliders.len()).toBe(0);
  });

  it('removes only its own resources and disposes idempotently', async () => {
    const runtime = await setup();
    const sentinel = runtime.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed(),
    );
    const collider = runtime.world.createCollider(
      RAPIER.ColliderDesc.ball(1),
      sentinel,
    );
    const gate = new RotatingGate(runtime, definition);
    expect(runtime.world.bodies.len()).toBe(2);
    gate.dispose();
    gate.dispose();
    expect(runtime.world.bodies.len()).toBe(1);
    expect(runtime.world.colliders.len()).toBe(1);
    expect(sentinel.isValid()).toBe(true);
    expect(collider.isValid()).toBe(true);
    expect(() => gate.update(0)).toThrow('disposed');
    expect(() => gate.angle).toThrow('disposed');
  });

  it('rolls back its body when collider creation fails', async () => {
    const runtime = await setup();
    const failure = new Error('Simulated collider allocation failure');
    vi.spyOn(runtime.world, 'createCollider').mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => new RotatingGate(runtime, definition)).toThrow(failure);
    expect(runtime.world.bodies.len()).toBe(0);
    expect(runtime.world.colliders.len()).toBe(0);
  });

  it.each([false, true])(
    'retains partial gate cleanup ownership after rollback failure (persistent: %s)',
    async (persistent) => {
      const runtime = await setup();
      const sentinel = runtime.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed(),
      );
      const collider = runtime.world.createCollider(
        RAPIER.ColliderDesc.ball(1),
        sentinel,
      );
      const failure = new Error('Collider failed');
      const cleanupFailure = new Error('Body removal failed');
      vi.spyOn(runtime.world, 'createCollider').mockImplementationOnce(() => {
        throw failure;
      });
      const remove = vi
        .spyOn(runtime.world, 'removeRigidBody')
        .mockImplementationOnce(() => {
          throw cleanupFailure;
        });
      let error: unknown;
      try {
        new RotatingGate(runtime, definition);
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        cause: failure,
        errors: [failure, cleanupFailure],
      });
      expect(runtime.world.bodies.len()).toBe(2);
      expect(runtime.world.colliders.len()).toBe(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(ConstructionCleanupError);
      if (!(error instanceof ConstructionCleanupError)) throw error;
      expect(typeof error.retryCleanup).toBe('function');
      expect(typeof error.dispose).toBe('function');

      if (persistent) {
        const retryFailure = new Error('Body removal still unavailable');
        remove.mockImplementation(() => {
          throw retryFailure;
        });
        expect(() => error.retryCleanup()).toThrow(error);
        expect(() => error.dispose()).toThrow(error);
        expect(error.errors).toEqual(
          expect.arrayContaining([failure, cleanupFailure, retryFailure]),
        );
        expect(error.cause).toBe(failure);
        expect(runtime.world.bodies.len()).toBe(2);
        expect(runtime.world.colliders.len()).toBe(1);
        remove.mockRestore();
      }

      error.retryCleanup();
      expect(runtime.world.bodies.len()).toBe(1);
      expect(runtime.world.colliders.len()).toBe(1);
      const removeAfterRecovery = vi.spyOn(runtime.world, 'removeRigidBody');
      removeAfterRecovery.mockClear();
      error.dispose();
      error.retryCleanup();
      expect(removeAfterRecovery).not.toHaveBeenCalled();
      expect(sentinel.isValid()).toBe(true);
      expect(collider.isValid()).toBe(true);
    },
  );

  it('can retry disposal after a removal failure', async () => {
    const runtime = await setup();
    const gate = new RotatingGate(runtime, definition);
    vi.spyOn(runtime.world, 'removeRigidBody').mockImplementationOnce(() => {
      throw new Error('Removal failed');
    });
    expect(() => gate.dispose()).toThrow('Removal failed');
    expect(() => gate.update(0)).toThrow('disposed');
    gate.dispose();
    expect(runtime.world.bodies.len()).toBe(0);
    expect(runtime.world.colliders.len()).toBe(0);
  });
});
