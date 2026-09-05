// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  AnimationMixer,
  BufferGeometry,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Texture,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AssetCacheDependencies,
  AssetLease,
  AssetTemplate,
} from '../../src/game/assets/AssetCache';
import { ConstructionCleanupError } from '../../src/game/core/resourceCleanup';
import { isSceneMesh } from '../fixtures/sceneMeshes';

const owners: Array<{ dispose(): void }> = [];
const fixtureResources = new Set<BufferGeometry | Material | Texture>();
const fixtureDisposed = new Set<BufferGeometry | Material | Texture>();

function track<T extends BufferGeometry | Material | Texture>(resource: T): T {
  fixtureResources.add(resource);
  resource.addEventListener('dispose', () => fixtureDisposed.add(resource));
  return resource;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const owner of owners.splice(0).reverse()) owner.dispose();
  for (const resource of fixtureResources) {
    if (!fixtureDisposed.has(resource)) resource.dispose();
  }
  fixtureResources.clear();
  fixtureDisposed.clear();
});

async function createCache(dependencies?: AssetCacheDependencies) {
  const { createAssetCache } = await import('../../src/game/assets/AssetCache');
  return createAssetCache(dependencies);
}

async function fishBytes(): Promise<ArrayBuffer> {
  const bytes = await readFile(
    resolve('public', 'assets', 'fish', 'sunfin.glb'),
  );
  return Uint8Array.from(bytes).buffer;
}

async function parseFish() {
  const asset = await new GLTFLoader().parseAsync(await fishBytes(), '');
  asset.scene.traverse((node) => {
    if (!isSceneMesh(node)) return;
    track(node.geometry);
    for (const material of Array.isArray(node.material)
      ? node.material
      : [node.material]) {
      track(material);
    }
  });
  return asset;
}

async function localGlbCache(path = 'fish/sunfin.glb', base = '/reef-rush/') {
  const bytes = Uint8Array.from(
    await readFile(resolve('public', 'assets', ...path.split('/'))),
  ).buffer;
  class FixtureProgressEvent extends Event {
    constructor(
      type: string,
      readonly progress: ProgressEventInit,
    ) {
      super(type);
    }
  }
  vi.stubGlobal('ProgressEvent', FixtureProgressEvent);
  vi.stubGlobal(
    'Request',
    class extends Request {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(
          typeof input === 'string'
            ? new URL(input, 'https://reef-rush.test')
            : input,
          init,
        );
      }
    },
  );
  const fetch = vi.fn((request: Request) => {
    expect(request.url).toBe(`https://reef-rush.test${base}assets/${path}`);
    return Promise.resolve(new Response(bytes));
  });
  vi.stubGlobal('fetch', fetch);
  const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync');
  const cache = await createCache();
  return {
    cache,
    fetch,
    template: async () => {
      const result = load.mock.results[0];
      if (result?.type !== 'return') throw new Error('Missing real GLTF load');
      return await result.value;
    },
  };
}

function own(lease: AssetLease): AssetLease {
  owners.push(lease);
  return lease;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function syntheticAsset() {
  const geometry = track(new BufferGeometry());
  const texture = track(new Texture());
  const material = track(new MeshStandardMaterial({ map: texture }));
  const scene = new Group();
  scene.add(new Mesh(geometry, material));
  return { scene, animations: [], geometry, material, texture };
}

async function failureOf(promise: Promise<AssetLease>) {
  try {
    own(await promise);
  } catch (error) {
    if (error instanceof ConstructionCleanupError) owners.push(error);
    return error;
  }
  throw new Error('Expected acquisition to fail');
}

function isTexture(value: unknown): value is Texture {
  return value instanceof Texture;
}

function resourceSpies(asset: { scene: Group }) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  asset.scene.traverse((node) => {
    if (!isSceneMesh(node)) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material)
      ? node.material
      : [node.material]) {
      materials.add(material);
      const values: unknown[] = Object.values(material);
      for (const value of values) {
        if (isTexture(value)) textures.add(value);
      }
    }
  });
  return {
    counts: {
      geometries: geometries.size,
      materials: materials.size,
      textures: textures.size,
    },
    disposals: [...geometries, ...materials, ...textures].map((resource) =>
      vi.spyOn(resource, 'dispose'),
    ),
  };
}

describe('real committed fish', () => {
  it('parses the GLB with GLTFLoader and independently animates cloned fin targets', async () => {
    const { cache, template } = await localGlbCache();
    const first = own(await cache.acquire('fish/sunfin.glb'));
    const second = own(await cache.acquire('fish/sunfin.glb'));
    const asset = await template();
    expect(first.scene).toBe(first.root);
    expect(first.root).toBeInstanceOf(Group);
    expect(first.root).not.toBe(asset.scene);
    expect(second.root).not.toBe(first.root);
    first.root.position.set(1, 2, 3);
    first.root.rotation.set(0.1, 0.2, 0.3);
    first.root.scale.setScalar(2);
    expect(second.root.position.toArray()).toEqual([0, 0, 0]);
    expect(asset.scene.position.toArray()).toEqual([0, 0, 0]);
    expect(second.root.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(asset.scene.scale.toArray()).toEqual([1, 1, 1]);

    const clip = first.animations.find(
      (animation) => animation.name === 'swim',
    );
    expect(clip).toBeDefined();
    if (!clip) throw new Error('Committed fish must contain swim');
    expect(clip.tracks.length).toBeGreaterThan(0);
    expect(
      clip.tracks.every((track) => track.name.endsWith('.quaternion')),
    ).toBe(true);
    const targets = clip.tracks.map((track) => {
      const name = track.name.slice(0, -'.quaternion'.length);
      const template = asset.scene.getObjectByName(name);
      const a = first.root.getObjectByName(name);
      const b = second.root.getObjectByName(name);
      if (!template || !a || !b)
        throw new Error(`Missing animation node: ${name}`);
      expect(a).not.toBe(template);
      expect(a).not.toBe(b);
      return { template, a, b, initial: template.quaternion.clone() };
    });
    const firstMixer = new AnimationMixer(first.root);
    const secondMixer = new AnimationMixer(second.root);
    owners.push({
      dispose() {
        firstMixer.stopAllAction();
        firstMixer.uncacheRoot(first.root);
        secondMixer.stopAllAction();
        secondMixer.uncacheRoot(second.root);
      },
    });
    firstMixer.clipAction(clip).play();
    secondMixer.clipAction(clip).play();
    firstMixer.update(clip.duration * 0.25);
    expect(
      targets.some(({ a, initial }) => !a.quaternion.equals(initial)),
    ).toBe(true);
    for (const { template, b, initial } of targets) {
      expect(template.quaternion.equals(initial)).toBe(true);
      expect(b.quaternion.equals(initial)).toBe(true);
    }
    const firstPose = targets.map(({ a }) => a.quaternion.clone());
    secondMixer.update(clip.duration * 0.6);
    expect(targets.some(({ a, b }) => !a.quaternion.equals(b.quaternion))).toBe(
      true,
    );
    targets.forEach(({ template, a, initial }, index) => {
      expect(a.quaternion.equals(firstPose[index])).toBe(true);
      expect(template.quaternion.equals(initial)).toBe(true);
    });
    expect(Object.isFrozen(first.animations)).toBe(true);
  });

  it('borrows geometry and materials, then frees the template once at last release', async () => {
    const { cache, template } = await localGlbCache();
    const first = own(await cache.acquire('fish/sunfin.glb'));
    const second = own(await cache.acquire('fish/sunfin.glb'));
    const asset = await template();
    const { counts, disposals } = resourceSpies(asset);
    const scene = new Group();
    scene.add(first.root, second.root);
    first.root.traverse((node) => {
      if (!isSceneMesh(node)) return;
      const template = asset.scene.getObjectByName(node.name);
      if (!isSceneMesh(template)) throw new Error('Missing template mesh');
      expect(node.geometry).toBe(template.geometry);
      expect(node.material).toBe(template.material);
    });
    expect(first.getResourceCounts()).toEqual(counts);
    first.dispose();
    first.dispose();
    expect(first.disposed).toBe(true);
    expect(scene.children).toEqual([second.root]);
    for (const dispose of disposals) expect(dispose).not.toHaveBeenCalled();
    second.dispose();
    second.dispose();
    expect(scene.children).toHaveLength(0);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(cache.getDiagnostics()).toEqual({
      entries: 0,
      reservations: 0,
      geometries: 0,
      materials: 0,
      textures: 0,
    });
  });

  it('uses the actual default loader with a local response fixture and reloads after last release', async () => {
    const { cache, fetch } = await localGlbCache();
    const first = own(await cache.acquire('fish/sunfin.glb'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toBeDefined();
    expect(first.animations.map((clip) => clip.name)).toContain('swim');
    first.dispose();
    const second = own(await cache.acquire('fish/sunfin.glb'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(second.root).not.toBe(first.root);
    expect(second.getResourceCounts().geometries).toBeGreaterThan(0);
  });
});

describe('asset path contract', () => {
  it.each(['/reef-rush/', '/', '/preview/game'])(
    'uses assetUrl with base %s for assets-relative GLB paths',
    async (base) => {
      vi.stubEnv('BASE_URL', base);
      const prefix =
        base === '/' ? '/reef-rush/' : `${base.replace(/\/$/, '')}/`;
      const { cache, fetch } = await localGlbCache(
        'courses/sunlit-shoals.visual.glb',
        prefix,
      );
      own(await cache.acquire('courses/sunlit-shoals.visual.glb'));
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    '',
    '/fish/sunfin.glb',
    'assets/fish/sunfin.glb',
    '../fish/sunfin.glb',
    'fish/../sunfin.glb',
    'fish/./sunfin.glb',
    'fish//sunfin.glb',
    'fish\\sunfin.glb',
    'https://example.com/fish.glb',
    '//example.com/fish.glb',
    'data:model/gltf-binary;base64,AAAA',
    'fish/%2e%2e/sunfin.glb',
    'fish/sunfin.glb?version=1',
    'fish/sunfin.glb#scene',
    'fish/sunfin.gltf',
    'fish/sunfin.glb ',
    'fish/sunfin.glb\n',
    'fish/sunfin.glb\r',
    'fish/sunfin.glb\r\n',
    'fish/sunfin.glb\u2028',
    'fish/sunfin.glb\u2029',
    'fish/\u0000sunfin.glb',
  ])('rejects noncanonical/outside path %j without loading', async (path) => {
    const loadAsync = vi.fn();
    const cache = await createCache({ loader: { loadAsync } });
    await expect(cache.acquire(path)).rejects.toThrow(/asset path/i);
    expect(loadAsync).not.toHaveBeenCalled();
    expect(cache.getDiagnostics().entries).toBe(0);
  });
});

it('deduplicates shared geometries, material arrays and texture slots', async () => {
  const geometry = track(new BufferGeometry());
  const texture = track(new Texture());
  const firstMaterial = track(new MeshStandardMaterial({ map: texture }));
  firstMaterial.normalMap = texture;
  const secondMaterial = track(new MeshStandardMaterial({ map: texture }));
  const scene = new Group();
  scene.add(
    new Mesh(geometry, [firstMaterial, secondMaterial, firstMaterial]),
    new Mesh(geometry, firstMaterial),
  );
  const { counts, disposals } = resourceSpies({ scene });
  const cache = await createCache({
    loader: { loadAsync: () => Promise.resolve({ scene, animations: [] }) },
  });
  const lease = own(await cache.acquire('props/reef-kit.glb'));
  expect(counts).toEqual({ geometries: 1, materials: 2, textures: 1 });
  expect(lease.getResourceCounts()).toEqual(counts);
  lease.dispose();
  lease.dispose();
  for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
});

describe('in-flight ownership', () => {
  it('coalesces overlapping loads and reserves every pending consumer immediately', async () => {
    const asset = syntheticAsset();
    const pending = deferred<AssetTemplate>();
    const loadAsync = vi.fn(() => pending.promise);
    const cache = await createCache({ loader: { loadAsync } });
    const firstPending = cache.acquire('fish/sunfin.glb').then(own);
    const secondPending = cache.acquire('fish/sunfin.glb').then(own);
    const beforeLoad = cache.getDiagnostics();
    pending.resolve(asset);
    const [first, second] = await Promise.all([firstPending, secondPending]);
    expect(beforeLoad).toEqual({
      entries: 1,
      reservations: 2,
      geometries: 0,
      materials: 0,
      textures: 0,
    });
    expect(loadAsync).toHaveBeenCalledTimes(1);
    expect(first.root).not.toBe(second.root);
    expect(cache.getDiagnostics().reservations).toBe(2);
    first.dispose();
    second.dispose();
    expect(cache.getDiagnostics().entries).toBe(0);
  });

  it('does not free resources when an early consumer closes before its sibling receives the lease', async () => {
    const asset = syntheticAsset();
    const pending = deferred<AssetTemplate>();
    const { disposals } = resourceSpies(asset);
    const cache = await createCache({
      loader: { loadAsync: () => pending.promise },
    });
    const early = cache.acquire('fish/sunfin.glb').then((lease) => {
      own(lease).dispose();
      for (const dispose of disposals) expect(dispose).not.toHaveBeenCalled();
    });
    const later = cache.acquire('fish/sunfin.glb').then(own);
    pending.resolve(asset);
    await early;
    const lease = await later;
    expect(lease.getResourceCounts()).toEqual({
      geometries: 1,
      materials: 1,
      textures: 1,
    });
    lease.dispose();
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(cache.getDiagnostics().entries).toBe(0);
  });

  it('reserves a new ready-entry acquisition before the current lease can close', async () => {
    const asset = syntheticAsset();
    const { disposals } = resourceSpies(asset);
    const loadAsync = vi.fn(() => Promise.resolve(asset));
    const cache = await createCache({ loader: { loadAsync } });
    const first = own(await cache.acquire('fish/sunfin.glb'));
    const pending = cache.acquire('fish/sunfin.glb').then(own);
    first.dispose();
    for (const dispose of disposals) expect(dispose).not.toHaveBeenCalled();
    const second = await pending;
    second.dispose();
    expect(loadAsync).toHaveBeenCalledTimes(1);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('allows different paths to settle and close independently', async () => {
    const fish = syntheticAsset();
    const reef = syntheticAsset();
    const fishLoad = deferred<AssetTemplate>();
    const reefLoad = deferred<AssetTemplate>();
    const cache = await createCache({
      loader: {
        loadAsync: (url) =>
          url.endsWith('sunfin.glb') ? fishLoad.promise : reefLoad.promise,
      },
    });
    const fishPending = cache.acquire('fish/sunfin.glb').then(own);
    const reefPending = cache.acquire('props/reef-kit.glb').then(own);
    reefLoad.resolve(reef);
    const reefLease = await reefPending;
    reefLease.dispose();
    const whileFishLoads = cache.getDiagnostics();
    fishLoad.resolve(fish);
    const fishLease = await fishPending;
    expect(whileFishLoads.entries).toBe(1);
    expect(whileFishLoads.reservations).toBe(1);
    expect(fishLease.getResourceCounts().geometries).toBe(1);
    fishLease.dispose();
    expect(cache.getDiagnostics().entries).toBe(0);
  });

  it('evicts one rejected coalesced load, preserves its cause and permits retry', async () => {
    const pending = deferred<AssetTemplate>();
    const failure = new Error('GLB load failed');
    const asset = syntheticAsset();
    let retry = false;
    const loadAsync = vi.fn(() =>
      retry ? Promise.resolve(asset) : pending.promise,
    );
    const cache = await createCache({ loader: { loadAsync } });
    const first = failureOf(cache.acquire('fish/sunfin.glb'));
    const second = failureOf(cache.acquire('fish/sunfin.glb'));
    pending.reject(failure);
    expect(await first).toBe(failure);
    expect(await second).toBe(failure);
    expect(cache.getDiagnostics().entries).toBe(0);
    expect(cache.getDiagnostics().reservations).toBe(0);
    expect(loadAsync).toHaveBeenCalledTimes(1);
    retry = true;
    own(await cache.acquire('fish/sunfin.glb')).dispose();
    expect(loadAsync).toHaveBeenCalledTimes(2);
    expect(cache.getDiagnostics().entries).toBe(0);
  });

  it('evicts a synchronous loader throw without leaking a pending reservation', async () => {
    const failure = new Error('Loader setup failed');
    const asset = syntheticAsset();
    const loadAsync = vi
      .fn<(url: string) => Promise<AssetTemplate>>()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockResolvedValue(asset);
    const cache = await createCache({ loader: { loadAsync } });
    await expect(cache.acquire('fish/sunfin.glb')).rejects.toBe(failure);
    expect(cache.getDiagnostics().entries).toBe(0);
    own(await cache.acquire('fish/sunfin.glb')).dispose();
    expect(loadAsync).toHaveBeenCalledTimes(2);
  });
});

describe('construction rollback', () => {
  it.each([false, true])(
    'retains incomplete discovery and retries all resources exactly once (late disposal failure: %s)',
    async (lateFailure) => {
      const asset = syntheticAsset();
      const late = syntheticAsset();
      asset.scene.add(late.scene.children[0]);
      const { disposals } = resourceSpies(asset);
      const failure = new Error('Discovery stopped before the second mesh');
      const traversal = vi
        .spyOn(asset.scene, 'traverse')
        .mockImplementationOnce((visit) => {
          visit(asset.scene);
          asset.scene.children[0].traverse(visit);
          throw failure;
        });
      const cache = await createCache({
        loader: { loadAsync: () => Promise.resolve(asset) },
      });
      const first = failureOf(cache.acquire('fish/sunfin.glb'));
      const second = failureOf(cache.acquire('fish/sunfin.glb'));
      const error = await first;
      expect(error).toBeInstanceOf(ConstructionCleanupError);
      if (!(error instanceof ConstructionCleanupError)) throw error;
      expect(await second).toBe(error);
      expect(error.cause).toBe(failure);
      expect(traversal).toHaveBeenCalledTimes(1);
      expect(cache.getDiagnostics()).toMatchObject({
        entries: 1,
        reservations: 1,
      });
      await expect(cache.acquire('fish/sunfin.glb')).rejects.toThrow(
        /cleanup.*pending/i,
      );
      const lateMaterial = vi.spyOn(late.material, 'dispose');
      if (lateFailure) {
        lateMaterial.mockImplementationOnce(() => {
          throw new Error('Late material release failed');
        });
        expect(() => error.retryCleanup()).toThrow(error);
        expect(cache.getDiagnostics().entries).toBe(1);
      }
      error.retryCleanup();
      error.dispose();
      expect(cache.getDiagnostics()).toEqual({
        entries: 0,
        reservations: 0,
        geometries: 0,
        materials: 0,
        textures: 0,
      });
      for (const dispose of disposals) {
        expect(dispose).toHaveBeenCalledTimes(
          lateFailure && dispose === lateMaterial ? 2 : 1,
        );
      }
    },
  );

  it('retains one discovery cleanup owner for all waiting consumers even after all known releases succeed', async () => {
    const asset = syntheticAsset();
    const { disposals } = resourceSpies(asset);
    const failure = new Error('Template discovery failed');
    const traversal = vi
      .spyOn(asset.scene, 'traverse')
      .mockImplementationOnce((visit) => {
        Group.prototype.traverse.call(asset.scene, visit);
        throw failure;
      });
    const fresh = syntheticAsset();
    const loadAsync = vi
      .fn()
      .mockResolvedValueOnce(asset)
      .mockResolvedValueOnce(fresh);
    const cache = await createCache({ loader: { loadAsync } });
    const first = failureOf(cache.acquire('fish/sunfin.glb'));
    const second = failureOf(cache.acquire('fish/sunfin.glb'));
    const error = await first;
    expect(error).toBeInstanceOf(ConstructionCleanupError);
    if (!(error instanceof ConstructionCleanupError)) throw error;
    expect(await second).toBe(error);
    expect(error.cause).toBe(failure);
    expect(traversal).toHaveBeenCalledTimes(1);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(cache.getDiagnostics()).toEqual({
      entries: 1,
      reservations: 1,
      geometries: 0,
      materials: 0,
      textures: 0,
    });
    await expect(cache.acquire('fish/sunfin.glb')).rejects.toThrow(
      /cleanup.*pending/i,
    );
    expect(loadAsync).toHaveBeenCalledTimes(1);
    error.retryCleanup();
    error.dispose();
    expect(traversal).toHaveBeenCalledTimes(2);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(cache.getDiagnostics().entries).toBe(0);
    own(await cache.acquire('fish/sunfin.glb')).dispose();
    expect(loadAsync).toHaveBeenCalledTimes(2);
  });

  it('keeps the same owner through repeated discovery failures and releases newly visited resources', async () => {
    const asset = syntheticAsset();
    const late = syntheticAsset();
    asset.scene.add(late.scene.children[0]);
    const { disposals } = resourceSpies(asset);
    const firstFailure = new Error('First partial discovery failed');
    const retryFailure = new Error('Rediscovery failed after the second mesh');
    const releaseFailure = new Error('Newly visited material failed release');
    const traversal = vi
      .spyOn(asset.scene, 'traverse')
      .mockImplementationOnce((visit) => {
        asset.scene.children[0].traverse(visit);
        throw firstFailure;
      })
      .mockImplementationOnce((visit) => {
        Group.prototype.traverse.call(asset.scene, visit);
        throw retryFailure;
      });
    const lateMaterial = vi
      .spyOn(late.material, 'dispose')
      .mockImplementationOnce(() => {
        throw releaseFailure;
      });
    const cache = await createCache({
      loader: { loadAsync: () => Promise.resolve(asset) },
    });
    const error = await failureOf(cache.acquire('fish/sunfin.glb'));
    expect(error).toBeInstanceOf(ConstructionCleanupError);
    if (!(error instanceof ConstructionCleanupError)) throw error;
    expect(traversal).toHaveBeenCalledTimes(1);
    expect(lateMaterial).not.toHaveBeenCalled();
    expect(() => error.retryCleanup()).toThrow(error);
    expect(error.cause).toBe(firstFailure);
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        errors: [retryFailure, releaseFailure],
      }),
    );
    expect(traversal).toHaveBeenCalledTimes(2);
    expect(cache.getDiagnostics()).toEqual({
      entries: 1,
      reservations: 1,
      geometries: 0,
      materials: 1,
      textures: 0,
    });
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    await expect(cache.acquire('fish/sunfin.glb')).rejects.toThrow(
      /cleanup.*pending/i,
    );
    error.retryCleanup();
    error.dispose();
    expect(traversal).toHaveBeenCalledTimes(3);
    for (const dispose of disposals) {
      expect(dispose).toHaveBeenCalledTimes(dispose === lateMaterial ? 2 : 1);
    }
    expect(cache.getDiagnostics()).toEqual({
      entries: 0,
      reservations: 0,
      geometries: 0,
      materials: 0,
      textures: 0,
    });
  });

  it('retains a child discovery cleanup owner without retrying it in the initial catch', async () => {
    const asset = syntheticAsset();
    const { disposals } = resourceSpies(asset);
    const childRelease = vi.fn();
    const child = new ConstructionCleanupError(
      new Error('Discovery callback failed'),
      [new Error('Child rollback failed')],
      [childRelease],
      'Discovery child retained',
    );
    owners.push(child);
    const traversal = vi
      .spyOn(asset.scene, 'traverse')
      .mockImplementationOnce((visit) => {
        Group.prototype.traverse.call(asset.scene, visit);
        throw child;
      });
    const cache = await createCache({
      loader: { loadAsync: () => Promise.resolve(asset) },
    });
    const first = failureOf(cache.acquire('fish/sunfin.glb'));
    const second = failureOf(cache.acquire('fish/sunfin.glb'));
    const error = await first;
    expect(error).toBeInstanceOf(ConstructionCleanupError);
    if (!(error instanceof ConstructionCleanupError)) throw error;
    expect(error).not.toBe(child);
    expect(await second).toBe(error);
    expect(error.cause).toBe(child);
    expect(childRelease).not.toHaveBeenCalled();
    expect(traversal).toHaveBeenCalledTimes(1);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    childRelease.mockImplementationOnce(() => {
      throw new Error('Child still cannot release');
    });
    expect(() => error.retryCleanup()).toThrow(error);
    expect(childRelease).toHaveBeenCalledTimes(1);
    expect(error.errors).toContainEqual(
      expect.objectContaining({ errors: [child] }),
    );
    expect(cache.getDiagnostics()).toEqual({
      entries: 1,
      reservations: 1,
      geometries: 0,
      materials: 0,
      textures: 0,
    });
    await expect(cache.acquire('fish/sunfin.glb')).rejects.toThrow(
      /cleanup.*pending/i,
    );
    error.retryCleanup();
    error.dispose();
    expect(childRelease).toHaveBeenCalledTimes(2);
    expect(traversal).toHaveBeenCalledTimes(2);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(cache.getDiagnostics().entries).toBe(0);
  });

  it('retains each nested owner discovered by explicit retries until every child succeeds', async () => {
    const asset = syntheticAsset();
    const { disposals } = resourceSpies(asset);
    const failure = new Error('Initial discovery failed');
    const childReleases = [vi.fn(), vi.fn()];
    const children = childReleases.map((release) => {
      const child = new ConstructionCleanupError(
        new Error('Rediscovery callback failed'),
        [new Error('Child rollback failed')],
        [release],
        'Rediscovery child retained',
      );
      owners.push(child);
      return child;
    });
    const traversal = vi.spyOn(asset.scene, 'traverse');
    for (const cause of [failure, ...children]) {
      traversal.mockImplementationOnce((visit) => {
        Group.prototype.traverse.call(asset.scene, visit);
        throw cause;
      });
    }
    const materialDispose = vi
      .spyOn(asset.material, 'dispose')
      .mockImplementationOnce(() => {
        throw new Error('Initial known release failed');
      });
    const cache = await createCache({
      loader: { loadAsync: () => Promise.resolve(asset) },
    });
    const error = await failureOf(cache.acquire('fish/sunfin.glb'));
    expect(error).toBeInstanceOf(ConstructionCleanupError);
    if (!(error instanceof ConstructionCleanupError)) throw error;
    expect(error.cause).toBe(failure);
    expect(traversal).toHaveBeenCalledTimes(1);
    for (const release of childReleases) expect(release).not.toHaveBeenCalled();
    expect(() => error.retryCleanup()).toThrow(error);
    expect(traversal).toHaveBeenCalledTimes(2);
    for (const release of childReleases) expect(release).not.toHaveBeenCalled();
    childReleases[0].mockImplementationOnce(() => {
      throw new Error('First child release still fails');
    });
    expect(() => error.retryCleanup()).toThrow(error);
    expect(traversal).toHaveBeenCalledTimes(3);
    expect(childReleases[0]).toHaveBeenCalledTimes(1);
    expect(childReleases[1]).not.toHaveBeenCalled();
    childReleases[1].mockImplementationOnce(() => {
      throw new Error('Second child release still fails');
    });
    expect(() => error.retryCleanup()).toThrow(error);
    expect(traversal).toHaveBeenCalledTimes(4);
    expect(childReleases[0]).toHaveBeenCalledTimes(2);
    expect(childReleases[1]).toHaveBeenCalledTimes(1);
    expect(cache.getDiagnostics()).toEqual({
      entries: 1,
      reservations: 1,
      geometries: 0,
      materials: 0,
      textures: 0,
    });
    await expect(cache.acquire('fish/sunfin.glb')).rejects.toThrow(
      /cleanup.*pending/i,
    );
    error.retryCleanup();
    error.dispose();
    expect(traversal).toHaveBeenCalledTimes(4);
    for (const release of childReleases)
      expect(release).toHaveBeenCalledTimes(2);
    for (const dispose of disposals) {
      expect(dispose).toHaveBeenCalledTimes(
        dispose === materialDispose ? 2 : 1,
      );
    }
    expect(cache.getDiagnostics()).toEqual({
      entries: 0,
      reservations: 0,
      geometries: 0,
      materials: 0,
      textures: 0,
    });
  });

  it('transfers failed template discovery cleanup to one retry owner, not pending leases', async () => {
    const asset = syntheticAsset();
    const failure = new Error('Template discovery failed');
    vi.spyOn(asset.scene, 'traverse').mockImplementationOnce((visit) => {
      Group.prototype.traverse.call(asset.scene, visit);
      throw failure;
    });
    const materialDispose = vi
      .spyOn(asset.material, 'dispose')
      .mockImplementationOnce(() => {
        throw new Error('Template cleanup failed');
      });
    const cache = await createCache({
      loader: { loadAsync: () => Promise.resolve(asset) },
    });
    const first = failureOf(cache.acquire('fish/sunfin.glb'));
    const second = failureOf(cache.acquire('fish/sunfin.glb'));
    const error = await first;
    expect(error).toBeInstanceOf(ConstructionCleanupError);
    if (!(error instanceof ConstructionCleanupError)) throw error;
    expect(await second).toBe(error);
    expect(error.cause).toBe(failure);
    expect(cache.getDiagnostics().reservations).toBe(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    await expect(cache.acquire('fish/sunfin.glb')).rejects.toThrow(
      /cleanup.*pending/i,
    );
    error.retryCleanup();
    error.dispose();
    expect(materialDispose).toHaveBeenCalledTimes(2);
    expect(cache.getDiagnostics().entries).toBe(0);
  });

  it('releases a failed clone reservation and preserves the original failure', async () => {
    const asset = await parseFish();
    const { disposals } = resourceSpies(asset);
    const failure = new Error('Cannot clone fish');
    vi.spyOn(asset.scene, 'clone').mockImplementationOnce(() => {
      throw failure;
    });
    const fresh = syntheticAsset();
    const loadAsync = vi
      .fn()
      .mockResolvedValueOnce(asset)
      .mockResolvedValueOnce(fresh);
    const cache = await createCache({ loader: { loadAsync } });
    await expect(cache.acquire('fish/sunfin.glb')).rejects.toBe(failure);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(cache.getDiagnostics().entries).toBe(0);
    own(await cache.acquire('fish/sunfin.glb')).dispose();
    expect(loadAsync).toHaveBeenCalledTimes(2);
  });

  it('releases a failed clone without disposing a successful sibling', async () => {
    const asset = syntheticAsset();
    const { disposals } = resourceSpies(asset);
    const failure = new Error('Second clone failed');
    const cache = await createCache({
      loader: { loadAsync: () => Promise.resolve(asset) },
    });
    const first = own(await cache.acquire('fish/sunfin.glb'));
    vi.spyOn(asset.scene, 'clone').mockImplementationOnce(() => {
      throw failure;
    });
    await expect(cache.acquire('fish/sunfin.glb')).rejects.toBe(failure);
    expect(cache.getDiagnostics().reservations).toBe(1);
    for (const dispose of disposals) expect(dispose).not.toHaveBeenCalled();
    first.dispose();
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(cache.getDiagnostics().entries).toBe(0);
  });

  it('retains a ConstructionCleanupError when last-clone rollback leaves only a material', async () => {
    const asset = syntheticAsset();
    const cloneFailure = new Error('Clone failed');
    const materialFailure = new Error('Material release failed');
    vi.spyOn(asset.scene, 'clone').mockImplementationOnce(() => {
      throw cloneFailure;
    });
    const geometryDispose = vi.spyOn(asset.geometry, 'dispose');
    const textureDispose = vi.spyOn(asset.texture, 'dispose');
    const materialDispose = vi
      .spyOn(asset.material, 'dispose')
      .mockImplementationOnce(() => {
        throw materialFailure;
      })
      .mockImplementationOnce(() => {
        throw materialFailure;
      });
    const loadAsync = vi.fn(() => Promise.resolve(asset));
    const cache = await createCache({ loader: { loadAsync } });
    const error = await failureOf(cache.acquire('fish/sunfin.glb'));
    expect(error).toBeInstanceOf(ConstructionCleanupError);
    if (!(error instanceof ConstructionCleanupError)) throw error;
    expect(error.cause).toBe(cloneFailure);
    expect(error.errors).toEqual([
      cloneFailure,
      expect.objectContaining({ errors: [materialFailure] }),
    ]);
    expect(cache.getDiagnostics()).toEqual({
      entries: 1,
      reservations: 1,
      geometries: 0,
      materials: 1,
      textures: 0,
    });
    expect(materialDispose).toHaveBeenCalledTimes(1);
    await expect(cache.acquire('fish/sunfin.glb')).rejects.toThrow(
      /cleanup.*pending/i,
    );
    expect(loadAsync).toHaveBeenCalledTimes(1);
    expect(() => error.retryCleanup()).toThrow(error);
    expect(materialDispose).toHaveBeenCalledTimes(2);
    expect(error.errors).toHaveLength(3);
    expect(cache.getDiagnostics().entries).toBe(1);
    error.retryCleanup();
    error.dispose();
    expect(materialDispose).toHaveBeenCalledTimes(3);
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(1);
    expect(cache.getDiagnostics().entries).toBe(0);
  });

  it('does not silently retry a child construction cleanup in the clone catch', async () => {
    const asset = syntheticAsset();
    const childRelease = vi.fn();
    const child = new ConstructionCleanupError(
      new Error('Child allocation failed'),
      [new Error('Child cleanup failed')],
      [childRelease],
      'Child retained',
    );
    owners.push(child);
    vi.spyOn(asset.scene, 'clone').mockImplementationOnce(() => {
      throw child;
    });
    const materialDispose = vi
      .spyOn(asset.material, 'dispose')
      .mockImplementationOnce(() => {
        throw new Error('Template material release failed');
      });
    const cache = await createCache({
      loader: { loadAsync: () => Promise.resolve(asset) },
    });
    const error = await failureOf(cache.acquire('fish/sunfin.glb'));
    expect(error).toBeInstanceOf(ConstructionCleanupError);
    if (!(error instanceof ConstructionCleanupError)) throw error;
    expect(error).not.toBe(child);
    expect(error.cause).toBe(child);
    expect(childRelease).not.toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalledTimes(1);
    error.retryCleanup();
    error.dispose();
    expect(childRelease).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(2);
    expect(cache.getDiagnostics().entries).toBe(0);
  });

  it('preserves a rejected loader cleanup owner without retrying it', async () => {
    const childRelease = vi.fn();
    const child = new ConstructionCleanupError(
      new Error('Loader failed'),
      [new Error('Loader rollback failed')],
      [childRelease],
      'Loader retained',
    );
    const cache = await createCache({
      loader: { loadAsync: () => Promise.reject(child) },
    });
    expect(await failureOf(cache.acquire('fish/sunfin.glb'))).toBe(child);
    expect(childRelease).not.toHaveBeenCalled();
    expect(cache.getDiagnostics().entries).toBe(0);
    child.retryCleanup();
    expect(childRelease).toHaveBeenCalledTimes(1);
  });
});

describe('retryable disposal', () => {
  it.each(['geometry', 'material', 'texture'] as const)(
    'quarantines a failed final %s release until explicit retry, without blocking other paths',
    async (kind) => {
      const asset = syntheticAsset();
      const other = syntheticAsset();
      const fresh = syntheticAsset();
      const { disposals } = resourceSpies(asset);
      const cleanupFailure = new Error(`${kind} release failed`);
      const failedDispose = vi
        .spyOn(asset[kind], 'dispose')
        .mockImplementationOnce(() => {
          throw cleanupFailure;
        });
      const loadAsync = vi
        .fn()
        .mockResolvedValueOnce(asset)
        .mockResolvedValueOnce(other)
        .mockResolvedValueOnce(fresh);
      const cache = await createCache({ loader: { loadAsync } });
      const lease = own(await cache.acquire('fish/sunfin.glb'));
      const scene = new Group();
      scene.add(lease.root);
      expect(() => lease.dispose()).toThrow(
        expect.objectContaining({ errors: [cleanupFailure] }),
      );
      expect(scene.children).toHaveLength(0);
      expect(lease.disposed).toBe(false);
      const retained = cache.getDiagnostics();
      expect(retained.entries).toBe(1);
      expect(retained.reservations).toBe(1);
      expect(retained.geometries + retained.materials + retained.textures).toBe(
        1,
      );
      expect(failedDispose).toHaveBeenCalledTimes(1);
      await expect(cache.acquire('fish/sunfin.glb')).rejects.toThrow(
        /cleanup.*pending/i,
      );
      expect(loadAsync).toHaveBeenCalledTimes(1);
      own(await cache.acquire('props/reef-kit.glb')).dispose();
      expect(cache.getDiagnostics().entries).toBe(1);
      lease.dispose();
      lease.dispose();
      expect(lease.disposed).toBe(true);
      expect(failedDispose).toHaveBeenCalledTimes(2);
      for (const dispose of disposals) {
        if (dispose !== failedDispose) expect(dispose).toHaveBeenCalledTimes(1);
      }
      expect(cache.getDiagnostics().entries).toBe(0);
      own(await cache.acquire('fish/sunfin.glb')).dispose();
      expect(loadAsync).toHaveBeenCalledTimes(3);
      expect(cache.getDiagnostics().entries).toBe(0);
    },
  );

  it('retains every resource when removing the root throws, then retries detach first', async () => {
    const asset = syntheticAsset();
    const { disposals } = resourceSpies(asset);
    const cache = await createCache({
      loader: { loadAsync: () => Promise.resolve(asset) },
    });
    const lease = own(await cache.acquire('fish/sunfin.glb'));
    const scene = new Group();
    scene.add(lease.root);
    const failure = new Error('Detach blocked');
    vi.spyOn(scene, 'remove').mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => lease.dispose()).toThrow(failure);
    expect(lease.root.parent).toBe(scene);
    expect(lease.disposed).toBe(false);
    expect(cache.getDiagnostics().reservations).toBe(1);
    for (const dispose of disposals) expect(dispose).not.toHaveBeenCalled();
    lease.dispose();
    expect(lease.root.parent).toBeNull();
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(cache.getDiagnostics().entries).toBe(0);
  });

  it('does not free resources if a removal callback reattaches the root', async () => {
    const asset = syntheticAsset();
    const { disposals } = resourceSpies(asset);
    const cache = await createCache({
      loader: { loadAsync: () => Promise.resolve(asset) },
    });
    const lease = own(await cache.acquire('fish/sunfin.glb'));
    const scene = new Group();
    const otherScene = new Group();
    scene.add(lease.root);
    const reattach = () => otherScene.add(lease.root);
    lease.root.addEventListener('removed', reattach);
    try {
      expect(() => lease.dispose()).toThrow(/detach/i);
      expect(lease.root.parent).toBe(otherScene);
      expect(lease.disposed).toBe(false);
      for (const dispose of disposals) expect(dispose).not.toHaveBeenCalled();
    } finally {
      lease.root.removeEventListener('removed', reattach);
    }
    lease.dispose();
    expect(lease.root.parent).toBeNull();
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not decrement twice when a removed event reenters lease disposal', async () => {
    const asset = syntheticAsset();
    const { disposals } = resourceSpies(asset);
    const cache = await createCache({
      loader: { loadAsync: () => Promise.resolve(asset) },
    });
    const first = own(await cache.acquire('fish/sunfin.glb'));
    const second = own(await cache.acquire('fish/sunfin.glb'));
    const scene = new Group();
    scene.add(first.root, second.root);
    first.root.addEventListener('removed', () => first.dispose());
    first.dispose();
    expect(cache.getDiagnostics().reservations).toBe(1);
    expect(second.root.parent).toBe(scene);
    for (const dispose of disposals) expect(dispose).not.toHaveBeenCalled();
    second.dispose();
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(cache.getDiagnostics().entries).toBe(0);
  });

  it('blocks reentrant acquisition and disposal during final GPU release', async () => {
    const asset = syntheticAsset();
    const { disposals } = resourceSpies(asset);
    const loadAsync = vi.fn(() => Promise.resolve(asset));
    const cache = await createCache({ loader: { loadAsync } });
    const lease = own(await cache.acquire('fish/sunfin.glb'));
    let pending: Promise<unknown> | undefined;
    asset.material.addEventListener('dispose', () => {
      lease.dispose();
      pending = failureOf(cache.acquire('fish/sunfin.glb'));
    });
    lease.dispose();
    const failure = await pending;
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw failure;
    expect(failure.message).toMatch(/cleanup.*pending/i);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(loadAsync).toHaveBeenCalledTimes(1);
    expect(cache.getDiagnostics().entries).toBe(0);
  });
});
