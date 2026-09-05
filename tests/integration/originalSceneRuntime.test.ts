// @vitest-environment node
import { AnimationMixer, BufferGeometry, Material, Mesh } from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import sunlit from '../../src/content/courses/sunlitShoals';
import { createAssetCache } from '../../src/game/assets/AssetCache';
import {
  createSceneRuntime,
  type SceneRuntime,
} from '../../src/game/core/SceneRuntime';
import {
  localAssetLoader,
  stubOriginalAssetFetch,
} from '../fixtures/originalAssets';
import { forwardInput, traverseSunlit } from '../fixtures/sunlitTraversal';

const scenes: SceneRuntime[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const scene of scenes.splice(0)) scene.dispose();
  vi.unstubAllGlobals();
});

it('keeps exact active allocations stable across three original cycles and releases each resource once', async () => {
  const cache = createAssetCache({ loader: localAssetLoader });
  const geometries = vi.spyOn(BufferGeometry.prototype, 'dispose');
  const materials = vi.spyOn(Material.prototype, 'dispose');
  let active: ReturnType<SceneRuntime['getDiagnostics']> | undefined;
  for (let cycle = 0; cycle < 3; cycle++) {
    const runtime = await createSceneRuntime(sunlit, { assetCache: cache });
    scenes.push(runtime);
    const counts = runtime.getDiagnostics();
    const borrowed = cache.getDiagnostics();
    expect(counts).toEqual({
      lifecycle: 'active',
      bodies: 1,
      colliders: 7,
      geometries: borrowed.geometries + 3,
      materials: borrowed.materials + 9,
    });
    active ??= counts;
    expect(counts).toEqual(active);
    const geometryCalls = geometries.mock.calls.length;
    const materialCalls = materials.mock.calls.length;
    runtime.dispose();
    runtime.dispose();
    expect(geometries.mock.calls.length - geometryCalls).toBe(
      counts.geometries,
    );
    expect(materials.mock.calls.length - materialCalls).toBe(counts.materials);
    expect(runtime.getDiagnostics()).toEqual({
      lifecycle: 'disposed',
      bodies: 0,
      colliders: 0,
      geometries: 0,
      materials: 0,
    });
    expect(cache.getDiagnostics()).toEqual({
      entries: 0,
      reservations: 0,
      geometries: 0,
      materials: 0,
      textures: 0,
    });
  }
  expect(new Set(geometries.mock.contexts).size).toBe(
    geometries.mock.calls.length,
  );
  expect(new Set(materials.mock.contexts).size).toBe(
    materials.mock.calls.length,
  );
  console.info(
    `Original active resources: ${JSON.stringify(active)}; zero owners after each of 3 cycles`,
  );
});

it('defaults to exactly three real GLBs and finishes unchanged Sunlit through steer/throttle with real Rapier', async () => {
  const fetch = stubOriginalAssetFetch();
  const runtime = await createSceneRuntime(sunlit);
  scenes.push(runtime);
  expect(runtime.definition.visuals.kind).toBe('gltf');
  expect(
    fetch.mock.calls.map(([request]) => new URL(request.url).pathname).sort(),
  ).toEqual([
    '/reef-rush/assets/courses/sunlit-shoals.collision.glb',
    '/reef-rush/assets/courses/sunlit-shoals.visual.glb',
    '/reef-rush/assets/fish/sunfin.glb',
  ]);
  expect(runtime.scene.getObjectByName('original-course')).toBeDefined();
  const { steps, steeringSteps, checkpointIds, pearlIds } = traverseSunlit(
    runtime,
    true,
  );
  expect(steps).toBe(1317);
  expect(steeringSteps).toBeGreaterThan(100);
  expect(checkpointIds).toEqual(
    sunlit.checkpoints.map((checkpoint) => checkpoint.id),
  );
  expect(pearlIds).toEqual(sunlit.pearls.map((pearl) => pearl.id));
  const snapshot = runtime.getSnapshot();
  expect(snapshot.race.status).toBe('finished');
  expect(snapshot.race.elapsedMs).toBeCloseTo(21940.483, 3);
  expect(snapshot.race.result?.medal).toBe('bronze');
  const tail = runtime.scene.getObjectByName('fin-tail')!;
  const rotation = tail.quaternion.toArray();
  runtime.present(1, Number.MAX_VALUE);
  expect(tail.quaternion.toArray()).toEqual(rotation);
  expect(runtime.getSnapshot()).toEqual(snapshot);
  console.info(
    `Original Sunlit traversal: ${steps} fixed steps, ${snapshot.race.elapsedMs.toFixed(3)}ms, ${checkpointIds.length} checkpoints, ${pearlIds.length} pearls, medal=${snapshot.race.result?.medal}`,
  );
});

it('forwards active frame time but freezes paused swim/effects, with finite huge presentation and unchanged physics', async () => {
  stubOriginalAssetFetch();
  const runtime = await createSceneRuntime(sunlit);
  scenes.push(runtime);
  expect(runtime.scene.getObjectByName('fin-tail')).toBeDefined();
  const update = vi.spyOn(AnimationMixer.prototype, 'update');
  runtime.start();
  runtime.step(forwardInput, 1 / 60);
  const before = runtime.getSnapshot();
  runtime.present(1, 0.137);
  expect(update).toHaveBeenCalled();
  runtime.pause();
  const pausedCalls = update.mock.calls.length;
  runtime.present(0, Number.MAX_VALUE);
  expect(update).toHaveBeenCalledTimes(pausedCalls);
  runtime.resume();
  for (let i = 0; i < 3; i++) runtime.present(0.5, Number.MAX_VALUE);
  expect(runtime.getSnapshot().fish).toEqual(before.fish);
  expect(runtime.getSnapshot().race.elapsedMs).toBe(before.race.elapsedMs);
  runtime.scene.traverse((node) => {
    expect(node.matrixWorld.elements.every(Number.isFinite), node.name).toBe(
      true,
    );
  });
  expect(runtime.camera.projectionMatrix.elements.every(Number.isFinite)).toBe(
    true,
  );
  expect(runtime.scene.getObjectByName('sand-bed')).toBeInstanceOf(Mesh);
  runtime.dispose();
  expect(runtime.getDiagnostics()).toEqual({
    lifecycle: 'disposed',
    geometries: 0,
    materials: 0,
    bodies: 0,
    colliders: 0,
  });
});
