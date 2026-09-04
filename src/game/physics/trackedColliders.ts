import type {
  Collider,
  ColliderDesc,
  Rotation,
  Shape,
  World,
} from '@dimforge/rapier3d';
import {
  getGameplayCollisionKind,
  type GameplayCollisionKind,
} from './collisionGroups';

type Vec3 = [number, number, number];

export interface TrackedCollider {
  collider: Collider;
  handle: number;
  groups: number;
  kind: GameplayCollisionKind | null;
  isSensor: boolean;
  position: Vec3;
  rotation: Rotation;
  shape: Shape;
}

const collidersByWorld = new WeakMap<World, Map<number, TrackedCollider>>();
const trackedByCollider = new WeakMap<Collider, TrackedCollider>();

function clonePosition({ x, y, z }: { x: number; y: number; z: number }): Vec3 {
  return [x, y, z];
}

function cloneRotation(rotation: Rotation): Rotation {
  return {
    x: rotation.x,
    y: rotation.y,
    z: rotation.z,
    w: rotation.w,
  };
}

export function initTrackedColliders(world: World): void {
  collidersByWorld.set(world, new Map());
}

export function clearTrackedColliders(world: World): void {
  const colliders = collidersByWorld.get(world);
  if (!colliders) {
    return;
  }

  for (const trackedCollider of colliders.values()) {
    trackedByCollider.delete(trackedCollider.collider);
  }

  colliders.clear();
  collidersByWorld.delete(world);
}

export function registerTrackedCollider(
  world: World,
  collider: Collider,
  desc: ColliderDesc,
): void {
  const trackedCollider: TrackedCollider = {
    collider,
    handle: collider.handle,
    groups: desc.collisionGroups,
    kind: getGameplayCollisionKind(desc.collisionGroups),
    isSensor: desc.isSensor,
    position: clonePosition(desc.translation),
    rotation: cloneRotation(desc.rotation),
    shape: desc.shape,
  };

  const trackedColliders = collidersByWorld.get(world);
  if (!trackedColliders) {
    throw new Error('Tracked colliders were not initialized for this world.');
  }

  trackedColliders.set(collider.handle, trackedCollider);
  trackedByCollider.set(collider, trackedCollider);
}

export function listTrackedColliders(world: World): TrackedCollider[] {
  return [...(collidersByWorld.get(world)?.values() ?? [])];
}

export function getTrackedCollider(collider: Collider): TrackedCollider | null {
  return trackedByCollider.get(collider) ?? null;
}

export function updateTrackedColliderPosition(
  collider: Collider,
  position: Vec3,
): void {
  const trackedCollider = trackedByCollider.get(collider);
  if (!trackedCollider) {
    return;
  }

  trackedCollider.position = [...position];
}
