import * as RAPIER from '@dimforge/rapier3d';
import {
  clearTrackedColliders,
  initTrackedColliders,
  registerTrackedCollider,
} from './trackedColliders';

type RapierModule = typeof import('@dimforge/rapier3d') & {
  init?: () => Promise<void> | void;
};

export interface PhysicsRuntime {
  world: RAPIER.World;
  eventQueue: RAPIER.EventQueue;
  dispose(): void;
}

async function initRapier(module: RapierModule): Promise<void> {
  if (module.init) {
    await module.init();
  }
}

export async function createPhysicsRuntime(): Promise<PhysicsRuntime> {
  await initRapier(RAPIER);

  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const eventQueue = new RAPIER.EventQueue(true);
  let disposed = false;
  initTrackedColliders(world);

  const createCollider = world.createCollider.bind(world);
  const createTrackedCollider: typeof world.createCollider = (desc, parent) => {
    const collider = createCollider(desc, parent);
    registerTrackedCollider(world, collider, desc);
    return collider;
  };
  world.createCollider = createTrackedCollider;

  return {
    world,
    eventQueue,
    dispose(): void {
      if (disposed) {
        return;
      }

      disposed = true;
      clearTrackedColliders(world);
      eventQueue.free();
      world.free();
    },
  };
}
