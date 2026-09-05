import * as RAPIER from '@dimforge/rapier3d-compat';
import { releaseResources } from '../core/resourceCleanup';

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
  const releases = [() => world.free(), () => eventQueue.free()];

  return {
    world,
    eventQueue,
    dispose(): void {
      const errors = releaseResources(releases);
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Physics resource cleanup failed.');
      }
    },
  };
}
