import * as RAPIER from '@dimforge/rapier3d-compat';

let initialization: Promise<void> | undefined;

export interface PhysicsRuntime {
  world: RAPIER.World;
  eventQueue: RAPIER.EventQueue;
  dispose(): void;
}

export async function createPhysicsRuntime(): Promise<PhysicsRuntime> {
  await (initialization ??= RAPIER.init());

  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const eventQueue = new RAPIER.EventQueue(true);
  let disposed = false;

  return {
    world,
    eventQueue,
    dispose(): void {
      if (disposed) {
        return;
      }

      disposed = true;
      eventQueue.free();
      world.free();
    },
  };
}
