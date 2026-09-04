import type { Collider, Rotation } from '@dimforge/rapier3d';
import {
  PLAYER_MOVEMENT_QUERY_GROUPS,
  doCollisionGroupsInteract,
} from './collisionGroups';
import type { PhysicsRuntime } from './createPhysicsRuntime';
import {
  getTrackedCollider,
  listTrackedColliders,
  type TrackedCollider,
  updateTrackedColliderPosition,
} from './trackedColliders';

const EPSILON = 1e-6;
const SAFE_IMPACT_DISTANCE = 1e-3;
const IDENTITY_ROTATION: Rotation = { x: 0, y: 0, z: 0, w: 1 };
const SWEEP_SAMPLES = 32;

export const MAX_FISH_SLIDE_ITERATIONS = 3;

type Vec3 = [number, number, number];

export interface FishCollisionResult {
  position: Vec3;
  velocity: Vec3;
  contacts: Array<{ colliderHandle: number; normal: Vec3 }>;
}

function cloneVector([x, y, z]: Vec3): Vec3 {
  return [x, y, z];
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
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalize(vector: Vec3): Vec3 {
  const magnitude = length(vector);
  if (magnitude <= EPSILON) {
    return [0, 0, 0];
  }

  return scale(vector, 1 / magnitude);
}

function projectAlongPlane(vector: Vec3, normal: Vec3): Vec3 {
  const normalVelocity = dot(vector, normal);
  if (normalVelocity >= 0) {
    return vector;
  }

  return subtract(vector, scale(normal, normalVelocity));
}

function asRapierVector([x, y, z]: Vec3): { x: number; y: number; z: number } {
  return { x, y, z };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerpPosition(start: Vec3, delta: Vec3, amount: number): Vec3 {
  return add(start, scale(delta, amount));
}

function estimateContactNormal(
  impactPosition: Vec3,
  candidate: TrackedCollider,
  fallbackNormal: Vec3,
): Vec3 {
  const shape = candidate.shape as {
    halfExtents?: { x: number; y: number; z: number };
    radius?: number;
  };

  if (shape.halfExtents) {
    const localX = impactPosition[0] - candidate.position[0];
    const localY = impactPosition[1] - candidate.position[1];
    const localZ = impactPosition[2] - candidate.position[2];
    const closestPoint: Vec3 = [
      clamp(localX, -shape.halfExtents.x, shape.halfExtents.x),
      clamp(localY, -shape.halfExtents.y, shape.halfExtents.y),
      clamp(localZ, -shape.halfExtents.z, shape.halfExtents.z),
    ];

    return normalize([
      localX - closestPoint[0],
      localY - closestPoint[1],
      localZ - closestPoint[2],
    ]);
  }

  if (typeof shape.radius === 'number') {
    return normalize(subtract(impactPosition, candidate.position));
  }

  return fallbackNormal;
}

function overlapsAt(
  shape: TrackedCollider['shape'],
  position: Vec3,
  rotation: Rotation,
  candidate: TrackedCollider,
): boolean {
  return shape.intersectsShape(
    asRapierVector(position),
    rotation,
    candidate.shape,
    asRapierVector(candidate.position),
    candidate.rotation,
  );
}

export function syncFishColliderPosition(
  collider: Collider,
  position: Vec3,
): void {
  updateTrackedColliderPosition(collider, cloneVector(position));
  const parent = collider.parent();
  if (parent) {
    parent.setTranslation(asRapierVector(position), false);
    return;
  }

  collider.setTranslation(asRapierVector(position));
}

function writeColliderVelocity(collider: Collider, velocity: Vec3): void {
  const parent = collider.parent();
  if (!parent) {
    return;
  }

  parent.setLinvel(asRapierVector(velocity), false);
}

function appendContact(
  contacts: FishCollisionResult['contacts'],
  colliderHandle: number,
  normal: Vec3,
): void {
  if (contacts.some((contact) => contact.colliderHandle === colliderHandle)) {
    return;
  }

  contacts.push({ colliderHandle, normal });
}

export function moveFish(
  runtime: PhysicsRuntime,
  collider: Collider,
  desiredDelta: Vec3,
  velocity: Vec3,
  dt: number,
): FishCollisionResult {
  const correctedVelocity = cloneVector(velocity);
  const contacts: FishCollisionResult['contacts'] = [];
  const stepSeconds = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  const trackedCollider = getTrackedCollider(collider);
  const rotation = trackedCollider?.rotation ?? IDENTITY_ROTATION;
  const shape = trackedCollider?.shape ?? collider.shape;
  const position = cloneVector(trackedCollider?.position ?? [0, 0, 0]);

  if (stepSeconds === 0 || length(desiredDelta) <= EPSILON) {
    syncFishColliderPosition(collider, position);
    writeColliderVelocity(collider, correctedVelocity);
    return {
      position,
      velocity: correctedVelocity,
      contacts,
    };
  }

  let nextPosition = cloneVector(position);
  let remainingTime = stepSeconds;
  let remainingDelta = cloneVector(desiredDelta);

  for (
    let iteration = 0;
    iteration < MAX_FISH_SLIDE_ITERATIONS && remainingTime > EPSILON;
    iteration += 1
  ) {
    if (length(remainingDelta) <= EPSILON) {
      break;
    }

    let closestHit: {
      colliderHandle: number;
      normal: Vec3;
      timeOfImpact: number;
    } | null = null;

    for (const candidate of listTrackedColliders(runtime.world)) {
      if (candidate.collider === collider || candidate.isSensor) {
        continue;
      }

      if (
        !doCollisionGroupsInteract(
          PLAYER_MOVEMENT_QUERY_GROUPS,
          candidate.groups,
        )
      ) {
        continue;
      }

      let impactTime = 0;
      let impactFound = overlapsAt(shape, nextPosition, rotation, candidate);

      if (!impactFound) {
        let bracketStart = 0;
        let bracketEnd = 0;

        for (let sample = 1; sample <= SWEEP_SAMPLES; sample += 1) {
          const nextSample = sample / SWEEP_SAMPLES;
          const samplePosition = lerpPosition(
            nextPosition,
            remainingDelta,
            nextSample,
          );

          if (overlapsAt(shape, samplePosition, rotation, candidate)) {
            bracketStart = (sample - 1) / SWEEP_SAMPLES;
            bracketEnd = nextSample;
            impactFound = true;
            break;
          }
        }

        if (!impactFound) {
          continue;
        }

        for (let iterationStep = 0; iterationStep < 12; iterationStep += 1) {
          const midpoint = (bracketStart + bracketEnd) * 0.5;
          const midpointPosition = lerpPosition(
            nextPosition,
            remainingDelta,
            midpoint,
          );

          if (overlapsAt(shape, midpointPosition, rotation, candidate)) {
            bracketEnd = midpoint;
          } else {
            bracketStart = midpoint;
          }
        }

        impactTime = bracketEnd;
      }

      if (!closestHit || impactTime < closestHit.timeOfImpact) {
        const impactPosition = lerpPosition(
          nextPosition,
          remainingDelta,
          impactTime,
        );
        closestHit = {
          colliderHandle: candidate.handle,
          normal: estimateContactNormal(
            impactPosition,
            candidate,
            normalize(scale(remainingDelta, -1)),
          ),
          timeOfImpact: impactTime,
        };
      }
    }

    if (!closestHit) {
      nextPosition = add(nextPosition, remainingDelta);
      remainingTime = 0;
      break;
    }

    const travelDistance = length(remainingDelta);
    const safeToi = Math.max(
      0,
      Math.min(
        closestHit.timeOfImpact,
        closestHit.timeOfImpact -
          SAFE_IMPACT_DISTANCE / Math.max(travelDistance, 1),
      ),
    );

    nextPosition = add(nextPosition, scale(remainingDelta, safeToi));
    remainingTime *= 1 - safeToi;

    appendContact(contacts, closestHit.colliderHandle, closestHit.normal);

    const slidVelocity = projectAlongPlane(
      correctedVelocity,
      closestHit.normal,
    );
    correctedVelocity[0] = slidVelocity[0];
    correctedVelocity[1] = slidVelocity[1];
    correctedVelocity[2] = slidVelocity[2];
    remainingDelta = scale(correctedVelocity, remainingTime);
  }

  syncFishColliderPosition(collider, nextPosition);
  writeColliderVelocity(collider, correctedVelocity);

  return {
    position: nextPosition,
    velocity: correctedVelocity,
    contacts,
  };
}
