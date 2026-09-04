import * as RAPIER from '@dimforge/rapier3d-compat';
import { rollbackConstruction } from '../core/resourceCleanup';
import {
  rotatingGateSchema,
  type RotatingGateDefinition,
} from '../course/courseDefinition';
import type { PhysicsRuntime } from '../physics/createPhysicsRuntime';
import { applyGameplayCollision } from '../physics/collisionGroups';
import { assertDeltaTime, type Obstacle } from './Obstacle';

const FULL_TURN = 2 * Math.PI;

function wrapAngle(angle: number): number {
  return ((angle % FULL_TURN) + FULL_TURN) % FULL_TURN;
}

export class RotatingGate implements Obstacle {
  readonly definition: RotatingGateDefinition;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private readonly runtime: PhysicsRuntime;
  private rotationAngle: number;
  private disposed = false;
  private released = false;

  constructor(runtime: PhysicsRuntime, input: unknown) {
    this.definition = rotatingGateSchema.parse(input);
    this.runtime = runtime;
    this.rotationAngle = wrapAngle(this.definition.phase);
    const colliderDesc = applyGameplayCollision(
      RAPIER.ColliderDesc.cuboid(...this.definition.halfExtents),
      'dynamicObstacle',
    );
    this.body = runtime.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(...this.definition.position)
        .setRotation(this.rotation()),
    );
    try {
      this.collider = runtime.world.createCollider(colliderDesc, this.body);
    } catch (cause) {
      rollbackConstruction(
        cause,
        [() => this.dispose()],
        'RotatingGate creation failed and body cleanup failed.',
      );
    }
  }

  get angle(): number {
    this.assertLive();
    return this.rotationAngle;
  }

  update(dt: number): void {
    this.assertLive();
    assertDeltaTime(dt);
    const { angularSpeed } = this.definition;
    if (dt === 0 || angularSpeed === 0) return;

    // Reduce elapsed time before multiplication so even huge finite dt cannot overflow.
    const period = FULL_TURN / Math.abs(angularSpeed);
    this.rotationAngle = wrapAngle(
      this.rotationAngle + (dt % period) * angularSpeed,
    );
    const rotation = this.rotation();
    this.body.setRotation(rotation, true);
    this.body.setNextKinematicRotation(rotation);
    this.runtime.world.propagateModifiedBodyPositionsToColliders();
  }

  dispose(): void {
    if (this.released) return;
    this.disposed = true;
    if (this.body.isValid()) this.runtime.world.removeRigidBody(this.body);
    this.released = true;
  }

  private rotation(): RAPIER.Rotation {
    const [x, y, z] = this.definition.axis;
    const sine = Math.sin(this.rotationAngle / 2);
    return {
      x: x * sine,
      y: y * sine,
      z: z * sine,
      w: Math.cos(this.rotationAngle / 2),
    };
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('RotatingGate is disposed.');
  }
}
