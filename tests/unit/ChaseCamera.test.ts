import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';
import {
  ChaseCamera,
  type ChaseCameraTuning,
} from '../../src/game/camera/ChaseCamera';

const tuning: ChaseCameraTuning = {
  distance: 8,
  height: 2,
  positionHalfLife: 0.2,
  rotationHalfLife: 0.15,
  lookAheadSeconds: 0.25,
  minFov: 55,
  maxFov: 72,
  collisionRadius: 0.3,
};

function createCameraInScene(): {
  camera: PerspectiveCamera;
  scene: Scene;
} {
  const scene = new Scene();
  const camera = new PerspectiveCamera(55, 16 / 9, 0.1, 100);
  scene.add(camera);
  return { camera, scene };
}

function getDirection(camera: PerspectiveCamera): Vector3 {
  return camera.getWorldDirection(new Vector3());
}

describe('ChaseCamera', () => {
  it('snaps immediately, then smoothly follows a moving target', () => {
    const { camera } = createCameraInScene();
    const chaseCamera = new ChaseCamera(camera, tuning);

    chaseCamera.snap([0, 0, 0], [0, 0, 1]);

    expect(camera.position.toArray()).toEqual([0, 2, -8]);
    expect(camera.fov).toBe(55);

    chaseCamera.step([10, 4, 0], [0, 0, 1], [0, 0, 0], tuning.positionHalfLife);

    expect(camera.position.x).toBeCloseTo(5, 3);
    expect(camera.position.y).toBeCloseTo(4, 3);
    expect(camera.position.z).toBeCloseTo(-8, 5);
  });

  it('applies speed-based look-ahead and clamps the field of view', () => {
    const { camera } = createCameraInScene();
    const chaseCamera = new ChaseCamera(camera, tuning);

    chaseCamera.snap([0, 0, 0], [0, 0, 1]);
    chaseCamera.step([0, 0, 0], [0, 0, 1], [0, 0, 0], 10);
    const slowDirection = getDirection(camera).clone();
    const slowFov = camera.fov;

    chaseCamera.step([0, 0, 0], [0, 0, 1], [0, 0, 40], 10);
    const fastDirection = getDirection(camera);

    expect(slowFov).toBeCloseTo(tuning.minFov, 5);
    expect(camera.fov).toBeLessThanOrEqual(tuning.maxFov);
    expect(camera.fov).toBeGreaterThan(slowFov);
    expect(Math.abs(fastDirection.y)).toBeLessThan(Math.abs(slowDirection.y));

    chaseCamera.step([0, 0, 0], [0, 0, 1], [0, 0, 0], 10);
    expect(camera.fov).toBeGreaterThanOrEqual(tuning.minFov);
    expect(camera.fov).toBeCloseTo(tuning.minFov, 5);
  });

  it('smooths abrupt surface transitions instead of jumping vertically', () => {
    const { camera } = createCameraInScene();
    const chaseCamera = new ChaseCamera(camera, tuning);

    chaseCamera.snap([0, -2, 0], [0, 0, 1]);
    const initialY = camera.position.y;

    chaseCamera.step(
      [0, 6, 0],
      [0, 0, 1],
      [0, 0, 0],
      tuning.positionHalfLife / 2,
    );

    expect(camera.position.y).toBeGreaterThan(initialY);
    expect(camera.position.y).toBeLessThan(8);
  });

  it('moves the camera in front of scene obstructions', () => {
    const { camera, scene } = createCameraInScene();
    const wall = new Mesh(new BoxGeometry(4, 4, 0.25), new MeshBasicMaterial());
    wall.position.set(0, 1, -4);
    scene.add(wall);
    scene.updateMatrixWorld(true);

    const chaseCamera = new ChaseCamera(camera, tuning);
    chaseCamera.snap([0, 0, 0], [0, 0, 1]);

    expect(camera.position.z).toBeGreaterThan(-4);
    expect(camera.position.distanceTo(new Vector3(0, 0, 0))).toBeLessThan(
      tuning.distance,
    );
  });
});
