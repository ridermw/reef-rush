import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, expect, it } from 'vitest';
import { ChaseCamera } from '../../src/game/camera/ChaseCamera';
import {
  SCENE_CAMERA_TUNING,
  SCENE_FISH_TUNING,
} from '../../src/game/core/sceneRuntimeTuning';
import { InputController } from '../../src/game/input/InputController';
import { stepFishMotion } from '../../src/game/player/stepFishMotion';

const inputs: InputController[] = [];
afterEach(() => {
  for (const input of inputs.splice(0)) input.destroy();
});

const cases = [
  { name: 'D turns right', code: 'KeyD', axis: 0, sign: 1 },
  { name: 'A turns left', code: 'KeyA', axis: 0, sign: -1 },
  { name: 'Right arrow turns right', code: 'ArrowRight', axis: 0, sign: 1 },
  { name: 'Left arrow turns left', code: 'ArrowLeft', axis: 0, sign: -1 },
  { name: 'Up arrow raises the nose', code: 'ArrowUp', axis: 1, sign: 1 },
  { name: 'Down arrow lowers the nose', code: 'ArrowDown', axis: 1, sign: -1 },
  { name: 'Mouse right turns right', pointer: [120, 0], axis: 0, sign: 1 },
  { name: 'Mouse left turns left', pointer: [-120, 0], axis: 0, sign: -1 },
  { name: 'Mouse up raises the nose', pointer: [0, -120], axis: 1, sign: 1 },
  { name: 'Mouse down lowers the nose', pointer: [0, 120], axis: 1, sign: -1 },
] as const;

it.each(cases)('$name in the actual chase camera frame', (direction) => {
  const controller = new InputController();
  inputs.push(controller);
  if ('code' in direction) {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: direction.code }),
    );
  } else {
    const event = new PointerEvent('pointermove', { bubbles: true });
    Object.defineProperties(event, {
      movementX: { value: direction.pointer[0] },
      movementY: { value: direction.pointer[1] },
    });
    window.dispatchEvent(event);
  }
  const camera = new PerspectiveCamera(55, 16 / 9, 0.1, 180);
  new ChaseCamera(camera, SCENE_CAMERA_TUNING).snap([0, -4, 0], [0, 0, 1]);
  const screenAxis = new Vector3().setFromMatrixColumn(
    camera.matrixWorld,
    direction.axis,
  );
  const { next } = stepFishMotion(
    {
      position: [0, -4, 0],
      velocity: [0, 0, 6],
      yaw: 0,
      pitch: 0,
      roll: 0,
      dashEnergy: 1,
      isSubmerged: true,
    },
    controller.readFrame(),
    SCENE_FISH_TUNING,
    { current: [0, 0, 0], waterSurfaceY: 0 },
    1 / 60,
  );
  const headingChange = new Vector3(
    Math.sin(next.yaw) * Math.cos(next.pitch),
    Math.sin(next.pitch),
    Math.cos(next.yaw) * Math.cos(next.pitch),
  ).sub(new Vector3(0, 0, 1));
  expect(headingChange.dot(screenAxis) * direction.sign).toBeGreaterThan(0);
});
