import { Mesh } from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppStore } from '../../src/app/appStore';
import sunlit from '../../src/content/courses/sunlitShoals';
import {
  createAssetCache,
  type AssetTemplate,
} from '../../src/game/assets/AssetCache';
import { GameHost, type HostRenderer } from '../../src/game/core/GameHost';
import { createSceneRuntime } from '../../src/game/core/SceneRuntime';
import { parseCourseDefinition } from '../../src/game/course/courseDefinition';
import {
  collisionAsset,
  deferred,
  fishAsset,
  localAssetLoader,
  visualAsset,
} from '../fixtures/originalAssets';

const hosts: GameHost[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) {
    host.retryCleanup();
    await host.dispose();
  }
  document.body.replaceChildren();
});

async function setup() {
  const slots = new Map(
    [visualAsset, collisionAsset, fishAsset].map((path) => [
      path,
      deferred<AssetTemplate>(),
    ]),
  );
  const loader = {
    loadAsync: vi.fn((url: string) => {
      const slot = slots.get(url.replace('/reef-rush/assets/', ''));
      if (!slot) throw new Error(`Unexpected request ${url}`);
      return slot.promise;
    }),
  };
  const cache = createAssetCache({ loader });
  const store = createAppStore();
  const canvas = document.createElement('canvas');
  const renderer: HostRenderer = {
    domElement: canvas,
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    forceContextLoss: vi.fn(),
  };
  const createRenderer = vi.fn(() => Promise.resolve(renderer));
  const host = new GameHost(store, {
    loadCourse: () => Promise.resolve(parseCourseDefinition(sunlit)),
    createScene: (definition) =>
      createSceneRuntime(definition, { assetCache: cache }),
    createRenderer,
    isFocused: () => true,
    requestFrame: () => 1,
    cancelFrame: () => {},
    observeResize: () => () => {},
    measure: () => ({ width: 960, height: 720, dpr: 1 }),
    storage: () => ({ getItem: () => null, setItem: () => {} }),
  });
  hosts.push(host);
  host.setContainer(document.body.appendChild(document.createElement('div')));
  function load() {
    store.dispatch({ type: 'OPEN_COURSE_SELECT' });
    store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
    return host.whenIdle();
  }
  const pending = load();
  await vi.waitFor(() => expect(loader.loadAsync).toHaveBeenCalledTimes(3));
  return { host, cache, store, slots, pending, load, loader, createRenderer };
}

it.each([false, true])(
  'cancels between real asset completions, retaining late cleanup failure=%s at the host until explicit retry',
  async (failCleanup) => {
    const h = await setup();
    for (const path of [visualAsset, collisionAsset]) {
      const asset = await localAssetLoader.loadAsync(
        `/reef-rush/assets/${path}`,
      );
      const clone = vi.spyOn(asset.scene, 'clone');
      h.slots.get(path)!.resolve(asset);
      await vi.waitFor(() => expect(clone).toHaveBeenCalledTimes(1));
    }
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    expect(h.store.getState().screen).toBe('title');
    expect(h.host.getSnapshot().lifecycle).toBe('loading');
    const fish = await localAssetLoader.loadAsync(
      `/reef-rush/assets/${fishAsset}`,
    );
    const fin = fish.scene.getObjectByName('fin-tail');
    if (!(fin instanceof Mesh)) throw new Error('Missing real fish fin');
    const release = vi.spyOn(fin.geometry, 'dispose');
    if (failCleanup)
      release.mockImplementationOnce(() => {
        throw new Error('late GPU cleanup failed');
      });
    h.slots.get(fishAsset)!.resolve(fish);
    await h.pending;
    expect(h.createRenderer).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(h.host.getSnapshot().lifecycle).toBe(
      failCleanup ? 'cleanup-pending' : 'idle',
    );
    if (failCleanup) {
      expect(h.host.getSnapshot().cleanupError).toContain('cleanup failed');
      expect(h.host.getSnapshot().resources.pendingCleanup).toBe(1);
      await expect(h.host.dispose()).rejects.toThrow('cleanup is pending');
      expect(release).toHaveBeenCalledTimes(1);
      h.host.retryCleanup();
      expect(release).toHaveBeenCalledTimes(2);
    }
    expect(h.cache.getDiagnostics()).toEqual({
      entries: 0,
      reservations: 0,
      geometries: 0,
      materials: 0,
      textures: 0,
    });
    expect(h.host.getSnapshot().resources).toMatchObject({
      canvases: 0,
      rafChains: 0,
      pendingCleanup: 0,
      scene: null,
    });
  },
);

it('waits for late siblings after a collision rejection, then shows an error and retries in the same host', async () => {
  const h = await setup();
  h.slots.get(collisionAsset)!.reject(new Error('collision request failed'));
  await Promise.resolve();
  expect(h.store.getState().screen).toBe('loading');
  for (const path of [visualAsset, fishAsset]) {
    h.slots
      .get(path)!
      .resolve(await localAssetLoader.loadAsync(`/reef-rush/assets/${path}`));
  }
  await h.pending;
  expect(h.store.getState().screen).toBe('error');
  expect(h.cache.getDiagnostics().entries).toBe(0);
  expect(h.host.getSnapshot().resources.pendingCleanup).toBe(0);
  h.store.dispatch({ type: 'RETURN_TO_TITLE' });
  h.loader.loadAsync.mockImplementation((url) =>
    localAssetLoader.loadAsync(url),
  );
  await h.load();
  expect(h.store.getState().screen).toBe('playing');
  expect(h.host.getSnapshot().resources.scene?.geometries).toBeGreaterThan(0);
  h.store.dispatch({ type: 'RETURN_TO_TITLE' });
  await h.host.whenIdle();
  expect(h.cache.getDiagnostics().entries).toBe(0);
});

it('retains cancelled construction cleanup after an early rejection and a later successful lease', async () => {
  const h = await setup();
  h.slots
    .get(collisionAsset)!
    .reject(new Error('collision failed before fish'));
  const terrain = await localAssetLoader.loadAsync(
    `/reef-rush/assets/${visualAsset}`,
  );
  const cloned = vi.spyOn(terrain.scene, 'clone');
  h.slots.get(visualAsset)!.resolve(terrain);
  await vi.waitFor(() => expect(cloned).toHaveBeenCalledTimes(1));
  h.store.dispatch({ type: 'RETURN_TO_TITLE' });
  const fish = await localAssetLoader.loadAsync(
    `/reef-rush/assets/${fishAsset}`,
  );
  const fin = fish.scene.getObjectByName('fin-tail');
  if (!(fin instanceof Mesh)) throw new Error('Missing real fish fin');
  const release = vi
    .spyOn(fin.geometry, 'dispose')
    .mockImplementationOnce(() => {
      throw new Error('late construction rollback failed');
    });
  h.slots.get(fishAsset)!.resolve(fish);
  await h.pending;
  expect(h.host.getSnapshot()).toMatchObject({
    lifecycle: 'cleanup-pending',
    screen: 'title',
    resources: { pendingCleanup: 1, scene: null, canvases: 0, rafChains: 0 },
  });
  expect(h.host.getSnapshot().cleanupError).toContain('cleanup failed');
  expect(release).toHaveBeenCalledTimes(1);
  expect(h.cache.getDiagnostics()).toMatchObject({
    entries: 1,
    geometries: 1,
    materials: 0,
  });
  h.host.retryCleanup();
  expect(release).toHaveBeenCalledTimes(2);
  expect(h.cache.getDiagnostics().entries).toBe(0);
  expect(h.host.getSnapshot().lifecycle).toBe('idle');
});
