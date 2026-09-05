import {
  AnimationMixer,
  BoxGeometry,
  Group,
  Mesh,
  Scene,
  SphereGeometry,
} from 'three';
import { z } from 'zod';
import type { AssetCache, AssetLease } from '../assets/AssetCache';
import {
  validateLoadedAssetIdentity,
  validateLoadedCourseAsset,
} from '../assets/validateLoadedCourseAsset';
import {
  ConstructionCleanupError,
  releaseResources,
} from '../core/resourceCleanup';
import type { CourseRuntime } from '../course/createCourseRuntime';
import { assertDeltaTime } from '../obstacles/Obstacle';
import type { SceneVisuals } from './SceneVisuals';
import { createRaceMarkers } from './createRaceMarkers';
import { createWaterEffects } from './createWaterEffects';
import { attachUnderwaterEnvironment } from './underwaterEnvironment';
import { createVisualResources } from './visualResources';

const FISH_ASSET = 'fish/sunfin.glb';
const fishPart = z.strictObject({
  version: z.literal(1),
  role: z.literal('fish-part'),
  collides: z.literal(false),
});

export async function createOriginalSceneVisuals(
  scene: Scene,
  course: CourseRuntime,
  cache: AssetCache,
): Promise<SceneVisuals> {
  const definition = course.definition;
  if (definition.visuals.kind !== 'gltf')
    throw new Error('Original visuals require gltf assets.');
  const root = new Group();
  root.name = 'original-course';
  const releases: Array<() => void> = [];
  const mixerReleases: Array<() => void> = [];
  const leaseReleases: Array<() => void> = [];
  const children = new Set<ConstructionCleanupError>();
  const leases = new Set<AssetLease>();
  const resources = createVisualResources(root, releases);
  let disposed = false;

  function cleanup(retryChildren: boolean): unknown[] {
    const errors = releaseResources(releases);
    errors.push(...releaseResources(mixerReleases));
    // Animation bindings borrow the cloned fish hierarchy. Never free it first.
    if (mixerReleases.length === 0)
      errors.push(...releaseResources(leaseReleases));
    if (retryChildren) {
      for (const child of children) {
        try {
          child.retryCleanup();
          children.delete(child);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    return errors;
  }
  function dispose() {
    disposed = true;
    const errors = cleanup(true);
    if (errors.length)
      throw new AggregateError(errors, 'Original scene visual cleanup failed.');
  }
  try {
    const paths = [
      definition.visuals.visualAsset,
      definition.visuals.collisionAsset,
      FISH_ASSET,
    ];
    // allSettled observes early rejections and still transfers every late success.
    const results = await Promise.allSettled(
      paths.map((path) => Promise.resolve().then(() => cache.acquire(path))),
    );
    const failures = new Set<unknown>();
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const lease = result.value;
        if (leases.has(lease)) continue;
        leases.add(lease);
        leaseReleases.push(() => {
          lease.dispose();
          leases.delete(lease);
        });
      } else {
        failures.add(result.reason);
        if (result.reason instanceof ConstructionCleanupError)
          children.add(result.reason);
      }
    }
    if (failures.size)
      throw failures.size === 1
        ? [...failures][0]
        : new AggregateError([...failures], 'Original asset loading failed.');
    const [terrain, collision, fish] = results.map((result) => {
      if (result.status !== 'fulfilled')
        throw new Error('Unsettled original asset.');
      return result.value;
    });
    validateLoadedCourseAsset(
      collision.root,
      definition,
      paths[1],
      'collision',
    );
    validateLoadedCourseAsset(terrain.root, definition, paths[0], 'visual');
    validateLoadedAssetIdentity(fish.root, FISH_ASSET);
    for (const node of fish.root.children)
      fishPart.parse(node.userData.reefRush);
    for (const name of [
      'sunfin-body',
      'sunfin-eye-left',
      'sunfin-eye-right',
      'fin-tail',
      'fin-dorsal',
      'fin-anal',
      'fin-pectoral-left',
      'fin-pectoral-right',
    ]) {
      if (!fish.root.getObjectByName(name))
        throw new Error(`Original Sunfin is missing ${name}.`);
    }
    const swim = fish.animations.find((clip) => clip.name === 'swim');
    if (
      !swim ||
      !Number.isFinite(swim.duration) ||
      swim.duration <= 0 ||
      swim.duration > 60
    )
      throw new Error(
        'Original Sunfin requires a finite looping swim animation.',
      );
    terrain.root.traverse((node) => {
      if (node instanceof Mesh)
        node.userData.ignoreChaseCameraCollision =
          node.name.startsWith('decor-');
    });
    fish.root.name = 'player-fish';
    fish.root.traverse((node) => {
      if (node instanceof Mesh) node.userData.ignoreChaseCameraCollision = true;
    });
    attachUnderwaterEnvironment(scene, root, definition.visuals, releases);
    root.add(terrain.root, fish.root);
    const box = resources.geometry(new BoxGeometry(1, 1, 1));
    const sphere = resources.geometry(new SphereGeometry(1, 12, 8));
    const markers = createRaceMarkers(course, resources, box, sphere);
    const effects = createWaterEffects(root, definition, resources, sphere);
    const mixer = new AnimationMixer(fish.root);
    let stopped = false;
    mixerReleases.push(() => {
      if (!stopped) {
        mixer.stopAllAction();
        stopped = true;
      }
      mixer.uncacheRoot(fish.root);
    });
    mixer.clipAction(swim).play();
    let animationTime = 0;
    scene.add(root);
    return Object.freeze({
      root,
      present(
        position,
        orientation,
        race,
        collectedPearlIds,
        frameSeconds = 0,
      ) {
        if (disposed) throw new Error('OriginalSceneVisuals is disposed.');
        assertDeltaTime(frameSeconds);
        fish.root.position.copy(position);
        fish.root.quaternion.copy(orientation);
        markers.present(race, collectedPearlIds);
        if (race.status === 'running' && frameSeconds > 0) {
          animationTime =
            (animationTime + (frameSeconds % swim.duration)) % swim.duration;
          mixer.setTime(animationTime);
          effects.present(frameSeconds);
        }
        root.updateMatrixWorld(true);
      },
      getResourceCounts() {
        const counts = resources.getResourceCounts();
        for (const lease of leases) {
          if (lease.disposed) continue;
          const borrowed = lease.getResourceCounts();
          counts.geometries += borrowed.geometries;
          counts.materials += borrowed.materials;
        }
        return Object.freeze(counts);
      },
      dispose,
    } satisfies SceneVisuals);
  } catch (cause) {
    if (cause instanceof ConstructionCleanupError) children.add(cause);
    const errors = cleanup(false);
    if (errors.length || children.size) {
      throw new ConstructionCleanupError(
        cause,
        errors,
        [dispose],
        'Original scene creation and resource cleanup failed.',
      );
    }
    throw cause;
  }
}
