import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { createAppStore } from '../../src/app/appStore';
import { GameHost, type HostRenderer } from '../../src/game/core/GameHost';
import {
  createSceneRuntime,
  type SceneRuntime,
} from '../../src/game/core/SceneRuntime';
import { InputController } from '../../src/game/input/InputController';
import { inputFrameSchema } from '../../src/game/input/InputFrame';
import { parseCourseDefinition } from '../../src/game/course/courseDefinition';
import { courseFixture } from '../fixtures/courseDefinition';

const hosts: GameHost[] = [];
const views: ReturnType<typeof render>[] = [];

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) =>
      Object.assign(new EventTarget(), {
        matches: query.includes('pointer: coarse'),
        media: query,
      }),
    ),
  );
  const captures = new WeakMap<Element, Set<number>>();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  for (const [name, value] of Object.entries({
    setPointerCapture(this: Element, id: number) {
      const ids = captures.get(this) ?? new Set<number>();
      ids.add(id);
      captures.set(this, ids);
    },
    hasPointerCapture(this: Element, id: number) {
      return captures.get(this)?.has(id) ?? false;
    },
    releasePointerCapture(this: Element, id: number) {
      captures.get(this)?.delete(id);
    },
  })) {
    Object.defineProperty(Element.prototype, name, {
      configurable: true,
      value,
    });
  }
});

afterEach(async () => {
  for (const view of views.splice(0)) view.unmount();
  for (const host of hosts.splice(0)) await host.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup() {
  const store = createAppStore();
  let runtime!: SceneRuntime;
  let keyboard!: InputController;
  let now = 0;
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const renderer: HostRenderer = {
    domElement: document.createElement('canvas'),
    setPixelRatio: () => {},
    setSize: () => {},
    render: () => {},
    dispose: () => {},
    forceContextLoss: () => {},
  };
  const host = new GameHost(store, {
    storage: () => ({ getItem: () => null, setItem: () => {} }),
    createRenderer: () => Promise.resolve(renderer),
    loadCourse: () => Promise.resolve(parseCourseDefinition(courseFixture())),
    createScene: async (definition) => {
      runtime = { ...(await createSceneRuntime(definition)) };
      return runtime;
    },
    createInput: (canvas, isPlaying) => {
      keyboard = new InputController(window, {
        pointerSurface: canvas,
        isPlaying,
      });
      return keyboard;
    },
    isFocused: () => true,
    measure: () => ({ width: 390, height: 844, dpr: 1 }),
    observeResize: () => () => {},
    now: () => now,
    requestFrame: (callback) => {
      frames.set(++nextId, callback);
      return nextId;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
  });
  hosts.push(host);
  const view = render(<App store={store} host={host} />);
  views.push(view);
  expect(
    screen.queryByRole('group', { name: 'Touch controls' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Dive in' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load Sunlit Shoals' }));
  await act(() => host.whenIdle());
  expect(
    screen.queryByRole('group', { name: 'Touch controls' }),
  ).toBeInTheDocument();
  const pad = screen.getByRole('button', { name: 'Steer fish' });
  vi.spyOn(pad, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 120, 120),
  );
  const step = vi.spyOn(runtime, 'step');
  const frame = () => {
    act(() => {
      now += 17;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(now);
    });
    const input = step.mock.calls.at(-1)?.[0];
    expect(input).toBeDefined();
    return inputFrameSchema.parse(input);
  };
  return { host, store, view, keyboard, frame, pad, runtime };
}

function pointer(
  element: Element,
  type: string,
  pointerId: number,
  clientX = 60,
  clientY = 60,
) {
  fireEvent(
    element,
    new PointerEvent(type, {
      pointerId,
      pointerType: 'touch',
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
      button: 0,
    }),
  );
}

function key(type: 'keydown' | 'keyup', code: string) {
  fireEvent(window, new KeyboardEvent(type, { code, bubbles: true }));
}

it.each([
  [0, 60, 'KeyA', 1, 0],
  [120, 60, 'KeyD', -1, 0],
  [60, 0, 'ArrowUp', 0, 1],
  [60, 120, 'ArrowDown', 0, -1],
] as const)(
  'maps touch (%s,%s) into the same real scene axes as %s',
  async (x, y, code, steerX, steerY) => {
    const h = await setup();
    key('keydown', code);
    const keyboard = h.frame();
    key('keyup', code);
    pointer(h.pad, 'pointerdown', 1, x, y);
    const touch = h.frame();
    expect(touch).toEqual(keyboard);
    expect(touch).toMatchObject({ steerX, steerY });
  },
);

it('steers proportionally, clamps outside the captured pad and ignores another steering finger', async () => {
  const h = await setup();
  pointer(h.pad, 'pointerdown', 1, 90, 30);
  expect(h.pad.hasPointerCapture(1)).toBe(true);
  expect(h.frame()).toMatchObject({ steerX: -0.5, steerY: 0.5 });
  pointer(h.pad, 'pointerdown', 2, 0, 120);
  pointer(h.pad, 'pointermove', 2, 0, 120);
  expect(h.frame()).toMatchObject({ steerX: -0.5, steerY: 0.5 });
  pointer(h.pad, 'pointermove', 1, 600, -600);
  expect(h.frame()).toMatchObject({ steerX: -1, steerY: 1 });
});

it('combines steering with a second finger action and delivers one dash edge to real physics', async () => {
  const h = await setup();
  pointer(h.pad, 'pointerdown', 1, 90, 30);
  pointer(screen.getByRole('button', { name: 'Faster' }), 'pointerdown', 2);
  pointer(screen.getByRole('button', { name: 'Brake' }), 'pointerdown', 3);
  const dash = screen.getByRole('button', { name: 'Dash' });
  pointer(dash, 'pointerdown', 4);
  pointer(dash, 'pointerup', 4);
  const energy = h.host.getSnapshot().player?.dashEnergy;
  expect(h.frame()).toMatchObject({
    steerX: -0.5,
    steerY: 0.5,
    throttle: 1,
    brakeHeld: true,
    dashPressed: true,
  });
  expect(h.host.getSnapshot().player?.dashEnergy).toBeLessThan(energy!);
  expect(h.frame().dashPressed).toBe(false);
  pointer(screen.getByRole('button', { name: 'Slower' }), 'pointerdown', 5);
  expect(h.frame().throttle).toBe(0);
  pointer(screen.getByRole('button', { name: 'Faster' }), 'pointerup', 2);
  expect(h.frame().throttle).toBe(-1);
});

it.each(['pointercancel', 'lostpointercapture'])(
  'discards pending touch Dash on %s without releasing other fingers',
  async (event) => {
    const h = await setup();
    const dash = screen.getByRole('button', { name: 'Dash' });
    pointer(h.pad, 'pointerdown', 1, 90, 30);
    pointer(screen.getByRole('button', { name: 'Faster' }), 'pointerdown', 2);
    pointer(screen.getByRole('button', { name: 'Brake' }), 'pointerdown', 3);
    pointer(dash, 'pointerdown', 4);
    pointer(dash, event, 4);
    const energy = h.host.getSnapshot().player?.dashEnergy;
    expect(h.frame()).toMatchObject({
      steerX: -0.5,
      steerY: 0.5,
      throttle: 1,
      brakeHeld: true,
      dashPressed: false,
    });
    expect(h.host.getSnapshot().player?.dashEnergy).toBe(energy);
    expect(h.frame().dashPressed).toBe(false);
  },
);

it.each(['pointercancel', 'lostpointercapture'])(
  'preserves queued physical keyboard Dash when touch Dash receives %s',
  async (event) => {
    const h = await setup();
    const dash = screen.getByRole('button', { name: 'Dash' });
    pointer(dash, 'pointerdown', 1);
    key('keydown', 'Space');
    pointer(dash, event, 1);
    const energy = h.host.getSnapshot().player?.dashEnergy;
    expect(h.frame().dashPressed).toBe(true);
    expect(h.host.getSnapshot().player?.dashEnergy).toBeLessThan(energy!);
    expect(h.frame().dashPressed).toBe(false);
    key('keyup', 'Space');
  },
);

it('delivers one ordinary touch Dash tap despite unrelated cancellation and capture loss after release', async () => {
  const h = await setup();
  const dash = screen.getByRole('button', { name: 'Dash' });
  pointer(dash, 'pointerdown', 1);
  pointer(dash, 'pointercancel', 2);
  pointer(dash, 'lostpointercapture', 2);
  pointer(dash, 'pointerup', 1);
  pointer(dash, 'lostpointercapture', 1);
  fireEvent.click(dash, { detail: 1 });
  expect(h.frame().dashPressed).toBe(true);
  expect(h.frame().dashPressed).toBe(false);
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])(
  'releases only the owning finger on %s',
  async (event) => {
    const h = await setup();
    const brake = screen.getByRole('button', { name: 'Brake' });
    const faster = screen.getByRole('button', { name: 'Faster' });
    pointer(h.pad, 'pointerdown', 1, 120, 0);
    pointer(brake, 'pointerdown', 2);
    pointer(faster, 'pointerdown', 3);
    pointer(h.pad, event, 9);
    expect(h.frame().steerX).toBe(-1);
    pointer(h.pad, event, 1);
    expect(h.frame()).toMatchObject({
      steerX: 0,
      steerY: 0,
      brakeHeld: true,
      throttle: 1,
    });
    pointer(brake, event, 2);
    pointer(faster, event, 3);
    expect(h.frame()).toMatchObject({ brakeHeld: false, throttle: 0 });
  },
);

it('keeps keyboard and touch holds independent and clamps their combined axes', async () => {
  const h = await setup();
  const brake = screen.getByRole('button', { name: 'Brake' });
  const faster = screen.getByRole('button', { name: 'Faster' });
  key('keydown', 'KeyD');
  key('keydown', 'KeyW');
  key('keydown', 'ShiftLeft');
  pointer(h.pad, 'pointerdown', 1, 120, 60);
  pointer(brake, 'pointerdown', 2);
  pointer(faster, 'pointerdown', 3);
  expect(h.frame()).toMatchObject({ steerX: -1, throttle: 1, brakeHeld: true });
  pointer(h.pad, 'pointerup', 1);
  pointer(brake, 'pointerup', 2);
  pointer(faster, 'pointerup', 3);
  expect(h.frame()).toMatchObject({ steerX: -1, throttle: 1, brakeHeld: true });
  pointer(h.pad, 'pointerdown', 1, 120, 60);
  pointer(brake, 'pointerdown', 2);
  pointer(faster, 'pointerdown', 3);
  key('keyup', 'KeyD');
  key('keyup', 'KeyW');
  key('keyup', 'ShiftLeft');
  expect(h.frame()).toMatchObject({ steerX: -1, throttle: 1, brakeHeld: true });
});

it.each(['resize', 'orientationchange'])(
  'clears captured controls on %s without clearing keyboard holds',
  async (event) => {
    const h = await setup();
    pointer(h.pad, 'pointerdown', 1, 120, 0);
    pointer(screen.getByRole('button', { name: 'Faster' }), 'pointerdown', 2);
    pointer(screen.getByRole('button', { name: 'Brake' }), 'pointerdown', 3);
    pointer(screen.getByRole('button', { name: 'Dash' }), 'pointerdown', 4);
    key('keydown', 'KeyW');
    fireEvent(window, new Event(event));
    pointer(h.pad, 'pointermove', 1, 120, 0);
    expect(h.frame()).toMatchObject({
      steerX: 0,
      steerY: 0,
      throttle: 1,
      brakeHeld: false,
      dashPressed: false,
    });
    expect(h.pad.hasPointerCapture(1)).toBe(false);
  },
);

it.each(['pause', 'blur', 'modal', 'unmount'] as const)(
  'clears touch state and queued dash across %s and re-entry',
  async (reason) => {
    const h = await setup();
    pointer(h.pad, 'pointerdown', 1, 120, 0);
    pointer(screen.getByRole('button', { name: 'Faster' }), 'pointerdown', 2);
    pointer(screen.getByRole('button', { name: 'Brake' }), 'pointerdown', 3);
    pointer(screen.getByRole('button', { name: 'Dash' }), 'pointerdown', 4);
    if (reason === 'pause')
      fireEvent.click(screen.getByRole('button', { name: 'Pause run' }));
    if (reason === 'blur') fireEvent(window, new Event('blur'));
    if (reason === 'modal') {
      h.host.setSettingsOpen(true);
      h.host.setSettingsOpen(false);
    }
    if (reason === 'unmount') {
      h.view.unmount();
      const view = render(<App store={h.store} host={h.host} />);
      views.push(view);
      await act(() => h.host.whenIdle());
    }
    if (reason === 'pause' || reason === 'blur' || reason === 'unmount') {
      expect(
        screen.queryByRole('group', { name: 'Touch controls' }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    }
    expect(h.frame()).toMatchObject({
      steerX: 0,
      steerY: 0,
      throttle: 0,
      brakeHeld: false,
      dashPressed: false,
    });
  },
);

it('rejects non-finite touch axes rather than passing invalid input to physics', async () => {
  const h = await setup();
  expect(() => h.host.touchInput.setSteering(Number.NaN, 0)).toThrow(
    RangeError,
  );
  expect(() =>
    h.host.touchInput.setSteering(0, Number.POSITIVE_INFINITY),
  ).toThrow(RangeError);
});
