import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Object3D } from 'three';
import { vi } from 'vitest';
import type { AssetLoader } from '../../src/game/assets/AssetCache';

export const visualAsset = 'courses/sunlit-shoals.visual.glb';
export const collisionAsset = 'courses/sunlit-shoals.collision.glb';
export const fishAsset = 'fish/sunfin.glb';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function originalMetadata(node: Object3D): Record<string, unknown> {
  const value: unknown = node.userData.reefRush;
  if (!isRecord(value)) throw new Error(`Missing metadata: ${node.name}`);
  return value;
}

export async function originalBytes(path: string): Promise<ArrayBuffer> {
  return Uint8Array.from(
    await readFile(resolve('public', 'assets', ...path.split('/'))),
  ).buffer;
}

export const localAssetLoader: AssetLoader = {
  async loadAsync(url) {
    const prefix = '/reef-rush/assets/';
    if (!url.startsWith(prefix))
      throw new Error(`Unexpected asset URL: ${url}`);
    return new GLTFLoader().parseAsync(
      await originalBytes(url.slice(prefix.length)),
      '',
    );
  },
};

/** Real loadAsync and parser, with only the transport replaced by committed bytes. */
export function stubOriginalAssetFetch() {
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
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    const prefix = '/reef-rush/assets/';
    if (
      url.origin !== 'https://reef-rush.test' ||
      !url.pathname.startsWith(prefix)
    )
      throw new Error(`Unexpected asset request: ${url}`);
    return new Response(await originalBytes(url.pathname.slice(prefix.length)));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
