import * as RAPIER from '@dimforge/rapier3d-compat';
import { BufferGeometry, Material, Mesh, Quaternion, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sunlit from '../../src/content/courses/sunlitShoals';
import {
  createSceneRuntime,
  MAX_SCENE_STEP_SECONDS,
  type SceneRuntime,
  type SceneRuntimeDependencies,
} from '../../src/game/core/SceneRuntime';
import { ConstructionCleanupError } from '../../src/game/core/resourceCleanup';
import { loadCourseDefinition } from '../../src/game/course/loadCourseDefinition';
import type { InputFrame } from '../../src/game/input/InputFrame';
import { RotatingGate } from '../../src/game/obstacles/RotatingGate';
import { createPhysicsRuntime } from '../../src/game/physics/createPhysicsRuntime';
import { FishController } from '../../src/game/player/FishController';
import { createGeneratedSceneVisuals } from '../../src/game/rendering/createGeneratedSceneVisuals';
import { isSceneMesh } from '../fixtures/sceneMeshes';

const input: InputFrame = {
  steerX: 0,
  steerY: 0,
  throttle: 1,
  brakeHeld: false,
  dashPressed: false,
  pausePressed: false,
};
const owned: Array<{ dispose(): void }> = [];

async function setup(
  definition: unknown = sunlit,
  dependencies?: SceneRuntimeDependencies,
) {
  const pending = createSceneRuntime(definition, dependencies);
  await expect(pending).resolves.toBeDefined();
  const runtime = await pending;
  owned.push(runtime);
  return runtime;
}

async function setupObserved(definition: unknown = sunlit) {
  const physics = await createPhysicsRuntime();
  owned.push(physics);
  const getState = vi.spyOn(FishController.prototype, 'getState');
  let gate: RotatingGate | undefined;
  const runtime = await setup(definition, {
    createPhysics: () => Promise.resolve(physics),
    createVisuals(scene, course) {
      gate = course.obstacles.find(
        (obstacle) => obstacle instanceof RotatingGate,
      );
      return createGeneratedSceneVisuals(scene, course);
    },
  });
  // Observe the real controller without adding a mutable handle to the scene API.
  const controller = getState.mock.contexts.at(-1);
  getState.mockRestore();
  if (!(controller instanceof FishController) || !gate)
    throw new Error('Missing controller or gate');
  const observedGate = gate;
  return {
    runtime,
    readState() {
      return {
        snapshot: runtime.getSnapshot(),
        controller: controller.getState(),
        gateAngle: observedGate.angle,
        bodies: physics.world.bodies.getAll().map((body) => ({
          handle: body.handle,
          position: body.translation(),
          rotation: body.rotation(),
          nextPosition: body.nextTranslation(),
          nextRotation: body.nextRotation(),
          velocity: body.linvel(),
          angularVelocity: body.angvel(),
        })),
        colliders: physics.world.colliders.getAll().map((collider) => ({
          handle: collider.handle,
          position: collider.translation(),
          rotation: collider.rotation(),
        })),
      };
    },
  };
}

function expectRejectedStep(
  subject: Awaited<ReturnType<typeof setupObserved>>,
  invalidInput: unknown,
  dt: number,
  error: string,
) {
  const before = subject.readState();
  expect
    .soft(() => {
      // @ts-expect-error Host data can violate the static InputFrame contract.
      subject.runtime.step(invalidInput, dt);
    })
    .toThrow(error);
  expect.soft(subject.readState()).toEqual(before);
}

function expectMatchingNextStep(
  subject: Awaited<ReturnType<typeof setupObserved>>,
  control: Awaited<ReturnType<typeof setupObserved>>,
) {
  const expected = control.runtime.step(input, 1 / 60);
  let actual: ReturnType<SceneRuntime['step']> | undefined;
  expect(() => {
    actual = subject.runtime.step(input, 1 / 60);
  }).not.toThrow();
  expect(actual).toEqual(expected);
  expect(subject.readState()).toEqual(control.readState());
}

function mesh(
  runtime: SceneRuntime,
  name: string,
): Mesh<BufferGeometry, Material | Material[]> {
  const object = runtime.scene.getObjectByName(name);
  expect(object).toBeInstanceOf(Mesh);
  if (!isSceneMesh(object)) throw new Error(`Expected mesh ${name}`);
  return object;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const resource of owned.splice(0).reverse()) resource.dispose();
});

describe('headless owned scene runtime', () => {
  it.each([Number.MIN_VALUE, 1e-310])(
    'keeps motion and presentation finite after an accepted tiny step of %s',
    async (dt) => {
      const subject = await setup();
      const control = await setup();
      subject.start();
      control.start();
      subject.step(input, dt);
      expect(subject.getSnapshot().fish.velocity.every(Number.isFinite)).toBe(
        true,
      );
      subject.present(1, dt);
      expect(Number.isFinite(subject.camera.fov)).toBe(true);
      expect(subject.camera.matrixWorld.elements.every(Number.isFinite)).toBe(
        true,
      );
      expect(
        subject.camera.projectionMatrix.elements.every(Number.isFinite),
      ).toBe(true);

      for (let step = 0; step < 60; step++) {
        subject.step(input, 1 / 60);
        control.step(input, 1 / 60);
      }
      expect(subject.getSnapshot().fish).toEqual(control.getSnapshot().fish);
      expect(subject.getSnapshot().fish.position[2]).toBeGreaterThan(9);
      subject.present(1, 1 / 60);
      expect(Number.isFinite(subject.camera.fov)).toBe(true);
      expect(
        subject.camera.projectionMatrix.elements.every(Number.isFinite),
      ).toBe(true);
    },
  );

  it('loads real Sunlit into a ready, isolated, immutable scene snapshot', async () => {
    const definition = await loadCourseDefinition('sunlit-shoals');
    const runtime = await setup(definition);
    expect(runtime.definition).toEqual(definition);
    expect(runtime.definition).not.toBe(definition);
    const snapshot = runtime.getSnapshot();
    expect(snapshot.fish).toEqual({
      position: [0, -4, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      roll: 0,
      dashEnergy: 1,
      isSubmerged: true,
    });
    expect(snapshot.race).toMatchObject({
      status: 'ready',
      elapsedMs: 0,
      checkpointIndex: 0,
      checkpointCount: 4,
      pearlCount: 0,
      totalPearls: 4,
      result: null,
    });
    for (const value of [
      snapshot,
      snapshot.fish,
      snapshot.fish.position,
      snapshot.fish.velocity,
      snapshot.race,
      snapshot.collectedPearlIds,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(runtime.getSnapshot().fish.position).not.toBe(
      snapshot.fish.position,
    );
    expect(runtime.getDiagnostics()).toMatchObject({
      bodies: 1,
      colliders: 7,
      lifecycle: 'active',
    });
    expect(runtime.scene.background).toMatchObject({ isColor: true });
    expect(runtime.scene.fog).not.toBeNull();
    expect(runtime.scene.getObjectByName('player-fish')).toBeDefined();
  });

  it('initializes authored yaw and keeps ready/paused steps and guarded transitions inert', async () => {
    const runtime = await setup({
      ...sunlit,
      spawn: { position: [2, -3, 1], yaw: 1 },
    });
    const initial = runtime.getSnapshot();
    expect(initial.fish.yaw).toBe(1);
    expect(() => runtime.step(input, 1 / 60)).toThrow('start');
    expect(() => runtime.pause()).toThrow();
    expect(() => runtime.resume()).toThrow();
    expect(runtime.getSnapshot()).toEqual(initial);
    runtime.start();
    expect(() => runtime.start()).toThrow();
    runtime.pause();
    const paused = runtime.getSnapshot();
    const rotation = mesh(runtime, 'sway-beam').quaternion.clone();
    for (let i = 0; i < 60; i++)
      expect(runtime.step(input, 1 / 60).snapshot).toEqual(paused);
    runtime.present(1, 1);
    expect(mesh(runtime, 'sway-beam').quaternion.toArray()).toEqual(
      rotation.toArray(),
    );
    runtime.resume();
    expect(runtime.step(input, 1 / 60).snapshot.fish.position).not.toEqual(
      initial.fish.position,
    );
  });

  it.each([-1, NaN, Infinity, -Infinity])(
    'rejects dt %s before pause, gate, fish or race mutations',
    async (dt) => {
      const runtime = await setup();
      runtime.start();
      const before = runtime.getSnapshot();
      const rotation = mesh(runtime, 'sway-beam').quaternion.clone();
      expect(() => runtime.step({ ...input, pausePressed: true }, dt)).toThrow(
        'dt',
      );
      expect(runtime.getSnapshot()).toEqual(before);
      runtime.present(1, 0);
      expect(mesh(runtime, 'sway-beam').quaternion.toArray()).toEqual(
        rotation.toArray(),
      );
    },
  );

  it.each(
    (['steerX', 'steerY', 'throttle'] as const).flatMap((axis) =>
      [NaN, Infinity, -Infinity, -1.000001, 1.000001, '0', null, undefined].map(
        (value) => ({ field: axis, value }),
      ),
    ),
  )(
    'rejects invalid $field=$value without corrupting live state',
    async ({ field, value }) => {
      const subject = await setupObserved();
      const control = await setupObserved();
      for (const { runtime } of [subject, control]) {
        runtime.start();
        runtime.step({ ...input, steerX: 0.25, dashPressed: true }, 1 / 60);
      }
      expectRejectedStep(subject, { ...input, [field]: value }, 1 / 60, field);
      expectMatchingNextStep(subject, control);
    },
  );

  it.each(
    (['dashPressed', 'brakeHeld', 'pausePressed'] as const).flatMap((field) =>
      [0, 1, 'false', null, undefined].map((value) => ({ field, value })),
    ),
  )(
    'rejects nonboolean $field=$value without coercion or mutation',
    async ({ field, value }) => {
      const subject = await setupObserved();
      const control = await setupObserved();
      subject.runtime.start();
      control.runtime.start();
      expectRejectedStep(subject, { ...input, [field]: value }, 1 / 60, field);
      expectMatchingNextStep(subject, control);
    },
  );

  it.each(
    [
      -1,
      NaN,
      Infinity,
      -Infinity,
      0.10000000000000002,
      Number.MAX_VALUE,
    ].flatMap((dt) =>
      [false, true].map((pausePressed) => ({ dt, pausePressed })),
    ),
  )(
    'rejects unsafe dt=$dt before mutation (pause=$pausePressed)',
    async ({ dt, pausePressed }) => {
      const subject = await setupObserved();
      const control = await setupObserved();
      for (const { runtime } of [subject, control]) {
        runtime.start();
        runtime.step(input, 1 / 60);
      }
      expectRejectedStep(subject, { ...input, pausePressed }, dt, 'dt');
      expectMatchingNextStep(subject, control);
    },
  );

  it.each(['ready', 'running', 'paused', 'finished'] as const)(
    'validates all call arguments even with zero dt or %s status',
    async (status) => {
      const definition = {
        ...sunlit,
        pearls: [],
        checkpoints: [
          {
            id: 'finish',
            position: [0, -4, 0.001],
            direction: [0, 0, 1],
            radius: 2,
          },
        ],
      };
      const subject = await setupObserved(definition);
      const control = await setupObserved(definition);
      for (const { runtime } of [subject, control]) {
        if (status !== 'ready') runtime.start();
        if (status === 'paused') runtime.pause();
        if (status === 'finished') runtime.step(input, 1 / 60);
        expect(runtime.getSnapshot().race.status).toBe(status);
      }
      for (const dt of [0, 1 / 60]) {
        expectRejectedStep(
          subject,
          { ...input, steerX: NaN, pausePressed: true },
          dt,
          'steerX',
        );
        expectRejectedStep(
          subject,
          { ...input, brakeHeld: 'false' },
          dt,
          'brakeHeld',
        );
        expectRejectedStep(subject, null, dt, 'object');
      }
      expectRejectedStep(
        subject,
        { ...input, pausePressed: true },
        Number.MAX_VALUE,
        'dt',
      );
      if (status === 'ready') {
        subject.runtime.start();
        control.runtime.start();
      }
      if (status === 'paused') {
        subject.runtime.resume();
        control.runtime.resume();
      }
      expectMatchingNextStep(subject, control);
    },
  );

  it.each([-1, 0, 1])(
    'accepts inclusive axis boundary %s and the 0.1 second step maximum',
    async (axis) => {
      const subject = await setupObserved();
      subject.runtime.start();
      const frame = Object.freeze({
        ...input,
        steerX: axis,
        steerY: axis,
        throttle: axis,
      });
      const initial = subject.readState();
      expect(subject.runtime.step(frame, 0).snapshot).toEqual(initial.snapshot);
      expect(subject.readState()).toEqual(initial);
      expect(MAX_SCENE_STEP_SECONDS).toBe(0.1);
      const result = subject.runtime.step(frame, MAX_SCENE_STEP_SECONDS);
      expect(result.snapshot.race.elapsedMs).toBe(100);
      expect(subject.readState().gateAngle).not.toBe(initial.gateAngle);
      expect(
        [
          ...result.snapshot.fish.position,
          ...result.snapshot.fish.velocity,
        ].every(Number.isFinite),
      ).toBe(true);
      expect(frame).toEqual({
        ...input,
        steerX: axis,
        steerY: axis,
        throttle: axis,
      });
    },
  );

  it('handles pause before motion, dash, gates or clock and signals the host once', async () => {
    const runtime = await setup();
    runtime.start();
    const before = runtime.getSnapshot();
    const rotation = mesh(runtime, 'sway-beam').quaternion.clone();
    const result = runtime.step(
      { ...input, pausePressed: true, dashPressed: true },
      1 / 60,
    );
    expect(result.pauseRequested).toBe(true);
    expect(result.fishEvents).toEqual([{ type: 'pause-requested' }]);
    expect(result.raceEvents).toEqual([]);
    expect(result.snapshot.fish).toEqual(before.fish);
    expect(result.snapshot.race).toMatchObject({
      status: 'paused',
      elapsedMs: 0,
    });
    runtime.present(1, 0.5);
    expect(mesh(runtime, 'sway-beam').quaternion.toArray()).toEqual(
      rotation.toArray(),
    );
    for (let i = 0; i < 89; i++)
      expect(
        runtime.step({ ...input, pausePressed: true }, 1 / 60).pauseRequested,
      ).toBe(false);
    runtime.resume();
    const moved = runtime.step({ ...input, dashPressed: true }, 1 / 60);
    expect(moved.fishEvents).toContainEqual({ type: 'dash' });
    expect(moved.snapshot.race.elapsedMs).toBeCloseTo(1000 / 60);
  });

  it('keeps zero dt inert including dash energy and race events', async () => {
    const runtime = await setup();
    runtime.start();
    const initial = runtime.getSnapshot();
    const result = runtime.step({ ...input, dashPressed: true }, 0);
    expect(result.snapshot).toEqual(initial);
    expect(result.fishEvents).toEqual([]);
    expect(result.raceEvents).toEqual([]);
  });

  it.each(['paused', 'finished'] as const)(
    'presents the final fixed pose while %s instead of rewinding on host interpolation alpha',
    async (status) => {
      const runtime = await setup({
        ...sunlit,
        objects: [],
        pearls: [],
        checkpoints: [
          {
            id: 'finish',
            position: [0, -4, 1],
            direction: [0, 0, 1],
            radius: 2,
          },
        ],
      });
      runtime.start();
      for (let i = 0; i < (status === 'finished' ? 18 : 6); i++)
        runtime.step(input, 1 / 60);
      if (status === 'paused') runtime.pause();
      expect(runtime.getSnapshot().race.status).toBe(status);
      runtime.present(0, 0);
      expect(
        runtime.scene.getObjectByName('player-fish')?.position.toArray(),
      ).toEqual(runtime.getSnapshot().fish.position);
    },
  );

  it('keeps the camera outside the decorative fish but retracts in front of environmental meshes', async () => {
    const open = await setup();
    expect(open.camera.position.toArray()).toEqual([0, -2, -7]);
    const obstructed = await setup({
      ...sunlit,
      objects: [
        {
          type: 'box',
          id: 'camera-wall',
          position: [0, -3, -3],
          halfExtents: [3, 3, 0.1],
          rotation: [0, 0, 0, 1],
          collision: 'environment',
          color: '#e4d2a2',
        },
      ],
    });
    expect(obstructed.camera.position.z).toBeGreaterThan(-3);
    expect(obstructed.camera.position.z).toBeLessThan(0);
    const toFish = new Vector3(...obstructed.getSnapshot().fish.position)
      .sub(obstructed.camera.position)
      .normalize();
    expect(
      obstructed.camera.getWorldDirection(new Vector3()).dot(toFish),
    ).toBeGreaterThan(0.999);
  });

  it('samples authored currents at the actual fish position without a world step', async () => {
    const physics = await createPhysicsRuntime();
    owned.push(physics);
    const worldStep = vi.spyOn(physics.world, 'step');
    const runtime = await setup(
      {
        ...sunlit,
        spawn: { position: [3, -4, 27], yaw: 0 },
      },
      { createPhysics: () => Promise.resolve(physics) },
    );
    runtime.start();
    for (let i = 0; i < 5; i++) runtime.step({ ...input, throttle: -1 }, 0.1);
    const snapshot = runtime.getSnapshot();
    expect(snapshot.fish.position[0]).toBeCloseTo(3.15, 5);
    expect(snapshot.fish.position[2]).toBeCloseTo(27.75, 5);
    for (const velocity of snapshot.fish.velocity)
      expect(velocity).toBeCloseTo(0, 12);
    expect(worldStep).not.toHaveBeenCalled();
  });

  it('uses actual collision-constrained displacement for race crossings and forwards contacts', async () => {
    const wall = {
      type: 'box',
      id: 'wall',
      position: [0, -4, 2],
      halfExtents: [4, 4, 0.05],
      rotation: [0, 0, 0, 1],
      collision: 'environment',
      color: '#e4d2a2',
    };
    const runtime = await setup({
      ...sunlit,
      objects: [wall],
      pearls: [],
      checkpoints: [
        { id: 'finish', position: [0, -4, 3], direction: [0, 0, 1], radius: 2 },
      ],
    });
    runtime.start();
    const events = [];
    for (let i = 0; i < 120; i++)
      events.push(...runtime.step(input, 1 / 60).fishEvents);
    expect(runtime.getSnapshot().fish.position[2]).toBeLessThan(1.7);
    expect(runtime.getSnapshot().race).toMatchObject({
      status: 'running',
      checkpointIndex: 0,
    });
    expect(events.some((event) => event.type === 'collision')).toBe(true);
  });

  it('updates live gate rotation before querying fish movement and race crossings', async () => {
    for (const angularSpeed of [0, Math.PI]) {
      const runtime = await setup({
        ...sunlit,
        spawn: { position: [2, -4, 0], yaw: 0 },
        pearls: [],
        checkpoints: [
          {
            id: 'finish',
            position: [2, -4, 3],
            direction: [0, 0, 1],
            radius: 1,
          },
        ],
        objects: [
          {
            type: 'rotating-gate',
            id: 'moving-beam',
            position: [0, -4, 2],
            halfExtents: [3, 0.1, 0.1],
            axis: [0, 0, 1],
            phase: 0,
            angularSpeed,
            color: '#dca660',
          },
        ],
      });
      runtime.start();
      const events = [];
      for (let i = 0; i < 30; i++)
        events.push(...runtime.step(input, 1 / 60).fishEvents);
      const snapshot = runtime.getSnapshot();
      expect(snapshot.race.status === 'finished').toBe(angularSpeed > 0);
      expect(events.some((event) => event.type === 'collision')).toBe(
        angularSpeed === 0,
      );
      if (angularSpeed > 0) {
        expect(snapshot.fish.position[2]).toBeGreaterThan(3);
      } else {
        expect(snapshot.fish.position[2]).toBeLessThan(1.6);
      }
    }
  });

  it('presents live gates, interpolated fish and a camera facing the fish without changing simulation', async () => {
    let gate: RotatingGate | undefined;
    const runtime = await setup(sunlit, {
      createVisuals(scene, course) {
        gate = course.obstacles.find(
          (obstacle) => obstacle instanceof RotatingGate,
        );
        return createGeneratedSceneVisuals(scene, course);
      },
    });
    runtime.start();
    for (let i = 0; i < 11; i++)
      runtime.step({ ...input, steerX: 0.5 }, 1 / 60);
    const from = runtime.getSnapshot().fish.position;
    const next = runtime.step({ ...input, steerX: 0.5 }, 1 / 60).snapshot;
    runtime.present(0.5, 0.2);
    const fish = runtime.scene.getObjectByName('player-fish');
    expect(fish?.position.toArray()).toEqual(
      from.map((value, index) => (value + next.fish.position[index]) / 2),
    );
    const actual = gate?.body.rotation();
    expect(actual).toBeDefined();
    if (!actual) throw new Error('Missing real gate');
    expect(
      mesh(runtime, 'sway-beam').quaternion.angleTo(
        new Quaternion(actual.x, actual.y, actual.z, actual.w),
      ),
    ).toBeLessThan(0.001);
    const toFish = new Vector3(...next.fish.position)
      .sub(runtime.camera.position)
      .normalize();
    expect(
      runtime.camera.getWorldDirection(new Vector3()).dot(toFish),
    ).toBeGreaterThan(0.95);
    expect(runtime.camera.position.z).toBeLessThan(next.fish.position[2]);
    runtime.present(1, 1 / 60);
    expect(runtime.getSnapshot()).toEqual(next);
  });

  it.each([
    [NaN, 0],
    [-0.1, 0],
    [1.1, 0],
    [0, -1],
    [0, Infinity],
  ])(
    'rejects invalid presentation (%s, %s) without changing scene or simulation',
    async (alpha, seconds) => {
      const runtime = await setup();
      const before = runtime.getSnapshot();
      const camera = runtime.camera.matrixWorld.clone();
      expect(() => runtime.present(alpha, seconds)).toThrow();
      expect(runtime.camera.matrixWorld).toEqual(camera);
      expect(runtime.getSnapshot()).toEqual(before);
    },
  );

  it('finishes all four authored checkpoints and pickups using only steer/throttle with real Rapier', async () => {
    const runtime = await setup();
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
          ...input,
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
    }
    expect(
      runtime.getSnapshot().race.status,
      JSON.stringify(runtime.getSnapshot()),
    ).toBe('finished');
    expect(checkpointIds).toEqual(
      sunlit.checkpoints.map((checkpoint) => checkpoint.id),
    );
    expect(pearlIds).toEqual(sunlit.pearls.map((pearl) => pearl.id));
    expect(steeringSteps).toBeGreaterThan(100);
    expect(steps).toBeLessThan(3600);
    expect(steps).toBe(1317);
    expect(runtime.getSnapshot().race.elapsedMs).toBeCloseTo(21940.483, 3);
    expect(runtime.getSnapshot().race.result?.medal).toBe('bronze');
    runtime.present(1, 1 / 60);
    for (const pearl of sunlit.pearls)
      expect(mesh(runtime, pearl.id).visible).toBe(false);
    for (const checkpoint of sunlit.checkpoints) {
      expect(mesh(runtime, checkpoint.id).userData.checkpointState).toBe(
        'completed',
      );
    }
    const finished = runtime.getSnapshot();
    const gate = mesh(runtime, 'sway-beam').quaternion.clone();
    for (let i = 0; i < 300; i++) {
      const terminal = runtime.step(
        { ...input, dashPressed: true, pausePressed: true },
        1 / 60,
      );
      expect(terminal.finished).toBe(true);
      expect(terminal.fishEvents).toEqual([]);
      expect(terminal.raceEvents).toEqual([]);
      expect(terminal.snapshot).toEqual(finished);
    }
    runtime.present(1, 5);
    expect(runtime.getSnapshot()).toEqual(finished);
    expect(mesh(runtime, 'sway-beam').quaternion.toArray()).toEqual(
      gate.toArray(),
    );
    expect(() => runtime.start()).toThrow();
    expect(() => runtime.resume()).toThrow();
    expect(() => runtime.pause()).toThrow();
    console.info(
      `Sunlit traversal: ${steps} fixed steps, ${finished.race.elapsedMs.toFixed(3)}ms, ${checkpointIds.length} checkpoints, ${pearlIds.length} pearls, medal=${finished.race.result?.medal}`,
    );
  });

  it('releases every unique geometry/material once and returns resource counts to zero over repeated cycles', async () => {
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    const unrelated = await createPhysicsRuntime();
    owned.push(unrelated);
    const sentinel = unrelated.world.createCollider(
      RAPIER.ColliderDesc.ball(1),
    );
    for (let i = 0; i < 3; i++) {
      const runtime = await setup();
      const geometries = new Set<BufferGeometry>();
      const materials = new Set<Material>();
      runtime.scene.traverse((object) => {
        if (!isSceneMesh(object)) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material])
          materials.add(material);
      });
      const counts = runtime.getDiagnostics();
      expect(counts.geometries).toBe(geometries.size);
      expect(counts.materials).toBeGreaterThanOrEqual(materials.size);
      const disposedMaterials = materialDispose.mock.calls.length;
      runtime.dispose();
      runtime.dispose();
      expect(runtime.getDiagnostics()).toEqual({
        lifecycle: 'disposed',
        colliders: 0,
        bodies: 0,
        geometries: 0,
        materials: 0,
      });
      expect(runtime.scene.children).toHaveLength(0);
      expect(materialDispose.mock.calls.length - disposedMaterials).toBe(
        counts.materials,
      );
      for (const geometry of geometries)
        expect(
          geometryDispose.mock.contexts.filter(
            (context) => context === geometry,
          ),
        ).toHaveLength(1);
      for (const material of materials)
        expect(
          materialDispose.mock.contexts.filter(
            (context) => context === material,
          ),
        ).toHaveLength(1);
      expect(() => runtime.step(input, 0)).toThrow('disposed');
      expect(() => runtime.present(1, 0)).toThrow('disposed');
      expect(() => runtime.start()).toThrow('disposed');
      expect(() => runtime.pause()).toThrow('disposed');
      expect(() => runtime.resume()).toThrow('disposed');
    }
    expect(sentinel.isValid()).toBe(true);
    expect(unrelated.world.colliders.len()).toBe(1);
  });

  it('validates before allocating a world', async () => {
    const createPhysics = vi.fn(createPhysicsRuntime);
    await expect(
      createSceneRuntime({ ...sunlit, version: 2 }, { createPhysics }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(createPhysics).not.toHaveBeenCalled();
  });

  it('rolls back course/player/world when the visual factory fails and preserves the actual cause', async () => {
    const physics = await createPhysicsRuntime();
    owned.push(physics);
    const counts: number[] = [];
    const free = physics.world.free.bind(physics.world);
    const worldFree = vi.spyOn(physics.world, 'free').mockImplementation(() => {
      counts.push(physics.world.bodies.len(), physics.world.colliders.len());
      free();
    });
    const failure = new Error('Visual creation failed');
    await expect(
      createSceneRuntime(sunlit, {
        createPhysics: () => Promise.resolve(physics),
        createVisuals: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(counts).toEqual([0, 0]);
    expect(worldFree).toHaveBeenCalledTimes(1);
  });

  it('rolls back completed GPU allocations and physics when initial presentation fails', async () => {
    const physics = await createPhysicsRuntime();
    owned.push(physics);
    const worldFree = vi.spyOn(physics.world, 'free');
    const failure = new Error('Initial presentation failed');
    let counts: Readonly<{ geometries: number; materials: number }> | undefined;
    const geometries = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materials = vi.spyOn(Material.prototype, 'dispose');
    await expect(
      createSceneRuntime(sunlit, {
        createPhysics: () => Promise.resolve(physics),
        createVisuals(scene, course) {
          const visuals = createGeneratedSceneVisuals(scene, course);
          counts = visuals.getResourceCounts();
          return {
            ...visuals,
            present() {
              throw failure;
            },
          };
        },
      }),
    ).rejects.toBe(failure);
    expect(counts?.geometries).toBeGreaterThan(0);
    expect(geometries.mock.calls.length).toBe(counts?.geometries);
    expect(materials.mock.calls.length).toBe(counts?.materials);
    expect(worldFree).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'retains failed child construction ownership without retrying it or freeing its world in the first catch (outer failure: %s)',
    async (outerFailure) => {
      const physics = await createPhysicsRuntime();
      owned.push(physics);
      const createCollider = physics.world.createCollider.bind(physics.world);
      const allocationFailure = new Error('Gate collider unavailable');
      const removalFailure = new Error('Gate body unavailable');
      vi.spyOn(physics.world, 'createCollider').mockImplementation(
        (desc, body) => {
          if (body) throw allocationFailure;
          return createCollider(desc, body);
        },
      );
      const removeBody = vi
        .spyOn(physics.world, 'removeRigidBody')
        .mockImplementation(() => {
          throw removalFailure;
        });
      const removeCollider = vi.spyOn(physics.world, 'removeCollider');
      if (outerFailure)
        removeCollider.mockImplementationOnce(() => {
          throw new Error('Solid rollback failed');
        });
      const worldFree = vi.spyOn(physics.world, 'free');
      let failure: unknown;
      try {
        await createSceneRuntime(sunlit, {
          createPhysics: () => Promise.resolve(physics),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConstructionCleanupError);
      if (!(failure instanceof ConstructionCleanupError)) throw failure;
      owned.push(failure);
      expect(removeBody).toHaveBeenCalledTimes(1);
      expect(worldFree).not.toHaveBeenCalled();
      expect(physics.world.bodies.len()).toBe(1);
      expect(physics.world.colliders.len()).toBe(outerFailure ? 1 : 0);
      expect(() => failure.retryCleanup()).toThrow(failure);
      expect(worldFree).not.toHaveBeenCalled();
      removeBody.mockRestore();
      failure.retryCleanup();
      failure.dispose();
      expect(worldFree).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['course', 'player'] as const)(
    'attempts independent visual releases but retains %s and world until failed disposal is retried',
    async (owner) => {
      const physics = await createPhysicsRuntime();
      owned.push(physics);
      const runtime = await setup(sunlit, {
        createPhysics: () => Promise.resolve(physics),
      });
      const worldFree = vi.spyOn(physics.world, 'free');
      const failure = new Error('Body removal failed');
      const remove = vi
        .spyOn(
          physics.world,
          owner === 'course' ? 'removeRigidBody' : 'removeCollider',
        )
        .mockImplementationOnce(() => {
          throw failure;
        });
      expect(() => runtime.dispose()).toThrow(AggregateError);
      expect(runtime.getDiagnostics()).toEqual({
        lifecycle: 'disposing',
        bodies: owner === 'course' ? 1 : 0,
        colliders: 1,
        geometries: 0,
        materials: 0,
      });
      expect(worldFree).not.toHaveBeenCalled();
      expect(() => runtime.step(input, 0)).toThrow('disposed');
      runtime.dispose();
      runtime.dispose();
      expect(remove).toHaveBeenCalledTimes(owner === 'course' ? 2 : 7);
      expect(worldFree).toHaveBeenCalledTimes(1);
      expect(runtime.getDiagnostics().lifecycle).toBe('disposed');
    },
  );

  it.each(['world', 'eventQueue'] as const)(
    'retries failed visual and %s releases on a retained runtime without repeating successful GPU releases',
    async (resource) => {
      const physics = await createPhysicsRuntime();
      owned.push(physics);
      const runtime = await setup(sunlit, {
        createPhysics: () => Promise.resolve(physics),
      });
      const geometry = mesh(runtime, 'sand-bed').geometry;
      const geometryFailure = new Error('Geometry disposal failed');
      const worldFailure = new Error('World disposal failed');
      const geometryDispose = vi
        .spyOn(geometry, 'dispose')
        .mockImplementationOnce(() => {
          throw geometryFailure;
        });
      const worldFree = vi.spyOn(physics.world, 'free');
      const queueFree = vi.spyOn(physics.eventQueue, 'free');
      (resource === 'world' ? worldFree : queueFree).mockImplementationOnce(
        () => {
          throw worldFailure;
        },
      );
      expect(() => runtime.dispose()).toThrow(AggregateError);
      expect(runtime.getDiagnostics()).toMatchObject({
        lifecycle: 'disposing',
        geometries: 1,
        bodies: 0,
        colliders: 0,
      });
      runtime.dispose();
      runtime.dispose();
      expect(geometryDispose).toHaveBeenCalledTimes(2);
      expect(worldFree).toHaveBeenCalledTimes(resource === 'world' ? 2 : 1);
      expect(queueFree).toHaveBeenCalledTimes(resource === 'world' ? 1 : 2);
      expect(runtime.getDiagnostics().lifecycle).toBe('disposed');
    },
  );

  it('retains a partial visual-construction error through scene rollback until its GPU resources can be retried', async () => {
    const physics = await createPhysicsRuntime();
    owned.push(physics);
    const worldFree = vi.spyOn(physics.world, 'free');
    const allocationFailure = new Error('Visual attachment failed');
    const cleanupFailure = new Error('GPU release failed');
    const geometryDispose = vi
      .spyOn(BufferGeometry.prototype, 'dispose')
      .mockImplementation(() => {
        throw cleanupFailure;
      });
    let failure: unknown;
    try {
      await createSceneRuntime(sunlit, {
        createPhysics: () => Promise.resolve(physics),
        createVisuals(scene, course) {
          vi.spyOn(scene, 'add').mockImplementationOnce(() => {
            throw allocationFailure;
          });
          return createGeneratedSceneVisuals(scene, course);
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConstructionCleanupError);
    if (!(failure instanceof ConstructionCleanupError)) throw failure;
    owned.push(failure);
    expect(failure.cause).toMatchObject({ cause: allocationFailure });
    const allocatedGeometries = new Set(geometryDispose.mock.contexts);
    expect(allocatedGeometries.size).toBeGreaterThan(0);
    expect(geometryDispose.mock.calls.length).toBe(allocatedGeometries.size);
    expect(physics.world.colliders.len()).toBe(0);
    expect(physics.world.bodies.len()).toBe(0);
    expect(worldFree).not.toHaveBeenCalled();
    expect(() => failure.retryCleanup()).toThrow(failure);
    expect(worldFree).not.toHaveBeenCalled();
    geometryDispose.mockRestore();
    failure.retryCleanup();
    failure.dispose();
    expect(worldFree).toHaveBeenCalledTimes(1);
  });
});
