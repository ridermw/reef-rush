import {
  Box3,
  BufferGeometry,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { generatedSunlit as sunlit } from '../fixtures/sunlitTraversal';
import { ConstructionCleanupError } from '../../src/game/core/resourceCleanup';
import { createCourseRuntime } from '../../src/game/course/createCourseRuntime';
import { createPhysicsRuntime } from '../../src/game/physics/createPhysicsRuntime';
import { RaceSession } from '../../src/game/race/RaceSession';
import { createGeneratedSceneVisuals } from '../../src/game/rendering/createGeneratedSceneVisuals';
import { isSceneMesh } from '../fixtures/sceneMeshes';

const resources: Array<{ dispose(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0).reverse()) resource.dispose();
});

async function setup() {
  const physics = await createPhysicsRuntime();
  resources.push(physics);
  const course = createCourseRuntime(physics, sunlit);
  resources.push(course);
  const scene = new Scene();
  return { physics, course, scene };
}

function getMesh(
  scene: Scene,
  name: string,
): Mesh<BufferGeometry, Material | Material[]> {
  const object = scene.getObjectByName(name);
  expect(object).toBeInstanceOf(Mesh);
  if (!isSceneMesh(object)) throw new Error(`Expected mesh ${name}`);
  return object;
}

it('builds authored dimensions, transforms and palette with every decorative mesh excluded from camera collision', async () => {
  const { scene, course } = await setup();
  expect(() =>
    resources.push(createGeneratedSceneVisuals(scene, course)),
  ).not.toThrow();
  const meshes: Mesh[] = [];
  scene.traverse((object) => {
    if (isSceneMesh(object)) meshes.push(object);
  });
  expect(meshes.length).toBeGreaterThan(
    sunlit.objects.length + sunlit.checkpoints.length + sunlit.pearls.length,
  );
  for (const object of sunlit.objects) {
    const mesh = getMesh(scene, object.id);
    expect(mesh.position.toArray()).toEqual(object.position);
    expect(mesh.material).toBeInstanceOf(MeshStandardMaterial);
    if (!(mesh.material instanceof MeshStandardMaterial))
      throw new Error('Missing lit material');
    expect(mesh.material.color.getHexString()).toBe(object.color.slice(1));
    expect(Boolean(mesh.userData.ignoreChaseCameraCollision)).toBe(
      object.type === 'current',
    );
    mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox
      ?.getSize(new Vector3())
      .multiply(mesh.scale);
    const expected =
      object.type === 'sphere'
        ? [object.radius * 2, object.radius * 2, object.radius * 2]
        : object.halfExtents.map((value) => value * 2);
    size
      ?.toArray()
      .forEach((value, index) => expect(value).toBeCloseTo(expected[index], 5));
    if (object.type === 'box')
      expect(mesh.quaternion.toArray()).toEqual(object.rotation);
    if (object.type === 'current') {
      expect(mesh.material.transparent).toBe(true);
      expect(mesh.material.opacity).toBeGreaterThan(0);
      expect(mesh.material.opacity).toBeLessThan(0.5);
      expect(mesh.material.depthWrite).toBe(false);
    }
  }
  const environmentalIds = new Set(
    sunlit.objects
      .filter((object) => object.type !== 'current')
      .map((object) => object.id),
  );
  for (const mesh of meshes.filter(
    (mesh) => !environmentalIds.has(mesh.name),
  )) {
    expect(mesh.userData.ignoreChaseCameraCollision, mesh.name).toBe(true);
  }
  expect(scene.getObjectByName('player-fish')).toBeInstanceOf(Group);
  const body = getMesh(scene, 'fish-body');
  const bounds = new Box3().setFromObject(body).getSize(new Vector3());
  expect(bounds.z).toBeGreaterThan(bounds.x);
});

it('orients checkpoint rings to their planes and distinguishes upcoming, future, finish and completed states', async () => {
  const { physics, course: original, scene } = await setup();
  original.dispose();
  const source = {
    ...sunlit,
    checkpoints: sunlit.checkpoints.map((checkpoint, index) => ({
      ...checkpoint,
      direction: index === 0 ? [1, 0, 0] : checkpoint.direction,
    })),
  };
  const course = createCourseRuntime(physics, source);
  resources.push(course);
  let visuals: ReturnType<typeof createGeneratedSceneVisuals> | undefined;
  expect(() => {
    visuals = createGeneratedSceneVisuals(scene, course);
  }).not.toThrow();
  if (!visuals) throw new Error('Missing visuals');
  resources.push(visuals);
  const race = new RaceSession(source);
  visuals.present(new Vector3(0, -4, 0), new Quaternion(), race.getState(), []);
  const first = getMesh(scene, 'shoals-entry');
  const second = getMesh(scene, 'coral-bend');
  const finish = getMesh(scene, 'shoals-finish');
  expect(new Vector3(0, 0, 1).applyQuaternion(first.quaternion).x).toBeCloseTo(
    1,
  );
  expect(first.userData.checkpointState).toBe('upcoming');
  expect(second.userData.checkpointState).toBe('future');
  expect(finish.userData.finish).toBe(true);
  expect(first.material).not.toBe(second.material);
  expect(finish.material).not.toBe(second.material);
  race.start();
  race.step([-1, -4, 12], [1, -4, 12], 0.1);
  visuals.present(new Vector3(1, -4, 12), new Quaternion(), race.getState(), [
    'pearl-entry',
  ]);
  expect(first.userData.checkpointState).toBe('completed');
  expect(second.userData.checkpointState).toBe('upcoming');
  expect(getMesh(scene, 'pearl-entry').visible).toBe(false);
  expect(getMesh(scene, 'pearl-bend').visible).toBe(true);
});

it('rolls back allocations and scene attachments when generation fails partway through', async () => {
  const { scene, course } = await setup();
  const geometries = vi.spyOn(BufferGeometry.prototype, 'dispose');
  const materials = vi.spyOn(Material.prototype, 'dispose');
  const failure = new Error('Generated mesh attachment failed');
  let attachments = 0;
  vi.spyOn(Group.prototype, 'add').mockImplementation(function (
    this: Group,
    ...objects
  ) {
    if (++attachments === 4) throw failure;
    Object3D.prototype.add.apply(this, objects);
    return this;
  });
  expect(() => createGeneratedSceneVisuals(scene, course)).toThrow(failure);
  expect(geometries.mock.calls.length).toBeGreaterThan(0);
  expect(materials.mock.calls.length).toBeGreaterThan(0);
  expect(new Set(geometries.mock.contexts).size).toBe(
    geometries.mock.calls.length,
  );
  expect(new Set(materials.mock.contexts).size).toBe(
    materials.mock.calls.length,
  );
  expect(scene.children).toHaveLength(0);
  expect(scene.background).toBeNull();
  expect(scene.fog).toBeNull();
});

it('retains a partial GPU cleanup owner and retries only resources that failed disposal', async () => {
  const { scene, course } = await setup();
  const allocationFailure = new Error('Cannot attach visual root');
  const cleanupFailure = new Error('Cannot release geometry yet');
  vi.spyOn(scene, 'add').mockImplementationOnce(() => {
    throw allocationFailure;
  });
  const dispose = vi
    .spyOn(BufferGeometry.prototype, 'dispose')
    .mockImplementationOnce(() => {
      throw cleanupFailure;
    });
  let failure: unknown;
  try {
    createGeneratedSceneVisuals(scene, course);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ConstructionCleanupError);
  if (!(failure instanceof ConstructionCleanupError)) throw failure;
  resources.push(failure);
  expect(failure.cause).toBe(allocationFailure);
  expect(failure.errors).toContain(cleanupFailure);
  const calls = dispose.mock.calls.length;
  failure.retryCleanup();
  failure.dispose();
  expect(dispose.mock.calls.length).toBe(calls + 1);
  expect(scene.children).toHaveLength(0);
});
