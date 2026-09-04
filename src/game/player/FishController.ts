import type { Collider } from '@dimforge/rapier3d';
import type { InputFrame } from '../input/InputFrame';
import {
  PLAYER_GAMEPLAY_QUERY_GROUPS,
  doCollisionGroupsInteract,
  getGameplayCollisionKind,
} from '../physics/collisionGroups';
import type { PhysicsRuntime } from '../physics/createPhysicsRuntime';
import {
  moveFish,
  syncFishColliderPosition,
  type FishCollisionResult,
} from '../physics/moveFish';
import {
  getTrackedCollider,
  listTrackedColliders,
} from '../physics/trackedColliders';
import {
  type FishState,
  type FishTuning,
  type MotionEnvironment,
  stepFishMotion,
} from './stepFishMotion';

type Vec3 = [number, number, number];

type TriggerCollisionKind = 'hazard' | 'checkpoint' | 'pearl';
const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

const TRIGGER_EVENT_TYPES = {
  hazard: 'hazard-entered',
  checkpoint: 'checkpoint-entered',
  pearl: 'pearl-entered',
} as const;

export type FishControllerEvent =
  | { type: 'pause-requested' }
  | { type: 'dash' }
  | { type: 'breach' }
  | { type: 'splashdown' }
  | { type: 'collision'; colliderHandle: number; normal: Vec3 }
  | { type: 'hazard-entered'; colliderHandle: number }
  | { type: 'checkpoint-entered'; colliderHandle: number }
  | { type: 'pearl-entered'; colliderHandle: number };

export interface FishControllerStepResult {
  state: FishState;
  events: FishControllerEvent[];
  contacts: FishCollisionResult['contacts'];
}

export interface FishControllerOptions {
  runtime: PhysicsRuntime;
  collider: Collider;
  tuning: FishTuning;
  initialState: FishState;
}

function cloneState(state: FishState): FishState {
  return {
    ...state,
    position: [...state.position] as Vec3,
    velocity: [...state.velocity] as Vec3,
  };
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

function computeWorldVelocity(
  nextState: FishState,
  desiredDelta: Vec3,
  environment: MotionEnvironment,
  dt: number,
): Vec3 {
  const stepSeconds = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  if (stepSeconds > 0) {
    return scale(desiredDelta, 1 / stepSeconds);
  }

  return nextState.isSubmerged
    ? add(nextState.velocity, environment.current)
    : [...nextState.velocity];
}

function triggerKey(
  kind: TriggerCollisionKind,
  colliderHandle: number,
): string {
  return `${kind}:${colliderHandle}`;
}

export class FishController {
  private readonly runtime: PhysicsRuntime;
  private readonly collider: Collider;
  private readonly tuning: FishTuning;
  private readonly activeTriggers = new Set<string>();
  private state: FishState;

  constructor({
    runtime,
    collider,
    tuning,
    initialState,
  }: FishControllerOptions) {
    this.runtime = runtime;
    this.collider = collider;
    this.tuning = tuning;
    this.state = cloneState(initialState);
    syncFishColliderPosition(this.collider, this.state.position);
  }

  getState(): FishState {
    return cloneState(this.state);
  }

  step(
    input: InputFrame,
    environment: MotionEnvironment,
    dt: number,
  ): FishControllerStepResult {
    const motion = stepFishMotion(
      this.state,
      input,
      this.tuning,
      environment,
      dt,
    );
    const worldVelocity = computeWorldVelocity(
      motion.next,
      motion.desiredDelta,
      environment,
      dt,
    );
    const collision = moveFish(
      this.runtime,
      this.collider,
      motion.desiredDelta,
      worldVelocity,
      dt,
    );

    const nextState: FishState = {
      ...motion.next,
      position: [...collision.position],
      velocity: motion.next.isSubmerged
        ? subtract(collision.velocity, environment.current)
        : [...collision.velocity],
    };

    const events: FishControllerEvent[] = [];
    if (input.pausePressed) {
      events.push({ type: 'pause-requested' });
    }

    for (const event of motion.events) {
      events.push({ type: event });
    }

    for (const contact of collision.contacts) {
      events.push({
        type: 'collision',
        colliderHandle: contact.colliderHandle,
        normal: [...contact.normal],
      });
    }

    this.state = nextState;
    events.push(...this.collectTriggerEvents());

    return {
      state: cloneState(this.state),
      events,
      contacts: collision.contacts.map((contact) => ({
        colliderHandle: contact.colliderHandle,
        normal: [...contact.normal],
      })),
    };
  }

  private collectTriggerEvents(): FishControllerEvent[] {
    const events: FishControllerEvent[] = [];
    const nextTriggers = new Set<string>();
    const trackedCollider = getTrackedCollider(this.collider);
    const shape = trackedCollider?.shape ?? this.collider.shape;

    for (const candidate of listTrackedColliders(this.runtime.world)) {
      if (candidate.collider === this.collider) {
        continue;
      }

      const kind = candidate.kind ?? getGameplayCollisionKind(candidate.groups);
      if (kind !== 'hazard' && kind !== 'checkpoint' && kind !== 'pearl') {
        continue;
      }

      if (
        !doCollisionGroupsInteract(
          PLAYER_GAMEPLAY_QUERY_GROUPS,
          candidate.groups,
        )
      ) {
        continue;
      }

      const overlapping = shape.intersectsShape(
        {
          x: this.state.position[0],
          y: this.state.position[1],
          z: this.state.position[2],
        },
        IDENTITY_ROTATION,
        candidate.shape,
        {
          x: candidate.position[0],
          y: candidate.position[1],
          z: candidate.position[2],
        },
        candidate.rotation,
      );

      if (!overlapping) {
        continue;
      }

      const key = triggerKey(kind, candidate.handle);
      nextTriggers.add(key);

      if (!this.activeTriggers.has(key)) {
        events.push({
          type: TRIGGER_EVENT_TYPES[kind],
          colliderHandle: candidate.handle,
        });
      }
    }

    this.activeTriggers.clear();
    for (const key of nextTriggers) {
      this.activeTriggers.add(key);
    }

    return events;
  }
}
