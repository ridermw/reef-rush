import * as RAPIER from '@dimforge/rapier3d-compat';
import {
  releaseResources,
  rollbackConstruction,
} from '../core/resourceCleanup';
import { CurrentVolume } from '../obstacles/CurrentVolume';
import { assertDeltaTime } from '../obstacles/Obstacle';
import { RotatingGate } from '../obstacles/RotatingGate';
import { applyGameplayCollision } from '../physics/collisionGroups';
import type { PhysicsRuntime } from '../physics/createPhysicsRuntime';
import {
  parseCourseDefinition,
  vector3Schema,
  type CourseDefinition,
  type CourseObject,
  type Vector3,
} from './courseDefinition';

export interface CourseSolid {
  readonly definition: Extract<CourseObject, { type: 'box' | 'sphere' }>;
  readonly collider: RAPIER.Collider;
}

export interface CourseRuntime {
  readonly definition: CourseDefinition;
  readonly solids: readonly CourseSolid[];
  readonly obstacles: readonly (CurrentVolume | RotatingGate)[];
  update(dt: number): void;
  sampleCurrent(position: Vector3): [number, number, number];
  dispose(): void;
}

export function createCourseRuntime(
  physics: PhysicsRuntime,
  input: unknown,
): CourseRuntime {
  const definition = parseCourseDefinition(input);
  const solids: CourseSolid[] = [];
  const obstacles: Array<CurrentVolume | RotatingGate> = [];
  const currents: CurrentVolume[] = [];
  const releases: Array<() => void> = [];
  let disposed = false;

  try {
    for (const object of definition.objects) {
      if (object.type === 'current' || object.type === 'rotating-gate') {
        const obstacle =
          object.type === 'current'
            ? new CurrentVolume(object)
            : new RotatingGate(physics, object);
        releases.push(() => obstacle.dispose());
        obstacles.push(obstacle);
        if (obstacle instanceof CurrentVolume) currents.push(obstacle);
      } else {
        const desc =
          object.type === 'box'
            ? RAPIER.ColliderDesc.cuboid(...object.halfExtents)
            : RAPIER.ColliderDesc.ball(object.radius);
        desc.setTranslation(...object.position);
        if (object.type === 'box') {
          const [x, y, z, w] = object.rotation;
          desc.setRotation({ x, y, z, w });
        }
        const collider = physics.world.createCollider(
          applyGameplayCollision(desc, object.collision),
        );
        releases.push(() => {
          if (collider.isValid()) physics.world.removeCollider(collider, false);
        });
        solids.push(Object.freeze({ definition: object, collider }));
      }
    }
  } catch (cause) {
    rollbackConstruction(
      cause,
      releases,
      'Course creation failed and resource cleanup failed.',
    );
  }

  function assertLive(): void {
    if (disposed) throw new Error('CourseRuntime is disposed.');
  }

  const runtime: CourseRuntime = {
    definition,
    solids: Object.freeze(solids),
    obstacles: Object.freeze(obstacles),
    update(dt): void {
      assertLive();
      assertDeltaTime(dt);
      for (const obstacle of obstacles) obstacle.update(dt);
    },
    sampleCurrent(position): [number, number, number] {
      assertLive();
      const point = vector3Schema.parse(position);
      const total: [number, number, number] = [0, 0, 0];
      for (const volume of currents) {
        const velocity = volume.sampleCurrent(point);
        total[0] += velocity[0];
        total[1] += velocity[1];
        total[2] += velocity[2];
      }
      return total;
    },
    dispose(): void {
      disposed = true;
      const errors = releaseResources(releases);
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Course resource cleanup failed.');
      }
    },
  };
  return Object.freeze(runtime);
}
