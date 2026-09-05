import { afterEach, expect, it, vi } from 'vitest';
import { InputController } from '../../src/game/input/InputController';
import {
  DEFAULT_INPUT_PREFERENCES,
  type InputPreferences,
} from '../../src/settings/settings';

const preferenceControllers: InputController[] = [];

function withPreferences(
  preferences: InputPreferences = DEFAULT_INPUT_PREFERENCES,
) {
  const controller = new InputController(window, { preferences });
  preferenceControllers.push(controller);
  window.innerWidth = 200;
  window.innerHeight = 100;
  return controller;
}

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
  for (const controller of preferenceControllers.splice(0))
    controller.destroy();
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
    steerX: -1,
    steerY: 1,
    throttle: 1,
    dashPressed: true,
    brakeHeld: true,
    pausePressed: true,
  });

  expect(controller.readFrame()).toMatchObject({
    steerX: -1,
    steerY: 1,
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
    steerY: 1,
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
    steerX: -0.8,
    steerY: 1,
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
  expect(controller.readFrame().steerX).toBeLessThan(0);
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

it('disables only pointer steering, leaving keyboard axes and actions available', () => {
  const controller = withPreferences({
    ...DEFAULT_INPUT_PREFERENCES,
    mouseSteering: false,
  });
  dispatchPointerMove(500, -500);
  expect(controller.readFrame()).toMatchObject({ steerX: 0, steerY: 0 });
  for (const code of [
    'KeyD',
    'ArrowUp',
    'KeyW',
    'ShiftLeft',
    'Space',
    'Escape',
  ]) {
    dispatchKeyboardEvent('keydown', { code });
  }
  expect(controller.readFrame()).toEqual({
    steerX: -1,
    steerY: 1,
    throttle: 1,
    brakeHeld: true,
    dashPressed: true,
    pausePressed: true,
  });
});

it.each([
  { sensitivity: 0.25, dx: 200, dy: -100, x: -0.5, y: 0.5 },
  { sensitivity: 1, dx: 50, dy: -25, x: -0.5, y: 0.5 },
  { sensitivity: 2, dx: 30, dy: -15, x: -0.6, y: 0.6 },
  { sensitivity: 2, dx: 80, dy: -40, x: -1, y: 1 },
])(
  'scales normalized pointer deltas before the final clamp: $sensitivity ($dx, $dy)',
  ({ sensitivity, dx, dy, x, y }) => {
    const controller = withPreferences({
      ...DEFAULT_INPUT_PREFERENCES,
      mouseSensitivity: sensitivity,
    });
    dispatchPointerMove(dx / 2, dy / 2);
    dispatchPointerMove(dx / 2, dy / 2);
    expect(controller.readFrame()).toMatchObject({ steerX: x, steerY: y });
    expect(controller.readFrame()).toMatchObject({ steerX: 0, steerY: 0 });
  },
);

it('inverts mouse pitch only, never arrow pitch or horizontal steering', () => {
  const controller = withPreferences({
    ...DEFAULT_INPUT_PREFERENCES,
    invertMouseY: true,
  });
  dispatchPointerMove(40, -20);
  expect(controller.readFrame()).toMatchObject({ steerX: -0.4, steerY: -0.4 });
  dispatchKeyboardEvent('keydown', { code: 'ArrowUp' });
  expect(controller.readFrame().steerY).toBe(1);
  dispatchKeyboardEvent('keyup', { code: 'ArrowUp' });
  dispatchKeyboardEvent('keydown', { code: 'ArrowDown' });
  expect(controller.readFrame().steerY).toBe(-1);
});

it('clears stale pointer deltas on preference changes without resetting held keys or queued actions', () => {
  const controller = withPreferences();
  for (const code of [
    'KeyD',
    'ArrowUp',
    'KeyW',
    'ShiftLeft',
    'Space',
    'Escape',
  ]) {
    dispatchKeyboardEvent('keydown', { code });
  }
  dispatchPointerMove(-40, 20);
  controller.setPreferences({
    ...DEFAULT_INPUT_PREFERENCES,
    mouseSensitivity: 0.25,
  });
  expect(controller.readFrame()).toEqual({
    steerX: -1,
    steerY: 1,
    throttle: 1,
    brakeHeld: true,
    dashPressed: true,
    pausePressed: true,
  });
  expect(controller.readFrame()).toMatchObject({
    steerX: -1,
    steerY: 1,
    throttle: 1,
    brakeHeld: true,
    dashPressed: false,
    pausePressed: false,
  });
  for (const code of ['KeyD', 'ArrowUp', 'KeyW', 'ShiftLeft']) {
    dispatchKeyboardEvent('keyup', { code });
  }
  dispatchPointerMove(40, -20);
  expect(controller.readFrame()).toMatchObject({ steerX: -0.1, steerY: 0.1 });
});

it('never replays pointer movement across disable and re-enable changes', () => {
  const controller = withPreferences();
  dispatchPointerMove(40, -20);
  controller.setPreferences({
    ...DEFAULT_INPUT_PREFERENCES,
    mouseSteering: false,
  });
  expect(controller.readFrame()).toMatchObject({ steerX: 0, steerY: 0 });
  dispatchPointerMove(40, -20);
  controller.setPreferences(DEFAULT_INPUT_PREFERENCES);
  expect(controller.readFrame()).toMatchObject({ steerX: 0, steerY: 0 });
  dispatchPointerMove(40, -20);
  expect(controller.readFrame()).toMatchObject({ steerX: -0.4, steerY: 0.4 });
});

it.each([
  { mouseSensitivity: 0.249 },
  { mouseSensitivity: 2.001 },
  { mouseSensitivity: NaN },
  { mouseSensitivity: Infinity },
  { mouseSensitivity: '1' },
  { mouseSteering: 1 },
  { invertMouseY: 'true' },
  { invertMouseY: undefined },
  { version: 1 },
  { extra: true },
])(
  'rejects invalid preferences before mutating preferences, pending deltas, or actions %#',
  (patch) => {
    const controller = withPreferences({
      ...DEFAULT_INPUT_PREFERENCES,
      mouseSensitivity: 0.5,
    });
    dispatchPointerMove(40, -20);
    dispatchKeyboardEvent('keydown', { code: 'KeyW' });
    dispatchKeyboardEvent('keydown', { code: 'Space' });
    expect(() =>
      controller.setPreferences({ ...DEFAULT_INPUT_PREFERENCES, ...patch }),
    ).toThrow();
    expect(controller.readFrame()).toMatchObject({
      steerX: -0.2,
      steerY: 0.2,
      throttle: 1,
      dashPressed: true,
    });
    dispatchPointerMove(40, -20);
    expect(controller.readFrame()).toMatchObject({
      steerX: -0.2,
      steerY: 0.2,
      throttle: 1,
    });
  },
);

it('requires complete preferences and copies both constructor and replacement values', () => {
  const preferences = { ...DEFAULT_INPUT_PREFERENCES, mouseSensitivity: 0.5 };
  const controller = withPreferences(preferences);
  preferences.mouseSensitivity = 2;
  dispatchPointerMove(40, -20);
  expect(controller.readFrame()).toMatchObject({ steerX: -0.2, steerY: 0.2 });
  const replacement = { ...DEFAULT_INPUT_PREFERENCES, invertMouseY: true };
  controller.setPreferences(replacement);
  replacement.invertMouseY = false;
  dispatchPointerMove(40, -20);
  expect(() => controller.setPreferences({ mouseSteering: false })).toThrow();
  expect(controller.readFrame()).toMatchObject({ steerX: -0.4, steerY: -0.4 });
});

it.each([0.249, 2.001, NaN, Infinity])(
  'rejects constructor sensitivity %s before installing listeners',
  (mouseSensitivity) => {
    const listener = vi.spyOn(window, 'addEventListener');
    expect(() =>
      withPreferences({ ...DEFAULT_INPUT_PREFERENCES, mouseSensitivity }),
    ).toThrow();
    expect(listener).not.toHaveBeenCalled();
  },
);

it('still cancels opposing horizontal keys with preferences enabled', () => {
  const controller = withPreferences({
    ...DEFAULT_INPUT_PREFERENCES,
    invertMouseY: true,
    mouseSensitivity: 2,
  });
  for (const code of ['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight']) {
    dispatchKeyboardEvent('keydown', { code });
  }
  expect(controller.readFrame().steerX).toBe(0);
});
