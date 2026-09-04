import { afterEach, expect, it, vi } from 'vitest';
import { InputController } from '../../src/game/input/InputController';

function dispatchKeyboardEvent(
  type: 'keydown' | 'keyup',
  options: KeyboardEventInit & { repeat?: boolean } = {},
): void {
  window.dispatchEvent(new KeyboardEvent(type, options));
}

function dispatchPointerMove(movementX: number, movementY: number): void {
  const event = new PointerEvent('pointermove', { bubbles: true });
  Object.defineProperty(event, 'movementX', { value: movementX });
  Object.defineProperty(event, 'movementY', { value: movementY });
  window.dispatchEvent(event);
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('reads keyboard axes, one-shot actions, and clears consumed presses', () => {
  const controller = new InputController();

  dispatchKeyboardEvent('keydown', { code: 'KeyD' });
  dispatchKeyboardEvent('keydown', { code: 'KeyW' });
  dispatchKeyboardEvent('keydown', { code: 'ArrowUp' });
  dispatchKeyboardEvent('keydown', { code: 'Space' });
  dispatchKeyboardEvent('keydown', { code: 'ShiftLeft' });
  dispatchKeyboardEvent('keydown', { code: 'Escape' });

  expect(controller.readFrame()).toMatchObject({
    steerX: 1,
    steerY: -1,
    throttle: 1,
    dashPressed: true,
    brakeHeld: true,
    pausePressed: true,
  });

  expect(controller.readFrame()).toMatchObject({
    steerX: 1,
    steerY: -1,
    throttle: 1,
    dashPressed: false,
    brakeHeld: true,
    pausePressed: false,
  });

  controller.destroy();
});

it('cancels opposing throttle keys', () => {
  const controller = new InputController();

  dispatchKeyboardEvent('keydown', { code: 'KeyW' });
  dispatchKeyboardEvent('keydown', { code: 'KeyS' });

  expect(controller.readFrame()).toMatchObject({
    steerX: 0,
    steerY: 0,
    throttle: 0,
  });

  controller.destroy();
});

it('cancels opposing pitch keys', () => {
  const controller = new InputController();

  dispatchKeyboardEvent('keydown', { code: 'ArrowUp' });
  dispatchKeyboardEvent('keydown', { code: 'ArrowDown' });

  expect(controller.readFrame()).toMatchObject({
    steerX: 0,
    steerY: 0,
    throttle: 0,
  });

  controller.destroy();
});

it('does not map W to pitch', () => {
  const controller = new InputController();

  dispatchKeyboardEvent('keydown', { code: 'KeyW' });

  expect(controller.readFrame()).toMatchObject({
    steerX: 0,
    steerY: 0,
    throttle: 1,
  });

  controller.destroy();
});

it('does not map ArrowUp to throttle', () => {
  const controller = new InputController();

  dispatchKeyboardEvent('keydown', { code: 'ArrowUp' });

  expect(controller.readFrame()).toMatchObject({
    steerX: 0,
    steerY: -1,
    throttle: 0,
  });

  controller.destroy();
});

it('normalizes pointer movement and clamps axes to the unit range', () => {
  const controller = new InputController();
  window.innerWidth = 200;
  window.innerHeight = 100;

  dispatchPointerMove(80, -120);

  expect(controller.readFrame()).toMatchObject({
    steerX: 0.8,
    steerY: -1,
    throttle: 0,
    dashPressed: false,
    brakeHeld: false,
    pausePressed: false,
  });

  controller.destroy();
});

it('suppresses repeated edge-triggered actions and resets on blur', () => {
  const controller = new InputController();

  dispatchKeyboardEvent('keydown', { code: 'Space' });
  dispatchKeyboardEvent('keydown', { code: 'Space', repeat: true });
  dispatchKeyboardEvent('keydown', { code: 'Escape' });
  dispatchKeyboardEvent('keydown', { code: 'Escape', repeat: true });

  expect(controller.readFrame()).toMatchObject({
    dashPressed: true,
    pausePressed: true,
  });

  window.dispatchEvent(new Event('blur'));

  expect(controller.readFrame()).toMatchObject({
    steerX: 0,
    steerY: 0,
    throttle: 0,
    dashPressed: false,
    brakeHeld: false,
    pausePressed: false,
  });

  controller.destroy();
});

it('removes every listener on destroy', () => {
  const addSpy = vi.spyOn(window, 'addEventListener');
  const removeSpy = vi.spyOn(window, 'removeEventListener');
  const controller = new InputController();

  controller.destroy();

  expect(addSpy.mock.calls.map(([type]) => type)).toEqual([
    'keydown',
    'keyup',
    'blur',
    'pointermove',
  ]);
  expect(removeSpy.mock.calls.map(([type]) => type)).toEqual([
    'keydown',
    'keyup',
    'blur',
    'pointermove',
  ]);
});
