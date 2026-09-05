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

it('prevents scrolling only for playing controls outside interactive elements', () => {
  let playing = true;
  const controller = new InputController(window, { isPlaying: () => playing });
  const key = (target: EventTarget, code: string) => {
    const event = new KeyboardEvent('keydown', {
      code,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const button = document.createElement('button');
  const field = document.createElement('input');
  document.body.append(button, field);
  expect(key(window, 'ArrowDown')).toBe(true);
  expect(key(window, 'KeyZ')).toBe(false);
  expect(key(button, 'Space')).toBe(false);
  expect(key(field, 'KeyW')).toBe(false);
  expect(controller.readFrame()).toMatchObject({
    dashPressed: false,
    throttle: 0,
  });
  playing = false;
  expect(key(window, 'Space')).toBe(false);
  expect(controller.readFrame().dashPressed).toBe(false);
  controller.destroy();
  button.remove();
  field.remove();
});

it('only steers from pointer movement on the owned canvas, not HUD controls', () => {
  const canvas = document.createElement('canvas');
  const button = document.createElement('button');
  document.body.append(canvas, button);
  const controller = new InputController(window, { pointerSurface: canvas });
  function move(target: HTMLElement) {
    const event = new PointerEvent('pointermove', { bubbles: true });
    Object.defineProperties(event, {
      movementX: { value: 100 },
      movementY: { value: 20 },
    });
    target.dispatchEvent(event);
  }
  move(button);
  expect(controller.readFrame()).toMatchObject({ steerX: 0, steerY: 0 });
  move(canvas);
  expect(controller.readFrame().steerX).toBeGreaterThan(0);
  controller.destroy();
  canvas.remove();
  button.remove();
});

it.each(['button', 'role-button'])(
  'accepts one Escape edge from a %s descendant without intercepting movement or activation',
  (kind) => {
    const controller = new InputController();
    const button = document.createElement(kind === 'button' ? 'button' : 'div');
    if (kind === 'role-button') button.setAttribute('role', 'button');
    const child = document.createElement('span');
    button.append(child);
    document.body.append(button);
    const press = (code: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', {
        code,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      child.dispatchEvent(event);
      return event.defaultPrevented;
    };
    try {
      expect(press('Space')).toBe(false);
      expect(press('Enter')).toBe(false);
      expect(press('KeyW')).toBe(false);
      expect(press('ArrowDown')).toBe(false);
      expect(press('Escape')).toBe(true);
      expect(controller.readFrame()).toMatchObject({
        pausePressed: true,
        dashPressed: false,
        throttle: 0,
        steerY: 0,
      });
      expect(controller.readFrame().pausePressed).toBe(false);
      press('Escape', { repeat: true });
      press('Escape', { altKey: true });
      press('Escape', { ctrlKey: true });
      press('Escape', { metaKey: true });
      expect(controller.readFrame().pausePressed).toBe(false);
    } finally {
      controller.destroy();
      button.remove();
    }
  },
);
