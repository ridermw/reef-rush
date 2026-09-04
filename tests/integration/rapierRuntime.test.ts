import * as RAPIER from '@dimforge/rapier3d-compat';
import { expect, it } from 'vitest';
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
