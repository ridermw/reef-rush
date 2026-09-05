import * as RAPIER from '@dimforge/rapier3d-compat';
import { expect, it, vi } from 'vitest';
import { createPhysicsRuntime } from '../../src/game/physics/createPhysicsRuntime';

it('shares one initialized WASM binding for live geometry reads', async () => {
  const runtime = await createPhysicsRuntime();
  try {
    const collider = runtime.world.createCollider(
      RAPIER.ColliderDesc.ball(0.5).setTranslation(2, 3, 4),
    );
    expect(collider.translation()).toMatchObject({ x: 2, y: 3, z: 4 });
    expect(collider.rotation()).toMatchObject({ x: 0, y: 0, z: 0, w: 1 });
  } finally {
    runtime.dispose();
  }
});

it.each(['world', 'eventQueue'] as const)(
  'retries failed %s release without leaking or double-freeing the other resource',
  async (resource) => {
    const runtime = await createPhysicsRuntime();
    const worldFree = vi.spyOn(runtime.world, 'free');
    const queueFree = vi.spyOn(runtime.eventQueue, 'free');
    const failure = new Error('Injected free failure');
    const failing = resource === 'world' ? worldFree : queueFree;
    failing.mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() => runtime.dispose()).toThrow();
      expect(worldFree).toHaveBeenCalledTimes(1);
      expect(queueFree).toHaveBeenCalledTimes(1);
      runtime.dispose();
      runtime.dispose();
      expect(failing).toHaveBeenCalledTimes(2);
      expect(
        resource === 'world' ? queueFree : worldFree,
      ).toHaveBeenCalledTimes(1);
    } finally {
      worldFree.mockRestore();
      queueFree.mockRestore();
      runtime.dispose();
    }
  },
);
