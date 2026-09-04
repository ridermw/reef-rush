import * as RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConstructionCleanupError } from '../../src/game/core/resourceCleanup';
import {
  createCourseRuntime,
  type CourseRuntime,
} from '../../src/game/course/createCourseRuntime';
import { loadCourseDefinition } from '../../src/game/course/loadCourseDefinition';
import { CurrentVolume } from '../../src/game/obstacles/CurrentVolume';
import { RotatingGate } from '../../src/game/obstacles/RotatingGate';
import { COLLISION_GROUPS } from '../../src/game/physics/collisionGroups';
import { createPhysicsRuntime } from '../../src/game/physics/createPhysicsRuntime';
import { courseFixture } from '../fixtures/courseDefinition';

const definition = courseFixture();
const runtimes: Awaited<ReturnType<typeof createPhysicsRuntime>>[] = [];

async function setup() {
  const physics = await createPhysicsRuntime();
  runtimes.push(physics);
  const sentinelBody = physics.world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(50, 0, 0),
  );
  const sentinelCollider = physics.world.createCollider(
    RAPIER.ColliderDesc.ball(1),
    sentinelBody,
  );
  const standalone = physics.world.createCollider(
    RAPIER.ColliderDesc.ball(2).setTranslation(60, 0, 0),
  );
  return { physics, sentinelBody, sentinelCollider, standalone };
}

function gateOf(course: CourseRuntime) {
  const gate = course.obstacles.find(
    (obstacle) => obstacle instanceof RotatingGate,
  );
  expect(gate).toBeDefined();
  if (!gate) throw new Error('Expected a gate in the course fixture.');
  return gate;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

describe('owned course runtime', () => {
  it('builds declared solids and obstacles without creating Task 7 triggers', async () => {
    const { physics } = await setup();
    const course = createCourseRuntime(physics, definition);
    expect(course.definition).toEqual(definition);
    expect(course.definition).not.toBe(definition);
    expect(course.solids.map((solid) => solid.definition.id)).toEqual([
      'floor',
      'rock',
    ]);
    expect(course.obstacles.map((obstacle) => obstacle.definition.id)).toEqual([
      'flow',
      'gate',
    ]);
    expect(physics.world.bodies.len()).toBe(2);
    expect(physics.world.colliders.len()).toBe(5);
    expect(course.solids[0].collider.parent()).toBeNull();
    expect(course.solids[0].collider.halfExtents()).toEqual({
      x: 10,
      y: 1,
      z: 15,
    });
    expect(course.solids[0].collider.translation()).toEqual({
      x: 0,
      y: -6,
      z: 10,
    });
    expect(course.solids[0].collider.collisionGroups()).toBe(
      COLLISION_GROUPS.environment,
    );
    expect(course.solids[1].collider.radius()).toBe(1);
    expect(course.solids[1].collider.translation()).toEqual({
      x: 5,
      y: -3,
      z: 10,
    });
    expect(course.solids[1].collider.collisionGroups()).toBe(
      COLLISION_GROUPS.hazard,
    );
    for (const solid of course.solids) {
      expect(solid.collider.isSensor()).toBe(false);
      expect(solid.collider.solverGroups()).toBe(
        solid.collider.collisionGroups(),
      );
    }
    expect(Object.isFrozen(course.solids)).toBe(true);
    expect(Object.isFrozen(course.obstacles)).toBe(true);
  });

  it('applies authored unit quaternion rotations to static boxes', async () => {
    const { physics } = await setup();
    const course = createCourseRuntime(physics, {
      ...definition,
      objects: [
        {
          ...definition.objects[0],
          rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        },
      ],
    });
    expect(course.solids).toHaveLength(1);
    expect(course.solids[0].collider.rotation().y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(course.solids[0].collider.rotation().w).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('updates owned gates directly in the live physics world', async () => {
    const { physics } = await setup();
    const course = createCourseRuntime(physics, definition);
    const gate = gateOf(course);
    course.update(1);
    expect(gate.collider.rotation().z).toBeCloseTo(Math.SQRT1_2, 6);
    const rotation = gate.collider.rotation();
    course.update(0);
    expect(gate.collider.rotation()).toEqual(rotation);
  });

  it('sums overlapping currents with inclusive boundaries and zero elsewhere', async () => {
    const { physics } = await setup();
    const course = createCourseRuntime(physics, {
      ...definition,
      objects: [
        definition.objects[2],
        { ...definition.objects[2], id: 'cross-flow', velocity: [1, -1, 3] },
      ],
    });
    expect(course.sampleCurrent([0, -3, 8])).toEqual([1, -1, 5]);
    expect(course.sampleCurrent([2, -1, 11])).toEqual([1, -1, 5]);
    expect(course.sampleCurrent([2.001, -1, 11])).toEqual([0, 0, 0]);
    expect(physics.world.bodies.len()).toBe(1);
    expect(physics.world.colliders.len()).toBe(2);
  });

  it.each([
    [1 + 0.01, -1, 1],
    [1 - 0.01, -1 + 0.01, 1 - 0.01],
    [1 + 0.01, -1 - 0.01, 1 + 0.01],
  ] as const)(
    'sums overlapping currents at fractional boundaries (%s, %s, %s)',
    async (x, y, z) => {
      const { physics } = await setup();
      const current = {
        ...definition.objects[2],
        position: [1, -1, 1],
        halfExtents: [0.01, 0.01, 0.01],
      };
      const course = createCourseRuntime(physics, {
        ...definition,
        objects: [
          current,
          { ...current, id: 'cross-flow', velocity: [1, -1, 3] },
        ],
      });
      expect(course.sampleCurrent([x, y, z])).toEqual([1, -1, 5]);
      expect(course.sampleCurrent([1 + 0.01 + Number.EPSILON, y, z])).toEqual([
        0, 0, 0,
      ]);
      expect(course.sampleCurrent([1 - 0.01 - Number.EPSILON, y, z])).toEqual([
        0, 0, 0,
      ]);
      course.dispose();
      expect(physics.world.bodies.len()).toBe(1);
      expect(physics.world.colliders.len()).toBe(2);
    },
  );

  it('returns independent current samples and isolates the authored course', async () => {
    const { physics } = await setup();
    const velocity = [1, 2, 3];
    const source = {
      ...definition,
      objects: [{ ...definition.objects[2], velocity }],
    };
    const course = createCourseRuntime(physics, source);
    velocity[0] = 90;
    course.sampleCurrent([0, -3, 8])[1] = 80;
    expect(course.sampleCurrent([0, -3, 8])).toEqual([1, 2, 3]);
    expect(course.definition.objects[0]).toMatchObject({ velocity: [1, 2, 3] });
  });

  it.each([-1, NaN, Infinity, -Infinity])(
    'rejects delta %s even for an empty course',
    async (dt) => {
      const { physics } = await setup();
      const course = createCourseRuntime(physics, {
        ...definition,
        objects: [],
      });
      expect(() => course.update(dt)).toThrow(
        'dt must be finite and nonnegative',
      );
    },
  );

  it('validates sample positions even when there are no currents', async () => {
    const { physics } = await setup();
    const course = createCourseRuntime(physics, { ...definition, objects: [] });
    expect(course.sampleCurrent([100_000, 0, 0])).toEqual([0, 0, 0]);
    expect(() => course.sampleCurrent([0, Infinity, 0])).toThrow();
  });

  it.each([
    { version: 2 },
    {
      objects: [
        ...definition.objects,
        { ...definition.objects[3], id: 'bad-gate', halfExtents: [1, 0, 1] },
      ],
    },
    { pearls: [{ ...definition.pearls[0], radius: NaN }] },
    { checkpoints: [{ ...definition.checkpoints[0], direction: [0, 0, 0] }] },
  ])(
    'validates the entire course before any allocation %j',
    async (override) => {
      const { physics } = await setup();
      const createBody = vi.spyOn(physics.world, 'createRigidBody');
      const createCollider = vi.spyOn(physics.world, 'createCollider');
      expect(() =>
        createCourseRuntime(physics, { ...definition, ...override }),
      ).toThrow();
      expect(createBody).not.toHaveBeenCalled();
      expect(createCollider).not.toHaveBeenCalled();
      expect(physics.world.bodies.len()).toBe(1);
      expect(physics.world.colliders.len()).toBe(2);
    },
  );

  it('restores world counts across repeated lifecycles without freeing caller resources', async () => {
    const { physics, sentinelBody, sentinelCollider, standalone } =
      await setup();
    const freeWorld = vi.spyOn(physics.world, 'free');
    const freeQueue = vi.spyOn(physics.eventQueue, 'free');
    const disposePhysics = vi.spyOn(physics, 'dispose');
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const course = createCourseRuntime(physics, definition);
      expect(physics.world.bodies.len()).toBe(2);
      expect(physics.world.colliders.len()).toBe(5);
      course.dispose();
      course.dispose();
      expect(physics.world.bodies.len()).toBe(1);
      expect(physics.world.colliders.len()).toBe(2);
      expect(() => course.update(0)).toThrow('disposed');
      expect(() => course.sampleCurrent([0, -3, 8])).toThrow('disposed');
    }
    expect(sentinelBody.isValid()).toBe(true);
    expect(sentinelCollider.isValid()).toBe(true);
    expect(standalone.isValid()).toBe(true);
    expect(sentinelBody.translation()).toEqual({ x: 50, y: 0, z: 0 });
    expect(freeWorld).not.toHaveBeenCalled();
    expect(freeQueue).not.toHaveBeenCalled();
    expect(disposePhysics).not.toHaveBeenCalled();
    expect(() => physics.world.step(physics.eventQueue)).not.toThrow();
  });

  it('does not dispose another course in the same world', async () => {
    const { physics } = await setup();
    const first = createCourseRuntime(physics, definition);
    const second = createCourseRuntime(physics, definition);
    expect(physics.world.colliders.len()).toBe(8);
    first.dispose();
    expect(physics.world.colliders.len()).toBe(5);
    second.update(1);
    expect(gateOf(second).collider.rotation().z).toBeCloseTo(Math.SQRT1_2, 6);
    expect(second.sampleCurrent([0, -3, 8])).toEqual([0, 0, 2]);
    second.dispose();
    expect(physics.world.colliders.len()).toBe(2);
  });

  it.each([1, 2, 3, 4])(
    'rolls back all allocations when collider creation %s fails, including partial gates',
    async (failAt) => {
      const { physics, sentinelBody, sentinelCollider, standalone } =
        await setup();
      const createCollider = physics.world.createCollider.bind(physics.world);
      const failure = new Error('Simulated allocation failure');
      let calls = 0;
      vi.spyOn(physics.world, 'createCollider').mockImplementation(
        (...args) => {
          calls += 1;
          if (calls === failAt) throw failure;
          return createCollider(...args);
        },
      );
      const source = {
        ...definition,
        objects: [
          ...definition.objects,
          { ...definition.objects[3], id: 'second-gate' },
        ],
      };
      expect(() => createCourseRuntime(physics, source)).toThrow(failure);
      expect(calls).toBe(failAt);
      expect(physics.world.bodies.len()).toBe(1);
      expect(physics.world.colliders.len()).toBe(2);
      expect(sentinelBody.isValid()).toBe(true);
      expect(sentinelCollider.isValid()).toBe(true);
      expect(standalone.isValid()).toBe(true);
    },
  );

  it('rolls back prior objects when a later body allocation fails', async () => {
    const { physics } = await setup();
    const createBody = physics.world.createRigidBody.bind(physics.world);
    const failure = new Error('Simulated body allocation failure');
    let calls = 0;
    vi.spyOn(physics.world, 'createRigidBody').mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) throw failure;
      return createBody(...args);
    });
    expect(() =>
      createCourseRuntime(physics, {
        ...definition,
        objects: [
          ...definition.objects,
          { ...definition.objects[3], id: 'second-gate' },
        ],
      }),
    ).toThrow(failure);
    expect(physics.world.bodies.len()).toBe(1);
    expect(physics.world.colliders.len()).toBe(2);
  });

  it('continues cleanup after removal failures and retries only unreleased resources', async () => {
    const { physics, sentinelBody, sentinelCollider, standalone } =
      await setup();
    const course = createCourseRuntime(physics, definition);
    const gateFailure = new Error('Gate removal failed');
    const solidFailure = new Error('Solid removal failed');
    vi.spyOn(physics.world, 'removeRigidBody').mockImplementationOnce(() => {
      throw gateFailure;
    });
    vi.spyOn(physics.world, 'removeCollider').mockImplementationOnce(() => {
      throw solidFailure;
    });
    let error: unknown;
    try {
      course.dispose();
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ errors: [gateFailure, solidFailure] });
    expect(physics.world.bodies.len()).toBe(2);
    expect(physics.world.colliders.len()).toBe(4);
    expect(() => course.update(0)).toThrow('disposed');
    expect(() => course.sampleCurrent([0, -3, 8])).toThrow('disposed');
    const current = course.obstacles.find(
      (obstacle) => obstacle instanceof CurrentVolume,
    );
    expect(current).toBeDefined();
    expect(() => current?.update(0)).toThrow('disposed');
    course.dispose();
    course.dispose();
    expect(physics.world.bodies.len()).toBe(1);
    expect(physics.world.colliders.len()).toBe(2);
    expect(sentinelBody.isValid()).toBe(true);
    expect(sentinelCollider.isValid()).toBe(true);
    expect(standalone.isValid()).toBe(true);
  });

  it.each([false, true])(
    'retains failed course rollback releases while cleaning other owners (persistent: %s)',
    async (persistent) => {
      const { physics, sentinelBody, sentinelCollider, standalone } =
        await setup();
      const createCollider = physics.world.createCollider.bind(physics.world);
      const failure = new Error('Allocation failed');
      const cleanupFailure = new Error('Removal failed');
      let calls = 0;
      vi.spyOn(physics.world, 'createCollider').mockImplementation(
        (...args) => {
          calls += 1;
          if (calls === 4) throw failure;
          return createCollider(...args);
        },
      );
      const remove = vi
        .spyOn(physics.world, 'removeCollider')
        .mockImplementationOnce(() => {
          throw cleanupFailure;
        });
      let error: unknown;
      try {
        createCourseRuntime(physics, {
          ...definition,
          objects: [
            ...definition.objects,
            { ...definition.objects[3], id: 'second-gate' },
          ],
        });
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        cause: failure,
        errors: [failure, cleanupFailure],
      });
      expect(physics.world.bodies.len()).toBe(1);
      expect(physics.world.colliders.len()).toBe(3);
      expect(remove).toHaveBeenCalledTimes(2);
      expect(error).toBeInstanceOf(ConstructionCleanupError);
      if (!(error instanceof ConstructionCleanupError)) throw error;
      expect(typeof error.retryCleanup).toBe('function');
      expect(typeof error.dispose).toBe('function');

      if (persistent) {
        const retryFailure = new Error('Collider removal still unavailable');
        remove.mockImplementation(() => {
          throw retryFailure;
        });
        expect(() => error.retryCleanup()).toThrow(error);
        expect(() => error.dispose()).toThrow(error);
        expect(error.errors).toEqual(
          expect.arrayContaining([failure, cleanupFailure, retryFailure]),
        );
        expect(error.cause).toBe(failure);
        expect(physics.world.colliders.len()).toBe(3);
        remove.mockRestore();
      }

      error.dispose();
      expect(physics.world.bodies.len()).toBe(1);
      expect(physics.world.colliders.len()).toBe(2);
      const removeAfterRecovery = vi.spyOn(physics.world, 'removeCollider');
      const removeBodyAfterRecovery = vi.spyOn(
        physics.world,
        'removeRigidBody',
      );
      removeAfterRecovery.mockClear();
      removeBodyAfterRecovery.mockClear();
      error.retryCleanup();
      error.dispose();
      expect(removeAfterRecovery).not.toHaveBeenCalled();
      expect(removeBodyAfterRecovery).not.toHaveBeenCalled();
      expect(sentinelBody.isValid()).toBe(true);
      expect(sentinelCollider.isValid()).toBe(true);
      expect(standalone.isValid()).toBe(true);
    },
  );

  it.each([
    { outerFailure: false, persistent: false },
    { outerFailure: true, persistent: false },
    { outerFailure: false, persistent: true },
    { outerFailure: true, persistent: true },
  ])(
    'preserves partial child ownership through outer course rollback %j',
    async ({ outerFailure, persistent }) => {
      const { physics, sentinelBody, sentinelCollider, standalone } =
        await setup();
      const failure = new Error('Second gate collider failed');
      const childFailure = new Error('Partial gate removal failed');
      const outerGateFailure = new Error('Completed gate removal failed');
      const outerSolidFailure = new Error('Course solid removal failed');
      const createCollider = physics.world.createCollider.bind(physics.world);
      let calls = 0;
      vi.spyOn(physics.world, 'createCollider').mockImplementation(
        (...args) => {
          calls += 1;
          if (calls === 4) throw failure;
          return createCollider(...args);
        },
      );
      const removeBody = vi
        .spyOn(physics.world, 'removeRigidBody')
        .mockImplementationOnce(() => {
          throw childFailure;
        });
      const removeCollider = vi.spyOn(physics.world, 'removeCollider');
      if (outerFailure) {
        removeBody.mockImplementationOnce(() => {
          throw outerGateFailure;
        });
        removeCollider.mockImplementationOnce(() => {
          throw outerSolidFailure;
        });
      }
      const disposeCurrent = vi.spyOn(CurrentVolume.prototype, 'dispose');
      let error: unknown;
      try {
        createCourseRuntime(physics, {
          ...definition,
          objects: [
            ...definition.objects,
            { ...definition.objects[3], id: 'second-gate' },
          ],
        });
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(AggregateError);
      expect(removeBody).toHaveBeenCalledTimes(2);
      expect(removeCollider).toHaveBeenCalledTimes(2);
      expect(disposeCurrent).toHaveBeenCalledTimes(1);
      expect(physics.world.bodies.len()).toBe(outerFailure ? 3 : 2);
      expect(physics.world.colliders.len()).toBe(outerFailure ? 4 : 2);
      expect(error).toBeInstanceOf(ConstructionCleanupError);
      if (!(error instanceof ConstructionCleanupError)) throw error;
      expect(typeof error.retryCleanup).toBe('function');
      expect(typeof error.dispose).toBe('function');
      const child = outerFailure ? error.cause : error;
      expect(child).toMatchObject({
        cause: failure,
        errors: [failure, childFailure],
      });
      expect(child).toBeInstanceOf(ConstructionCleanupError);
      if (!(child instanceof ConstructionCleanupError)) throw child;
      if (outerFailure) {
        expect(error.errors).toEqual([
          child,
          outerGateFailure,
          outerSolidFailure,
        ]);
      }

      if (persistent) {
        removeBody.mockImplementation(() => {
          throw childFailure;
        });
        removeCollider.mockImplementation(() => {
          throw outerSolidFailure;
        });
        expect(() => error.retryCleanup()).toThrow(error);
        expect(() => error.dispose()).toThrow(error);
        expect(physics.world.bodies.len()).toBe(outerFailure ? 3 : 2);
        expect(physics.world.colliders.len()).toBe(outerFailure ? 4 : 2);
        expect(disposeCurrent).toHaveBeenCalledTimes(1);
        removeBody.mockRestore();
        removeCollider.mockRestore();
      }

      error.retryCleanup();
      expect(physics.world.bodies.len()).toBe(1);
      expect(physics.world.colliders.len()).toBe(2);
      const removeAfterRecovery = vi.spyOn(physics.world, 'removeCollider');
      const removeBodyAfterRecovery = vi.spyOn(
        physics.world,
        'removeRigidBody',
      );
      removeAfterRecovery.mockClear();
      removeBodyAfterRecovery.mockClear();
      error.dispose();
      error.retryCleanup();
      child.retryCleanup();
      expect(removeAfterRecovery).not.toHaveBeenCalled();
      expect(removeBodyAfterRecovery).not.toHaveBeenCalled();
      expect(disposeCurrent).toHaveBeenCalledTimes(1);
      expect(sentinelBody.isValid()).toBe(true);
      expect(sentinelCollider.isValid()).toBe(true);
      expect(standalone.isValid()).toBe(true);
    },
  );

  it('loads, builds and disposes generated Sunlit without leaking resources', async () => {
    const { physics } = await setup();
    const data = await loadCourseDefinition('sunlit-shoals');
    const course = createCourseRuntime(physics, data);
    expect(course.solids).toHaveLength(5);
    expect(course.obstacles).toHaveLength(2);
    expect(physics.world.colliders.len()).toBe(8);
    course.update(1 / 60);
    course.dispose();
    expect(physics.world.bodies.len()).toBe(1);
    expect(physics.world.colliders.len()).toBe(2);
  });
});
