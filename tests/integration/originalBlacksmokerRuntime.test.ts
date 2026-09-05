// @vitest-environment node
import { BufferGeometry, Material, Mesh } from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import blacksmoker from '../../src/content/courses/blacksmokerRun';
import { COURSES } from '../../src/content/courses/courseIds';
import { createAssetCache } from '../../src/game/assets/AssetCache';
import {
  createSceneRuntime,
  type SceneRuntime,
} from '../../src/game/core/SceneRuntime';
import { createGeneratedSceneVisuals } from '../../src/game/rendering/createGeneratedSceneVisuals';
import { traverseCourse, courseWaypoints } from '../fixtures/courseTraversal';
import {
  fishAsset,
  blackCollisionAsset,
  blackVisualAsset,
  stubOriginalAssetFetch,
} from '../fixtures/originalAssets';

const scenes: SceneRuntime[] = [];
afterEach(() => {
  for (const scene of scenes.splice(0)) scene.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const reviewed = {
  fast: {
    steps: 1473,
    elapsedMs: 24535.328771155422,
    medal: 'gold',
    dashes: 2,
  },
  conservative: {
    steps: 3152,
    elapsedMs: 52516.82827445285,
    medal: 'bronze',
    dashes: 0,
  },
} as const;

it.each(['fast', 'conservative'] as const)(
  'preserves exact reviewed/generated %s traversal and releases original Blacksmoker assets once across three cycles',
  async (profile) => {
    const fetch = stubOriginalAssetFetch();
    const reference = await createSceneRuntime(
      {
        ...blacksmoker,
        visuals: {
          kind: 'generated',
          waterColor: '#102b3a',
          seabedColor: '#293c46',
        },
      },
      { createVisuals: createGeneratedSceneVisuals },
    );
    scenes.push(reference);
    expect(reference.definition.visuals.kind).toBe('generated');
    expect(reference.getDiagnostics()).toEqual({
      lifecycle: 'active',
      bodies: 3,
      colliders: 13,
      geometries: 4,
      materials: 19,
    });
    const generated = traverseCourse(reference, profile);
    reference.dispose();
    expect(reference.getDiagnostics()).toEqual({
      lifecycle: 'disposed',
      bodies: 0,
      colliders: 0,
      geometries: 0,
      materials: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(generated.steps).toBe(reviewed[profile].steps);
    expect(generated.snapshot.race.elapsedMs).toBe(reviewed[profile].elapsedMs);
    expect(generated.snapshot.race.result?.medal).toBe(reviewed[profile].medal);
    expect(generated.dashes).toBe(reviewed[profile].dashes);
    expect(generated.collisions).toEqual([]);

    const cache = createAssetCache();
    const geometries = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materials = vi.spyOn(Material.prototype, 'dispose');
    let active: ReturnType<SceneRuntime['getDiagnostics']> | undefined;
    for (let cycle = 0; cycle < 3; cycle++) {
      const runtime = await createSceneRuntime(blacksmoker, {
        assetCache: cache,
      });
      scenes.push(runtime);
      expect(runtime.definition.visuals.kind).toBe('gltf');
      expect(
        fetch.mock.calls
          .slice(cycle * 3)
          .map(([request]) => new URL(request.url).pathname)
          .sort(),
      ).toEqual(
        [blackCollisionAsset, blackVisualAsset, fishAsset]
          .map((path) => `/reef-rush/assets/${path}`)
          .sort(),
      );
      expect(runtime.scene.getObjectByName('original-course')).toBeDefined();
      expect(runtime.scene.getObjectByName('generated-course')).toBeUndefined();
      expect(runtime.scene.getObjectByName('fin-tail')).toBeDefined();
      let decorations = 0;
      runtime.scene.traverse((node) => {
        if (!(node instanceof Mesh) || !node.name.startsWith('decor-')) return;
        decorations++;
        expect(node.userData.reefRush).toEqual({
          version: 1,
          role: 'decoration',
          collides: false,
        });
        expect(node.userData.ignoreChaseCameraCollision).toBe(true);
      });
      expect(decorations).toBe(30);
      const counts = runtime.getDiagnostics();
      const borrowed = cache.getDiagnostics();
      expect(borrowed).toMatchObject({
        entries: 3,
        reservations: 3,
        textures: 0,
      });
      expect(counts).toEqual({
        lifecycle: 'active',
        bodies: 3,
        colliders: 13,
        geometries: borrowed.geometries + 3,
        materials: borrowed.materials + 13,
      });
      active ??= counts;
      expect(counts).toEqual(active);
      const tail = runtime.scene.getObjectByName('fin-tail')!;
      const initialTail = tail.quaternion.toArray();
      runtime.setReducedMotion(cycle === 1);
      expect(runtime.scene.getObjectByName('ambient-bubbles')?.visible).toBe(
        cycle !== 1,
      );
      expect(runtime.scene.getObjectByName('current-particles')?.visible).toBe(
        cycle !== 1,
      );
      const actual = traverseCourse(runtime, profile);
      expect(actual).toEqual(generated);
      if (cycle === 1) expect(tail.quaternion.toArray()).toEqual(initialTail);
      else expect(tail.quaternion.toArray()).not.toEqual(initialTail);
      expect(actual.milestones.map(({ id }) => id)).toEqual(
        courseWaypoints(blacksmoker).map(({ id }) => id),
      );
      expect(
        actual.events.filter(({ type }) => type === 'checkpoint'),
      ).toHaveLength(6);
      expect(actual.snapshot.collectedPearlIds).toEqual(
        blacksmoker.pearls.map(({ id }) => id),
      );
      expect(actual.milestones.at(-2)?.id).toBe('smoker-pearl-home');
      expect(actual.milestones.at(-1)?.id).toBe('smoker-finish');
      expect(actual.snapshot.race.result).toMatchObject({
        pearlCount: 6,
        totalPearls: 6,
      });
      expect(runtime.getDiagnostics()).toEqual(counts);
      const geometryCalls = geometries.mock.calls.length;
      const materialCalls = materials.mock.calls.length;
      runtime.dispose();
      runtime.dispose();
      expect(geometries.mock.calls.length - geometryCalls).toBe(
        counts.geometries,
      );
      expect(materials.mock.calls.length - materialCalls).toBe(
        counts.materials,
      );
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
    expect(COURSES.find(({ id }) => id === 'blacksmoker-run')?.available).toBe(
      false,
    );
    console.info(
      `Original/generated Blacksmoker ${profile}: ${JSON.stringify({
        ...reviewed[profile],
        checkpoints: 6,
        pearls: 6,
        contacts: 0,
        cycles: 3,
        active,
        disposedOwners: 0,
        cacheEntries: 0,
      })}`,
    );
  },
);
