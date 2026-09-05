// @vitest-environment node
import {
  AnimationClip,
  AnimationMixer,
  BufferGeometry,
  Color,
  Fog,
  Material,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import sunlit from '../../src/content/courses/sunlitShoals';
import {
  createAssetCache,
  type AssetLease,
} from '../../src/game/assets/AssetCache';
import { ConstructionCleanupError } from '../../src/game/core/resourceCleanup';
import { createCourseRuntime } from '../../src/game/course/createCourseRuntime';
import { createPhysicsRuntime } from '../../src/game/physics/createPhysicsRuntime';
import { RotatingGate } from '../../src/game/obstacles/RotatingGate';
import { RaceSession } from '../../src/game/race/RaceSession';
import {
  collisionAsset,
  deferred,
  fishAsset,
  localAssetLoader,
  originalMetadata,
  visualAsset,
} from '../fixtures/originalAssets';
import { isSceneMesh } from '../fixtures/sceneMeshes';

const owners: Array<{ dispose(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0).reverse()) owner.dispose();
});

async function setup() {
  const physics = await createPhysicsRuntime();
  owners.push(physics);
  const course = createCourseRuntime(physics, {
    ...sunlit,
    visuals: { ...sunlit.visuals, kind: 'gltf', visualAsset, collisionAsset },
  });
  owners.push(course);
  const scene = new Scene();
  const background = new Color('#123456');
  const fog = new Fog('#123456', 3, 9);
  scene.background = background;
  scene.fog = fog;
  const cache = createAssetCache({ loader: localAssetLoader });
  const { createOriginalSceneVisuals } =
    await import('../../src/game/rendering/createOriginalSceneVisuals');
  return {
    physics,
    course,
    scene,
    background,
    fog,
    cache,
    createOriginalSceneVisuals,
  };
}

function getMesh(scene: Scene, name: string) {
  const mesh = scene.getObjectByName(name);
  if (!isSceneMesh(mesh)) throw new Error(`Missing mesh ${name}`);
  return mesh;
}

it('attaches original lit terrain/fish, authoritative markers and live Rapier gates; excludes every decoration', async () => {
  const { scene, course, cache, createOriginalSceneVisuals } = await setup();
  const visuals = await createOriginalSceneVisuals(scene, course, cache);
  owners.push(visuals);
  expect(visuals.root.name).toBe('original-course');
  expect(scene.getObjectByName('sunfin-body')).toBeDefined();
  expect(scene.getObjectByName('fin-tail')).toBeDefined();
  expect(scene.getObjectByName('fish-body')).toBeUndefined();
  expect(scene.getObjectByName('sunfin-body')?.parent?.name).toBe(
    'player-fish',
  );
  const staticIds = new Set(course.solids.map((solid) => solid.definition.id));
  const colors = new Set<string>();
  scene.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    expect(Boolean(node.userData.ignoreChaseCameraCollision), node.name).toBe(
      !staticIds.has(node.name) && node.name !== 'sway-beam',
    );
    for (const material of Array.isArray(node.material)
      ? node.material
      : [node.material]) {
      expect(material).toBeInstanceOf(MeshStandardMaterial);
      if (material instanceof MeshStandardMaterial)
        colors.add(material.color.getHexString());
    }
  });
  expect(colors.size).toBeGreaterThan(10);
  for (const color of [
    'e87928',
    'fff0cb',
    '208d8b',
    'e99982',
    'a397c8',
    '429b7c',
  ])
    expect(colors.has(color), color).toBe(true);
  expect(scene.children.filter((node) => node === visuals.root)).toHaveLength(
    1,
  );
  const gate = course.obstacles.find(
    (obstacle) => obstacle instanceof RotatingGate,
  )!;
  gate.body.setTranslation({ x: 3, y: -2, z: 51 }, true);
  gate.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
  const race = new RaceSession(course.definition);
  race.start();
  race.step([0, -4, 11], [0, -4, 13], 0.1);
  visuals.present(
    new Vector3(1, -4, 2),
    new Quaternion(),
    race.getState(),
    ['pearl-entry'],
    0.1,
  );
  expect(getMesh(scene, 'sway-beam').position.toArray()).toEqual([3, -2, 51]);
  expect(getMesh(scene, 'sway-beam').quaternion.toArray()).toEqual([
    0, 0, 1, 0,
  ]);
  expect(getMesh(scene, 'shoals-entry').userData.checkpointState).toBe(
    'completed',
  );
  expect(getMesh(scene, 'coral-bend').userData.checkpointState).toBe(
    'upcoming',
  );
  expect(getMesh(scene, 'pearl-entry').visible).toBe(false);
  expect(getMesh(scene, 'warm-current').material).toMatchObject({
    transparent: true,
    depthWrite: false,
  });
});

it('runs deterministic independent swim/effects only while running and bounds huge finite frame time', async () => {
  const { scene, course, cache, createOriginalSceneVisuals } = await setup();
  const otherScene = new Scene();
  const visuals = await createOriginalSceneVisuals(scene, course, cache);
  const other = await createOriginalSceneVisuals(otherScene, course, cache);
  owners.push(visuals, other);
  const race = new RaceSession(course.definition);
  const present = (seconds: number) =>
    visuals.present(
      new Vector3(),
      new Quaternion(),
      race.getState(),
      [],
      seconds,
    );
  const tail = scene.getObjectByName('fin-tail')!;
  const otherTail = otherScene.getObjectByName('fin-tail')!;
  const bubbles = scene.getObjectByName('ambient-bubbles')!;
  const flow = scene.getObjectByName('current-particles')!;
  expect(bubbles.children.length).toBeGreaterThan(0);
  expect(bubbles.children.length + flow.children.length).toBeLessThanOrEqual(
    80,
  );
  const poses = () =>
    [tail, ...bubbles.children, ...flow.children].map((node) => [
      ...node.position.toArray(),
      ...node.quaternion.toArray(),
    ]);
  const initial = poses();
  present(0.1);
  expect(poses()).toEqual(initial);
  race.start();
  present(0.137);
  expect(poses()).not.toEqual(initial);
  expect(tail.quaternion.toArray()).not.toEqual(otherTail.quaternion.toArray());
  other.present(new Vector3(), new Quaternion(), race.getState(), [], 0.137);
  expect(otherTail.quaternion.toArray()).toEqual(tail.quaternion.toArray());
  race.pause();
  const paused = poses();
  present(100);
  expect(poses()).toEqual(paused);
  race.resume();
  present(0.151);
  expect(poses()).not.toEqual(paused);
  const counts = visuals.getResourceCounts();
  const update = vi.spyOn(AnimationMixer.prototype, 'update');
  for (let i = 0; i < 4; i++) present(Number.MAX_VALUE);
  expect(update).toHaveBeenCalled();
  expect(
    update.mock.contexts.every(
      (mixer) =>
        mixer instanceof AnimationMixer &&
        Number.isFinite(mixer.time) &&
        mixer.time < 60,
    ),
  ).toBe(true);
  expect(poses().flat().every(Number.isFinite)).toBe(true);
  expect(visuals.getResourceCounts()).toEqual(counts);
  const finished = { ...race.getState(), status: 'finished' as const };
  const terminal = poses();
  visuals.present(
    new Vector3(),
    new Quaternion(),
    finished,
    [],
    Number.MAX_VALUE,
  );
  expect(poses()).toEqual(terminal);
});

it('does not mutate shared materials and reports only still-owned resources, even with another cache consumer', async () => {
  const { scene, course, cache, background, fog, createOriginalSceneVisuals } =
    await setup();
  const borrowed = await cache.acquire(fishAsset);
  owners.push(borrowed);
  const before: string[] = [];
  borrowed.root.traverse((node) => {
    if (node instanceof Mesh) before.push(JSON.stringify(node.material));
  });
  const geometries = vi.spyOn(BufferGeometry.prototype, 'dispose');
  const materials = vi.spyOn(Material.prototype, 'dispose');
  const visuals = await createOriginalSceneVisuals(scene, course, cache);
  owners.push(visuals);
  const counts = visuals.getResourceCounts();
  expect(counts.geometries).toBeGreaterThan(10);
  const stop = vi.spyOn(AnimationMixer.prototype, 'stopAllAction');
  const uncache = vi.spyOn(AnimationMixer.prototype, 'uncacheRoot');
  visuals.dispose();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(uncache).toHaveBeenCalledTimes(1);
  expect(visuals.getResourceCounts()).toEqual({ geometries: 0, materials: 0 });
  expect(scene.background).toBe(background);
  expect(scene.fog).toBe(fog);
  expect(scene.children).toHaveLength(0);
  const after: string[] = [];
  borrowed.root.traverse((node) => {
    if (node instanceof Mesh) after.push(JSON.stringify(node.material));
  });
  expect(after).toEqual(before);
  const remaining = cache.getDiagnostics();
  expect(remaining.entries).toBe(1);
  expect(geometries.mock.calls.length + remaining.geometries).toBe(
    counts.geometries,
  );
  expect(materials.mock.calls.length + remaining.materials).toBe(
    counts.materials,
  );
  borrowed.dispose();
  expect(cache.getDiagnostics()).toEqual({
    entries: 0,
    reservations: 0,
    geometries: 0,
    materials: 0,
    textures: 0,
  });
});

it('retains failed geometry and retries just that resource with exact partial counts', async () => {
  const { scene, course, cache, createOriginalSceneVisuals } = await setup();
  const visuals = await createOriginalSceneVisuals(scene, course, cache);
  owners.push(visuals);
  const geometry = getMesh(scene, 'sand-bed').geometry;
  const release = vi.spyOn(geometry, 'dispose').mockImplementationOnce(() => {
    throw new Error('GPU busy');
  });
  expect(() => visuals.dispose()).toThrow();
  expect(visuals.getResourceCounts()).toEqual({ geometries: 1, materials: 0 });
  expect(cache.getDiagnostics().entries).toBe(1);
  visuals.dispose();
  visuals.dispose();
  expect(release).toHaveBeenCalledTimes(2);
  expect(visuals.getResourceCounts()).toEqual({ geometries: 0, materials: 0 });
});

it('does not release a fish lease until mixer cleanup succeeds', async () => {
  const { scene, course, cache, createOriginalSceneVisuals } = await setup();
  const visuals = await createOriginalSceneVisuals(scene, course, cache);
  owners.push(visuals);
  const uncache = vi
    .spyOn(AnimationMixer.prototype, 'uncacheRoot')
    .mockImplementationOnce(() => {
      throw new Error('mixer busy');
    });
  expect(() => visuals.dispose()).toThrow();
  expect(cache.getDiagnostics().reservations).toBeGreaterThan(0);
  visuals.dispose();
  expect(uncache).toHaveBeenCalledTimes(2);
  expect(cache.getDiagnostics().entries).toBe(0);
});

it('awaits all siblings, retains validation-failure leases and retries their failed cleanup explicitly', async () => {
  const { scene, course, cache, createOriginalSceneVisuals } = await setup();
  const late = deferred<AssetLease>();
  const failure = new Error('collision load rejected first');
  const acquire = vi.spyOn(cache, 'acquire');
  // Use a separate real cache for the late success to avoid mocking the resource owner.
  const source = createAssetCache({ loader: localAssetLoader });
  const lease = await source.acquire(fishAsset);
  owners.push(lease);
  const dispose = vi.spyOn(lease, 'dispose').mockImplementationOnce(() => {
    throw new Error('late lease cleanup');
  });
  acquire.mockImplementation((path) =>
    path === fishAsset ? late.promise : Promise.reject(failure),
  );
  let settled = false;
  const pending = createOriginalSceneVisuals(scene, course, cache).then(
    (visuals) => {
      settled = true;
      owners.push(visuals);
      return new Error('Unexpected success');
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(3));
  await Promise.resolve();
  expect(settled).toBe(false);
  late.resolve(lease);
  const error = await pending;
  expect(error).toBeInstanceOf(ConstructionCleanupError);
  if (!(error instanceof ConstructionCleanupError)) throw error;
  owners.push(error);
  expect(dispose).toHaveBeenCalledTimes(1);
  error.retryCleanup();
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(source.getDiagnostics().entries).toBe(0);
});

it('deduplicates identical rejected construction owners without any implicit child retry', async () => {
  const { scene, course, cache, createOriginalSceneVisuals } = await setup();
  const childCleanup = vi.fn().mockImplementationOnce(() => {
    throw new Error('still busy');
  });
  const child = new ConstructionCleanupError(
    new Error('load construction'),
    [],
    [childCleanup],
    'shared owner',
  );
  vi.spyOn(cache, 'acquire').mockRejectedValue(child);
  const error: unknown = await createOriginalSceneVisuals(
    scene,
    course,
    cache,
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ConstructionCleanupError);
  if (!(error instanceof ConstructionCleanupError)) throw error;
  owners.push(error);
  expect(childCleanup).not.toHaveBeenCalled();
  expect(() => error.retryCleanup()).toThrow(error);
  expect(childCleanup).toHaveBeenCalledTimes(1);
  error.retryCleanup();
  expect(childCleanup).toHaveBeenCalledTimes(2);
});

it('cleans every successful lease on a loaded collision disagreement with no generated fallback', async () => {
  const { scene, course, cache, createOriginalSceneVisuals } = await setup();
  const collision = await cache.acquire(collisionAsset);
  owners.push(collision);
  originalMetadata(
    getMesh(new Scene().add(collision.root), 'sand-bed'),
  ).version = 2;
  vi.spyOn(cache, 'acquire').mockImplementation(async (path) => {
    if (path === collisionAsset) return collision;
    const asset = await createAssetCache({ loader: localAssetLoader }).acquire(
      path,
    );
    owners.push(asset);
    return asset;
  });
  const release = vi.spyOn(collision, 'dispose').mockImplementationOnce(() => {
    throw new Error('validation cleanup busy');
  });
  const error: unknown = await createOriginalSceneVisuals(
    scene,
    course,
    cache,
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ConstructionCleanupError);
  if (!(error instanceof ConstructionCleanupError)) throw error;
  owners.push(error);
  expect(release).toHaveBeenCalledTimes(1);
  expect(scene.children).toHaveLength(0);
  error.retryCleanup();
  expect(release).toHaveBeenCalledTimes(2);
  expect(cache.getDiagnostics().entries).toBe(0);
});

it.each([
  [
    'fish profile',
    (lease: AssetLease) => {
      originalMetadata(lease.root).profile = 'other';
    },
  ],
  [
    'fish identity',
    (lease: AssetLease) => {
      originalMetadata(lease.root).asset = visualAsset;
    },
  ],
  [
    'fish units',
    (lease: AssetLease) => {
      originalMetadata(lease.root).metersPerUnit = 100;
    },
  ],
  [
    'missing fin',
    (lease: AssetLease) => {
      lease.root.getObjectByName('fin-tail')!.name = 'not-a-tail';
    },
  ],
  [
    'colliding fish part',
    (lease: AssetLease) => {
      originalMetadata(lease.root.getObjectByName('fin-tail')!).collides = true;
    },
  ],
  ['unbounded clip duration', () => {}],
] as const)(
  'rejects %s and releases all acquired assets',
  async (name, mutate) => {
    const { scene, course, cache, createOriginalSceneVisuals } = await setup();
    const acquire = cache.acquire.bind(cache);
    vi.spyOn(cache, 'acquire').mockImplementation(async (path) => {
      const lease = await acquire(path);
      if (path !== fishAsset) return lease;
      mutate(lease);
      if (name === 'unbounded clip duration') {
        return {
          ...lease,
          animations: [new AnimationClip('swim', Number.MAX_VALUE, [])],
        };
      }
      return lease;
    });
    const result = await createOriginalSceneVisuals(scene, course, cache).then(
      (visuals) => {
        owners.push(visuals);
        return visuals;
      },
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(Error);
    expect(scene.children).toHaveLength(0);
    expect(cache.getDiagnostics().entries).toBe(0);
  },
);
