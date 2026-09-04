import type { Collider, Rotation, Vector } from '@dimforge/rapier3d-compat';
import {
  PLAYER_MOVEMENT_QUERY_GROUPS,
  doCollisionGroupsInteract,
} from './collisionGroups';
import type { PhysicsRuntime } from './createPhysicsRuntime';

const EPSILON = 1e-6;
const SAFE_IMPACT_DISTANCE = 1e-3;
const ZERO_VELOCITY = { x: 0, y: 0, z: 0 };

export const MAX_FISH_SLIDE_ITERATIONS = 3;

type Vec3 = [number, number, number];

export interface FishCollisionResult {
  position: Vec3;
  velocity: Vec3;
  contacts: Array<{ colliderHandle: number; normal: Vec3 }>;
}

function add([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 {
  return [ax + bx, ay + by, az + bz];
}

function subtract([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 {
  return [ax - bx, ay - by, az - bz];
}

function scale([x, y, z]: Vec3, factor: number): Vec3 {
  return [x * factor, y * factor, z * factor];
}

function dot([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): number {
  return ax * bx + ay * by + az * bz;
}

function length(vector: Vec3): number {
  return Math.hypot(...vector);
}

function projectAlongPlane(vector: Vec3, normal: Vec3): Vec3 {
  const inward = Math.min(0, dot(vector, normal));
  return subtract(vector, scale(normal, inward));
}

function asRapierVector([x, y, z]: Vec3): Vector {
  return { x, y, z };
}

function asTuple({ x, y, z }: Vector): Vec3 {
  return [x, y, z];
}

function worldNormal(normal: Vector, rotation: Rotation): Vec3 {
  // Shape casts report each normal in that shape's local coordinates.
  const tx = 2 * (rotation.y * normal.z - rotation.z * normal.y);
  const ty = 2 * (rotation.z * normal.x - rotation.x * normal.z);
  const tz = 2 * (rotation.x * normal.y - rotation.y * normal.x);
  const rotated: Vec3 = [
    normal.x + rotation.w * tx + rotation.y * tz - rotation.z * ty,
    normal.y + rotation.w * ty + rotation.z * tx - rotation.x * tz,
    normal.z + rotation.w * tz + rotation.x * ty - rotation.y * tx,
  ];
  const magnitude = length(rotated);
  if (magnitude <= EPSILON) {
    throw new Error('Rapier shape cast returned an invalid contact normal.');
  }
  return scale(rotated, 1 / magnitude);
}

export function syncFishColliderPosition(
  runtime: PhysicsRuntime,
  collider: Collider,
  position: Vec3,
): void {
  runtime.world.propagateModifiedBodyPositionsToColliders();
  const parent = collider.parent();
  if (parent) {
    const delta = subtract(position, asTuple(collider.translation()));
    parent.setTranslation(
      asRapierVector(add(asTuple(parent.translation()), delta)),
      false,
    );
    runtime.world.propagateModifiedBodyPositionsToColliders();
  } else {
    collider.setTranslation(asRapierVector(position));
  }
}

function writeColliderVelocity(collider: Collider, velocity: Vec3): void {
  collider.parent()?.setLinvel(asRapierVector(velocity), false);
}

export function moveFish(
  runtime: PhysicsRuntime,
  collider: Collider,
  desiredDelta: Vec3,
  velocity: Vec3,
  dt: number,
): FishCollisionResult {
  runtime.world.propagateModifiedBodyPositionsToColliders();
  let position = asTuple(collider.translation());
  let correctedVelocity: Vec3 = [...velocity];
  const contacts: FishCollisionResult['contacts'] = [];
  const stepSeconds = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  let remainingDelta: Vec3 = stepSeconds > 0 ? [...desiredDelta] : [0, 0, 0];
  const shape = collider.shape;
  const rotation = collider.rotation();
  const candidates = runtime.world.colliders
    .getAll()
    .filter(
      (candidate) =>
        candidate !== collider &&
        candidate.isEnabled() &&
        candidate.parent()?.isEnabled() !== false &&
        !candidate.isSensor() &&
        doCollisionGroupsInteract(
          PLAYER_MOVEMENT_QUERY_GROUPS,
          candidate.collisionGroups(),
        ),
    );

  for (
    let iteration = 0;
    iteration < MAX_FISH_SLIDE_ITERATIONS && length(remainingDelta) > EPSILON;
    iteration += 1
  ) {
    let closestHit: {
      colliderHandle: number;
      normal: Vec3;
      timeOfImpact: number;
    } | null = null;

    for (const candidate of candidates) {
      const candidateRotation = candidate.rotation();
      // Pairwise casts use current transforms, even before the world's next step.
      const hit = shape.castShape(
        asRapierVector(position),
        rotation,
        asRapierVector(remainingDelta),
        candidate.shape,
        candidate.translation(),
        candidateRotation,
        ZERO_VELOCITY,
        SAFE_IMPACT_DISTANCE,
        1,
        false,
      );
      if (!hit) continue;

      const impactPosition = add(
        position,
        scale(remainingDelta, hit.time_of_impact),
      );
      // Refine the cast's approximate GJK normal with the actual contact plane.
      const contact = shape.contactShape(
        asRapierVector(impactPosition),
        rotation,
        candidate.shape,
        candidate.translation(),
        candidateRotation,
        SAFE_IMPACT_DISTANCE * 2,
      );
      const normal = contact
        ? asTuple(contact.normal2)
        : worldNormal(hit.normal2, candidateRotation);
      if (dot(remainingDelta, normal) >= -EPSILON) continue;

      if (!closestHit || hit.time_of_impact < closestHit.timeOfImpact) {
        closestHit = {
          colliderHandle: candidate.handle,
          normal,
          timeOfImpact: hit.time_of_impact,
        };
      }
    }

    if (!closestHit) {
      position = add(position, remainingDelta);
      break;
    }

    const fraction = Math.max(0, Math.min(1, closestHit.timeOfImpact));
    position = add(position, scale(remainingDelta, fraction));
    remainingDelta = projectAlongPlane(
      scale(remainingDelta, 1 - fraction),
      closestHit.normal,
    );
    correctedVelocity = projectAlongPlane(correctedVelocity, closestHit.normal);
    if (
      !contacts.some(
        (contact) => contact.colliderHandle === closestHit.colliderHandle,
      )
    ) {
      contacts.push({
        colliderHandle: closestHit.colliderHandle,
        normal: closestHit.normal,
      });
    }
  }

  syncFishColliderPosition(runtime, collider, position);
  writeColliderVelocity(collider, correctedVelocity);
  return { position, velocity: correctedVelocity, contacts };
}
