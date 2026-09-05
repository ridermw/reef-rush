import {
  BufferGeometry,
  Group,
  Material,
  Mesh,
  Texture,
  type AnimationClip,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl } from '../../config/assetUrl';
import {
  ConstructionCleanupError,
  releaseResources,
  rollbackConstruction,
} from '../core/resourceCleanup';

export interface AssetTemplate {
  readonly scene: Group;
  readonly animations: readonly AnimationClip[];
}

export interface AssetLoader {
  loadAsync(url: string): Promise<AssetTemplate>;
}

export interface AssetCacheDependencies {
  readonly loader?: AssetLoader;
}

export interface AssetResourceCounts {
  readonly geometries: number;
  readonly materials: number;
  readonly textures: number;
}

export interface AssetLease {
  readonly root: Group;
  readonly scene: Group;
  readonly animations: readonly AnimationClip[];
  readonly disposed: boolean;
  /** Counts shared resources still owned by the entry, not per-instance copies. */
  getResourceCounts(): AssetResourceCounts;
  /** Synchronous and idempotent after success; retain this lease on failure. */
  dispose(): void;
}

export interface AssetCache {
  acquire(path: string): Promise<AssetLease>;
  getDiagnostics(): AssetResourceCounts &
    Readonly<{ entries: number; reservations: number }>;
}

function isAssetMesh(
  node: Object3D,
): node is Mesh<BufferGeometry, Material | Material[]> {
  return node instanceof Mesh;
}

function createResourceOwner() {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const registered = new WeakSet<BufferGeometry | Material | Texture>();
  const releases: Array<() => void> = [];

  function own<T extends BufferGeometry | Material | Texture>(
    resource: T,
    resources: Set<T>,
  ) {
    // Rediscovery must not revive resources already released by partial cleanup.
    if (registered.has(resource)) return;
    registered.add(resource);
    resources.add(resource);
    releases.push(() => {
      resource.dispose();
      resources.delete(resource);
    });
  }

  return {
    collect(scene: Group) {
      scene.traverse((node) => {
        if (!isAssetMesh(node)) return;
        own(node.geometry, geometries);
        for (const material of Array.isArray(node.material)
          ? node.material
          : [node.material]) {
          own(material, materials);
          const values: unknown[] = Object.values(material);
          for (const value of values) {
            if (value instanceof Texture) own(value, textures);
          }
        }
      });
    },
    releases,
    getCounts: (): AssetResourceCounts => ({
      geometries: geometries.size,
      materials: materials.size,
      textures: textures.size,
    }),
  };
}

interface Entry {
  readonly loaded: Promise<AssetTemplate>;
  readonly resources: ReturnType<typeof createResourceOwner>;
  reservations: number;
  closing: boolean;
}

function resolveAssetPath(path: string): string {
  if (
    !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.glb$/.test(
      path,
    ) ||
    path.startsWith('assets/')
  ) {
    throw new Error(`Invalid asset path: ${path}`);
  }
  return assetUrl(`assets/${path}`);
}

/**
 * Paths are canonical, case-sensitive GLB paths relative to public/assets:
 * "fish/sunfin.glb", not "/assets/fish/sunfin.glb". Directories use ASCII
 * letters, digits, "_" or "-"; filenames also permit dot-separated suffixes.
 * No URLs, escapes, traversal, queries, fragments or "assets/" prefix.
 *
 * Leases own cloned nodes, not GPU resources. Geometry, materials, textures
 * and animation clips are borrowed immutable; callers own their mixers and
 * must stop/uncache them before disposing the lease. Do not reuse closed roots.
 * Supports the original unskinned, untextured, mesh-based GLBs (plus ordinary
 * material texture slots). The injected loader transfers template ownership.
 *
 * Every acquire promise must be observed and its lease eventually disposed.
 * There is no idle retention or cache-wide disposal. On failed final disposal,
 * only retry the owning lease; that path rejects acquisitions until cleanup
 * succeeds. Failed construction can instead throw ConstructionCleanupError:
 * retain it and explicitly retryCleanup()/dispose() until cleanup succeeds.
 * Import this module only from the lazy scene dependency graph.
 */
export function createAssetCache(
  dependencies: AssetCacheDependencies = {},
): AssetCache {
  const loader = dependencies.loader ?? new GLTFLoader();
  const entries = new Map<string, Entry>();

  function disposeEntry(path: string, entry: Entry, errors: unknown[] = []) {
    entry.closing = true;
    errors.push(...releaseResources(entry.resources.releases));
    if (errors.length > 0) {
      throw new AggregateError(errors, `Asset cleanup failed: ${path}`);
    }
    entry.reservations = 0;
    entries.delete(path);
  }

  function rollbackTemplate(
    path: string,
    entry: Entry,
    asset: AssetTemplate,
    cause: unknown,
  ): never {
    // Incomplete discovery owns the template even if all known releases succeed.
    entry.closing = true;
    entry.reservations = 1;
    const children = new Set<ConstructionCleanupError>();
    if (cause instanceof ConstructionCleanupError) children.add(cause);
    const cleanupErrors = releaseResources(entry.resources.releases);
    let discoveryComplete = false;

    function retryCleanup() {
      const errors: unknown[] = [];
      for (const child of children) {
        try {
          child.retryCleanup();
          children.delete(child);
        } catch (error) {
          errors.push(error);
        }
      }
      if (!discoveryComplete) {
        try {
          entry.resources.collect(asset.scene);
          discoveryComplete = true;
        } catch (error) {
          errors.push(error);
          // A newly discovered owner is only retried on the next explicit call.
          if (error instanceof ConstructionCleanupError) children.add(error);
        }
      }
      disposeEntry(path, entry, errors);
    }

    throw new ConstructionCleanupError(
      cause,
      cleanupErrors,
      [retryCleanup],
      `Asset template construction failed: ${path}`,
    );
  }

  function startEntry(path: string, url: string): Entry {
    const resources = createResourceOwner();
    const entry: Entry = {
      resources,
      reservations: 0,
      closing: false,
      loaded: Promise.resolve()
        .then(() => loader.loadAsync(url))
        .then(
          (asset) => {
            try {
              resources.collect(asset.scene);
              return asset;
            } catch (cause) {
              // Every waiter rejects with the same error; one cleanup owner
              // replaces their reservations if template setup cannot finish.
              rollbackTemplate(path, entry, asset, cause);
            }
          },
          (cause: unknown) => {
            entry.reservations = 0;
            entries.delete(path);
            throw cause;
          },
        ),
    };
    entries.set(path, entry);
    return entry;
  }

  return {
    async acquire(path) {
      const url = resolveAssetPath(path);
      const entry = entries.get(path) ?? startEntry(path, url);
      if (entry.closing) {
        throw new Error(
          `Asset cleanup pending; retry its owner first: ${path}`,
        );
      }
      // Reserve before awaiting even an already-resolved load: an earlier
      // consumer may close while this acquisition is still in a microtask.
      entry.reservations += 1;
      const asset = await entry.loaded;
      let root: Group | undefined;
      let disposed = false;
      let disposing = false;

      function dispose() {
        if (disposed || disposing) return;
        disposing = true;
        try {
          if (entry.reservations === 1) entry.closing = true;
          root?.removeFromParent();
          if (root?.parent) {
            throw new Error(`Cannot detach asset scene: ${path}`);
          }
          if (entry.reservations === 1) {
            disposeEntry(path, entry);
          } else {
            entry.reservations -= 1;
          }
          disposed = true;
        } finally {
          disposing = false;
        }
      }

      try {
        root = asset.scene.clone(true);
        const animations = Object.freeze([...asset.animations]);
        return {
          root,
          scene: root,
          animations,
          get disposed() {
            return disposed;
          },
          getResourceCounts: entry.resources.getCounts,
          dispose,
        };
      } catch (cause) {
        rollbackConstruction(
          cause,
          [dispose],
          `Asset construction failed: ${path}`,
        );
      }
    },
    getDiagnostics() {
      let reservations = 0;
      let geometries = 0;
      let materials = 0;
      let textures = 0;
      for (const entry of entries.values()) {
        reservations += entry.reservations;
        const counts = entry.resources.getCounts();
        geometries += counts.geometries;
        materials += counts.materials;
        textures += counts.textures;
      }
      return {
        entries: entries.size,
        reservations,
        geometries,
        materials,
        textures,
      };
    },
  };
}
