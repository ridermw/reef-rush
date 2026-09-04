import {
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Vector3,
} from 'three';

const LN_2 = Math.log(2);
const EPSILON = 1e-6;

export interface ChaseCameraTuning {
  distance: number;
  height: number;
  positionHalfLife: number;
  rotationHalfLife: number;
  lookAheadSeconds: number;
  minFov: number;
  maxFov: number;
  collisionRadius: number;
}

function alphaFromHalfLife(halfLife: number, dt: number): number {
  if (!Number.isFinite(dt) || dt <= 0) {
    return 0;
  }

  if (!Number.isFinite(halfLife) || halfLife <= 0) {
    return 1;
  }

  return 1 - Math.exp((-LN_2 * dt) / halfLife);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeForward(
  targetForward: [number, number, number],
  out: Vector3,
): Vector3 {
  out.set(targetForward[0], targetForward[1], targetForward[2]);
  if (out.lengthSq() <= EPSILON) {
    return out.set(0, 0, 1);
  }

  return out.normalize();
}

export class ChaseCamera {
  private readonly camera: PerspectiveCamera;
  private readonly tuning: ChaseCameraTuning;
  private readonly orbitPosition = new Vector3();
  private readonly lookTarget = new Vector3();
  private readonly desiredQuaternion = new Quaternion();
  private readonly orientationTarget = new Object3D();
  private readonly forward = new Vector3();
  private readonly velocity = new Vector3();
  private readonly desiredPosition = new Vector3();
  private readonly desiredLookTarget = new Vector3();
  private readonly resolvedPosition = new Vector3();
  private readonly collisionDirection = new Vector3();
  private readonly raycaster = new Raycaster();
  private initialized = false;

  constructor(camera: PerspectiveCamera, tuning: ChaseCameraTuning) {
    this.camera = camera;
    this.tuning = tuning;
  }

  step(
    targetPosition: [number, number, number],
    targetForward: [number, number, number],
    velocity: [number, number, number],
    dt: number,
  ): void {
    if (!this.initialized) {
      this.snap(targetPosition, targetForward);
    }

    const positionAlpha = alphaFromHalfLife(this.tuning.positionHalfLife, dt);
    const rotationAlpha = alphaFromHalfLife(this.tuning.rotationHalfLife, dt);
    this.computeTargets(targetPosition, targetForward, velocity);

    this.orbitPosition.lerp(this.desiredPosition, positionAlpha);
    this.lookTarget.lerp(this.desiredLookTarget, rotationAlpha);

    this.resolveObstruction();
    this.camera.position.copy(this.resolvedPosition);
    this.orientCamera(rotationAlpha);

    const speed = this.velocity.length();
    const speedFactor = clamp(
      (speed * this.tuning.lookAheadSeconds) /
        Math.max(this.tuning.distance, 1),
      0,
      1,
    );
    const targetFov =
      this.tuning.minFov +
      (this.tuning.maxFov - this.tuning.minFov) * speedFactor;
    this.camera.fov += (targetFov - this.camera.fov) * positionAlpha;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  snap(
    targetPosition: [number, number, number],
    targetForward: [number, number, number],
  ): void {
    this.computeTargets(targetPosition, targetForward, [0, 0, 0]);
    this.orbitPosition.copy(this.desiredPosition);
    this.lookTarget.copy(this.desiredLookTarget);
    this.resolveObstruction();
    this.camera.position.copy(this.resolvedPosition);
    this.camera.fov = this.tuning.minFov;
    this.camera.updateProjectionMatrix();
    this.orientCamera(1);
    this.camera.updateMatrixWorld();
    this.initialized = true;
  }

  private computeTargets(
    targetPosition: [number, number, number],
    targetForward: [number, number, number],
    velocity: [number, number, number],
  ): void {
    normalizeForward(targetForward, this.forward);
    this.velocity.set(velocity[0], velocity[1], velocity[2]);

    const speed = this.velocity.length();
    this.desiredLookTarget.set(
      targetPosition[0],
      targetPosition[1],
      targetPosition[2],
    );
    this.desiredLookTarget.addScaledVector(
      this.forward,
      speed * this.tuning.lookAheadSeconds,
    );

    this.desiredPosition.set(
      targetPosition[0],
      targetPosition[1],
      targetPosition[2],
    );
    this.desiredPosition.addScaledVector(this.forward, -this.tuning.distance);
    this.desiredPosition.y += this.tuning.height;
  }

  private orientCamera(alpha: number): void {
    this.orientationTarget.position.copy(this.camera.position);
    this.orientationTarget.lookAt(this.lookTarget);
    this.desiredQuaternion.copy(this.orientationTarget.quaternion);
    this.camera.quaternion.slerp(this.desiredQuaternion, alpha);
  }

  private resolveObstruction(): void {
    const root = this.getCollisionRoot();
    if (!root) {
      this.resolvedPosition.copy(this.orbitPosition);
      return;
    }

    root.updateMatrixWorld(true);
    this.collisionDirection.copy(this.orbitPosition).sub(this.lookTarget);
    const distance = this.collisionDirection.length();

    if (distance <= EPSILON) {
      this.resolvedPosition.copy(this.orbitPosition);
      return;
    }

    this.collisionDirection.normalize();
    this.raycaster.set(this.lookTarget, this.collisionDirection);
    this.raycaster.far = distance + this.tuning.collisionRadius;

    const intersections = this.raycaster
      .intersectObjects(root.children, true)
      .filter(
        (intersection) =>
          !this.isCameraObject(intersection.object) &&
          !intersection.object.userData.ignoreChaseCameraCollision,
      );

    const firstHit = intersections[0];
    if (!firstHit) {
      this.resolvedPosition.copy(this.orbitPosition);
      return;
    }

    const safeDistance = Math.max(
      0,
      firstHit.distance - this.tuning.collisionRadius,
    );
    this.resolvedPosition.copy(this.lookTarget);
    this.resolvedPosition.addScaledVector(
      this.collisionDirection,
      safeDistance,
    );
  }

  private getCollisionRoot(): Object3D | null {
    let root: Object3D | null = this.camera.parent;
    while (root?.parent) {
      root = root.parent;
    }

    return root;
  }

  private isCameraObject(object: Object3D): boolean {
    return object === this.camera || this.camera.children.includes(object);
  }
}
