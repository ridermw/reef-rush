import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { createAppStore } from '../../src/app/appStore';
import type { CourseId } from '../../src/content/courses/courseIds';
import {
  createSceneRuntime,
  type SceneRuntime,
} from '../../src/game/core/SceneRuntime';
import type {
  GameHost,
  GameHostDependencies,
  HostRenderer,
} from '../../src/game/core/GameHost';
import { ConstructionCleanupError } from '../../src/game/core/resourceCleanup';
import { parseCourseDefinition } from '../../src/game/course/courseDefinition';
import {
  PROGRESS_STORAGE_KEY,
  type StorageLike,
} from '../../src/game/save/progressStorage';
import {
  parseProgress,
  unlockedCourseIds,
} from '../../src/game/progression/progress';
import { courseFixture } from '../fixtures/courseDefinition';
import { generatedSunlit } from '../fixtures/sunlitTraversal';
import { createAudioEngine } from '../../src/game/audio/AudioEngine';
import { FakeContext } from '../fixtures/audioContext';
import { createSettingsStore } from '../../src/settings/SettingsStore';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { InputController } from '../../src/game/input/InputController';

const hosts: Array<Pick<GameHost, 'dispose' | 'retryCleanup'>> = [];
const scenes: SceneRuntime[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function definition(finish = false) {
  const fixture = courseFixture();
  return parseCourseDefinition({
    ...fixture,
    objects: [],
    checkpoints: finish
      ? [
          {
            id: 'finish',
            position: [0, -3, 0.001],
            radius: 2,
            direction: [0, 0, 1],
          },
        ]
      : fixture.checkpoints,
    pearls: finish
      ? [{ id: 'pearl', position: [0, -3, 0], radius: 0.3 }]
      : fixture.pearls,
  });
}

async function realScene(input: unknown) {
  const scene = await createSceneRuntime(input);
  scenes.push(scene);
  return scene;
}

async function setup(options: GameHostDependencies = {}) {
  const store = createAppStore();
  const container = document.createElement('div');
  document.body.append(container);
  let now = 0;
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  let resize = () => {};
  let size = { width: 800, height: 400, dpr: 4 };
  const disconnect = vi.fn();
  const canvas = document.createElement('canvas');
  const renderer: HostRenderer = {
    domElement: canvas,
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    forceContextLoss: vi.fn(),
  };
  const runtimes: SceneRuntime[] = [];
  const storage = new Map<string, string>();
  const provider: StorageLike = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
  };
  const createRenderer = vi.fn(() => Promise.resolve(renderer));
  const loadCourse = vi.fn(() => Promise.resolve(definition()));
  const deps: GameHostDependencies = {
    createRenderer,
    loadCourse,
    createScene: async (input) => {
      const runtime = { ...(await realScene(input)) };
      runtimes.push(runtime);
      return runtime;
    },
    requestFrame: (callback) => {
      frames.set(++nextId, callback);
      return nextId;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    now: () => now,
    isFocused: () => true,
    measure: () => size,
    observeResize: (_element, callback) => {
      resize = callback;
      return disconnect;
    },
    storage: () => provider,
    coordinateProgress: (save) => Promise.resolve().then(save),
    ...options,
  };
  const { GameHost } = await import('../../src/game/core/GameHost');
  const host = new GameHost(store, deps);
  hosts.push(host);
  host.setContainer(container);
  function load(courseId: CourseId = 'sunlit-shoals') {
    store.dispatch({ type: 'OPEN_COURSE_SELECT' });
    store.dispatch({ type: 'LOAD_COURSE', courseId });
    return host.whenIdle();
  }
  function frame(ms: number) {
    now += ms;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  }
  return {
    host,
    store,
    container,
    renderer,
    createRenderer,
    loadCourse,
    runtimes,
    frames,
    frame,
    load,
    storage,
    disconnect,
    resize: (value: typeof size) => {
      size = value;
      resize();
    },
    elapse: (ms: number) => {
      now += ms;
    },
  };
}

function key(code: string, type = 'keydown') {
  window.dispatchEvent(
    new KeyboardEvent(type, { code, bubbles: true, cancelable: true }),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) {
    host.retryCleanup();
    await host.dispose();
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const scene of scenes.splice(0)) scene.dispose();
  document.body.replaceChildren();
});

describe('GameHost real-scene ownership', () => {
  it('owns live system reduced motion, combines the explicit flag, and propagates through pause and pending load', async () => {
    const media = Object.assign(new EventTarget(), { matches: false });
    const add = vi.spyOn(media, 'addEventListener');
    const remove = vi.spyOn(media, 'removeEventListener');
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media),
    );
    const settings = createSettingsStore(() => ({
      getItem: () => null,
      setItem: () => {},
    }));
    const gate = deferred<void>();
    const h = await setup({
      settings,
      loadCourse: async () => {
        await gate.promise;
        return definition();
      },
    });
    const pending = h.load();
    settings.update({ reducedMotion: true });
    gate.resolve();
    await pending;
    const runtime = h.runtimes[0];
    expect(h.host.getSnapshot().preferences).toEqual({
      ...DEFAULT_SETTINGS,
      reducedMotion: true,
    });
    const apply = vi.spyOn(runtime, 'setReducedMotion');
    h.store.dispatch({ type: 'PAUSE' });
    const before = runtime.getSnapshot();
    const resources = runtime.getDiagnostics();
    const dispatch = vi.spyOn(h.store, 'dispatch');
    settings.update({ reducedMotion: false });
    expect(apply).toHaveBeenLastCalledWith(false);
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    expect(apply).toHaveBeenLastCalledWith(true);
    expect(h.host.getSnapshot().preferences.reducedMotion).toBe(true);
    settings.update({ reducedMotion: true });
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    expect(apply).toHaveBeenLastCalledWith(true);
    expect(runtime.getSnapshot()).toEqual(before);
    expect(runtime.getDiagnostics()).toEqual(resources);
    expect(dispatch).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);
    await h.host.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]).toEqual(add.mock.calls[0]);
    apply.mockClear();
    media.dispatchEvent(new Event('change'));
    settings.update({ reducedMotion: false });
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies complete subscribed preferences to existing and newly attached input without frame dispatch', async () => {
    const settings = createSettingsStore(() => ({
      getItem: () => null,
      setItem: () => {},
    }));
    const inputs: InputController[] = [];
    const h = await setup({
      settings,
      createInput: (canvas, isPlaying) => {
        const input = new InputController(window, {
          pointerSurface: canvas,
          isPlaying,
        });
        inputs.push(input);
        return input;
      },
    });
    settings.update({
      mouseSteering: false,
      mouseSensitivity: 2,
      invertMouseY: true,
    });
    await h.load();
    const apply = vi.spyOn(inputs[0], 'setPreferences');
    const dispatch = vi.spyOn(h.store, 'dispatch');
    settings.update({ mouseSensitivity: 0.25 });
    expect(apply).toHaveBeenCalledExactlyOnceWith({
      mouseSteering: false,
      mouseSensitivity: 0.25,
      invertMouseY: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
    const previous = h.host.getSnapshot();
    expect(previous.preferences).toEqual(settings.getState().settings);
    expect(Object.isFrozen(previous.preferences)).toBe(true);
    h.host.setContainer(null);
    const set = vi.spyOn(InputController.prototype, 'setPreferences');
    h.host.setContainer(h.container);
    expect(set).toHaveBeenCalledWith({
      mouseSteering: false,
      mouseSensitivity: 0.25,
      invertMouseY: true,
    });
    await h.host.dispose();
    set.mockClear();
    settings.update({ mouseSteering: true });
    expect(set).not.toHaveBeenCalled();
    expect(previous.preferences.mouseSteering).toBe(false);
  });

  it('explicit modal ownership and prevented Escape block host resume and gameplay keys', async () => {
    const h = await setup();
    await h.load();
    h.host.setSettingsOpen(true);
    const before = h.host.getSnapshot();
    key('Space');
    key('ArrowUp');
    h.frame(17);
    expect(h.host.getSnapshot().player?.dashEnergy).toBe(
      before.player?.dashEnergy,
    );
    h.host.setSettingsOpen(false);
    h.store.dispatch({ type: 'PAUSE' });
    const event = new KeyboardEvent('keydown', {
      code: 'Escape',
      cancelable: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(h.store.getState().screen).toBe('paused');
    h.host.setSettingsOpen(true);
    key('Escape');
    expect(h.store.getState().screen).toBe('paused');
    h.host.setSettingsOpen(false);
    key('Escape');
    expect(h.store.getState().screen).toBe('playing');
  });

  it('pauses for back-forward cache navigation and retains a resumable owner', async () => {
    const h = await setup();
    await h.load();
    window.dispatchEvent(
      new PageTransitionEvent('pagehide', { persisted: true }),
    );
    expect(h.store.getState().screen).toBe('paused');
    expect(h.renderer.dispose).not.toHaveBeenCalled();
    h.store.dispatch({ type: 'RESUME' });
    h.frame(17);
    expect(h.host.getSnapshot().race?.status).toBe('running');
  });

  it('disposes the host and surface on a noncached page exit', async () => {
    const h = await setup();
    await h.load();
    window.dispatchEvent(
      new PageTransitionEvent('pagehide', { persisted: false }),
    );
    await h.host.whenIdle();
    expect(h.host.getSnapshot().lifecycle).toBe('disposed');
    expect(h.frames.size).toBe(0);
    expect(h.container.childElementCount).toBe(0);
  });

  it('loads one canvas and RAF, starts the real scene and ignores HUD updates', async () => {
    const h = await setup();
    await h.load();
    expect(h.store.getState().screen).toBe('playing');
    expect(h.container.querySelectorAll('canvas')).toHaveLength(1);
    expect(h.frames.size).toBe(1);
    h.store.dispatch({
      type: 'PRESENTATION_UPDATED',
      presentation: {
        elapsedMs: 0,
        checkpointIndex: 0,
        checkpointCount: 2,
        pearlCount: 0,
        dashRatio: 1,
      },
    });
    await h.host.whenIdle();
    expect(h.createRenderer).toHaveBeenCalledTimes(1);
    expect(h.loadCourse).toHaveBeenCalledTimes(1);
    expect(h.runtimes[0].getSnapshot().race.status).toBe('running');
  });

  it('keeps queued edges on zero-step frames and consumes them once per fixed step', async () => {
    const h = await setup();
    await h.load();
    expect(h.frames.size).toBe(1);
    const step = vi.spyOn(h.runtimes[0], 'step');
    key('Space');
    h.frame(4);
    expect(step).not.toHaveBeenCalled();
    h.frame(80);
    expect(step).toHaveBeenCalledTimes(5);
    expect(step.mock.calls.map(([input]) => input.dashPressed)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(step.mock.calls.every(([, dt]) => dt === 1 / 60)).toBe(true);
  });

  it('Escape pauses once during catchup and resumes excluding wall time and held input', async () => {
    const h = await setup();
    await h.load();
    expect(h.frames.size).toBe(1);
    const runtime = h.runtimes[0];
    const step = vi.spyOn(runtime, 'step');
    const pause = vi.spyOn(runtime, 'pause');
    key('KeyW');
    key('Space');
    key('Escape');
    h.frame(100);
    expect(step).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
    expect(h.store.getState().screen).toBe('paused');
    const snapshot = runtime.getSnapshot();
    h.frame(10_000);
    expect(runtime.getSnapshot()).toEqual(snapshot);
    key('Escape', 'keyup');
    key('Escape');
    expect(h.store.getState().screen).toBe('playing');
    h.frame(17);
    expect(step).toHaveBeenCalledTimes(2);
    expect(step.mock.lastCall?.[0]).toMatchObject({
      throttle: 0,
      dashPressed: false,
      pausePressed: false,
    });
    expect(runtime.getSnapshot().race.elapsedMs).toBeCloseTo(1000 / 60);
  });

  it.each(['blur', 'visibilitychange'])(
    'auto-pauses on %s and UI resume resets timing',
    async (event) => {
      const h = await setup();
      await h.load();
      expect(h.store.getState().screen).toBe('playing');
      if (event === 'visibilitychange')
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      (event === 'blur' ? window : document).dispatchEvent(new Event(event));
      expect(h.store.getState().screen).toBe('paused');
      expect(h.runtimes[0].getSnapshot().race.status).toBe('paused');
      vi.restoreAllMocks();
      h.elapse(60_000);
      h.store.dispatch({ type: 'RESUME' });
      h.frame(17);
      expect(h.runtimes[0].getSnapshot().race.elapsedMs).toBeCloseTo(1000 / 60);
      h.store.dispatch({ type: 'PAUSE' });
      expect(h.runtimes[0].getSnapshot().race.status).toBe('paused');
    },
  );

  it('presents then renders outside React and throttles presentation to at most 10 Hz', async () => {
    const h = await setup();
    await h.load();
    expect(h.frames.size).toBe(1);
    const present = vi.spyOn(h.runtimes[0], 'present');
    const dispatch = vi.spyOn(h.store, 'dispatch');
    for (let index = 0; index < 125; index++) h.frame(8);
    const updates = dispatch.mock.calls.filter(
      ([action]) => action.type === 'PRESENTATION_UPDATED',
    );
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.length).toBeLessThanOrEqual(10);
    expect(present).toHaveBeenCalledTimes(125);
    expect(
      vi.mocked(h.renderer.render).mock.invocationCallOrder.at(-1),
    ).toBeGreaterThan(present.mock.invocationCallOrder.at(-1)!);
    expect(h.store.getState().presentation?.elapsedMs).toBeGreaterThan(850);
  });

  it('clamps DPR, updates projection, and waits through zero initial dimensions', async () => {
    const h = await setup();
    h.resize({ width: 0, height: 0, dpr: 4 });
    await h.load();
    expect(h.store.getState().screen).toBe('playing');
    h.frame(17);
    expect(h.renderer.setSize).not.toHaveBeenCalled();
    expect(h.renderer.render).not.toHaveBeenCalled();
    expect(
      h.runtimes[0].camera.projectionMatrix.elements.every(Number.isFinite),
    ).toBe(true);
    h.resize({ width: 900, height: 600, dpr: 4 });
    h.frame(17);
    expect(h.renderer.setPixelRatio).toHaveBeenLastCalledWith(2);
    expect(h.renderer.setSize).toHaveBeenLastCalledWith(900, 600, false);
    expect(h.runtimes[0].camera.aspect).toBe(1.5);
    expect(h.renderer.render).toHaveBeenCalled();
  });

  it('stops and releases all owners on return to title', async () => {
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const h = await setup();
    await h.load();
    expect(h.frames.size).toBe(1);
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    expect(h.frames.size).toBe(0);
    expect(h.disconnect).toHaveBeenCalledOnce();
    expect(h.renderer.dispose).toHaveBeenCalledOnce();
    expect(h.renderer.forceContextLoss).toHaveBeenCalledOnce();
    expect(h.container.childElementCount).toBe(0);
    expect(h.runtimes[0].getDiagnostics().lifecycle).toBe('disposed');
    expect(removeWindow.mock.calls.map(([type]) => type)).toContain('keydown');
    expect(removeDocument.mock.calls.map(([type]) => type)).toContain(
      'visibilitychange',
    );
    expect(h.host.getSnapshot().player).toBeNull();
  });

  it.each(['init', 'render'])(
    'surfaces real renderer %s failure and stops the loop',
    async (phase) => {
      const h = await setup(
        phase === 'init'
          ? {
              createRenderer: () =>
                Promise.reject(new Error('WebGL init unavailable')),
            }
          : {},
      );
      if (phase === 'render')
        vi.mocked(h.renderer.render).mockImplementation(() => {
          throw new Error('WebGL render unavailable');
        });
      await h.load();
      h.frame(17);
      expect(h.store.getState().screen).toBe('error');
      expect(h.store.getState().error?.detail).toContain(
        `WebGL ${phase} unavailable`,
      );
      expect(h.frames.size).toBe(0);
      expect(h.container.childElementCount).toBe(0);
      if (phase === 'render')
        expect(h.runtimes[0].getDiagnostics().lifecycle).toBe('disposed');
    },
  );
});

describe('Escape on focused UI controls', () => {
  it('pauses from the focused HUD button without double-pausing the real scene', async () => {
    const user = userEvent.setup();
    const h = await setup();
    await h.load();
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    expect(document.activeElement).toBe(button);
    const pause = vi.spyOn(h.runtimes[0], 'pause');
    await user.keyboard('[Escape]');
    h.frame(100);
    expect(h.store.getState().screen).toBe('paused');
    expect(h.host.getSnapshot().race).toMatchObject({
      status: 'paused',
      elapsedMs: 0,
    });
    expect(h.host.getSnapshot().frame.steps).toBe(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it('resumes from a focused pause button and ignores held Escape repeats in both directions', async () => {
    const user = userEvent.setup();
    const h = await setup();
    await h.load();
    h.store.dispatch({ type: 'PAUSE' });
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    const repeat = () =>
      button.dispatchEvent(
        new KeyboardEvent('keydown', {
          code: 'Escape',
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    repeat();
    expect(h.store.getState().screen).toBe('paused');
    h.elapse(60_000);
    await user.keyboard('[Escape]');
    expect(h.store.getState().screen).toBe('playing');
    h.frame(17);
    expect(h.host.getSnapshot().race?.elapsedMs).toBeCloseTo(1000 / 60);
    button.focus();
    repeat();
    h.frame(17);
    expect(h.store.getState().screen).toBe('playing');
    expect(h.host.getSnapshot().race?.status).toBe('running');
  });

  it.each(['[Space]', '[Enter]'])(
    'preserves %s activation of focused pause and resume buttons without queuing dash',
    async (activation) => {
      const user = userEvent.setup();
      const h = await setup();
      await h.load();
      const button = document.createElement('button');
      button.addEventListener('click', () => {
        h.store.dispatch({
          type: h.store.getState().screen === 'playing' ? 'PAUSE' : 'RESUME',
        });
      });
      document.body.append(button);
      const events: KeyboardEvent[] = [];
      button.addEventListener('keydown', (event) => events.push(event));
      button.focus();
      await user.keyboard(activation);
      expect(h.store.getState().screen).toBe('paused');
      button.focus();
      await user.keyboard(activation);
      expect(h.store.getState().screen).toBe('playing');
      const step = vi.spyOn(h.runtimes[0], 'step');
      h.frame(17);
      expect(step.mock.lastCall?.[0]).toMatchObject({
        dashPressed: false,
        pausePressed: false,
      });
      expect(events.every((event) => !event.defaultPrevented)).toBe(true);
    },
  );

  it.each([
    'input',
    'textarea',
    'select',
    'contenteditable',
    'editable-button',
  ])('excludes %s from Escape pause and resume', async (kind) => {
    const user = userEvent.setup();
    const h = await setup();
    await h.load();
    const root = document.createElement(
      kind === 'contenteditable' || kind === 'editable-button' ? 'div' : kind,
    );
    let target = root;
    if (kind === 'contenteditable' || kind === 'editable-button') {
      root.setAttribute('contenteditable', 'true');
      if (kind === 'editable-button') {
        target = document.createElement('button');
        root.append(target);
      }
    }
    document.body.append(root);
    target.focus();
    expect(document.activeElement).toBe(target);
    await user.keyboard('[Escape]');
    h.frame(17);
    expect(h.store.getState().screen).toBe('playing');
    h.store.dispatch({ type: 'PAUSE' });
    target.focus();
    await user.keyboard('[Escape]');
    h.frame(100);
    expect(h.store.getState().screen).toBe('paused');
  });
});

describe('focus at asynchronous readiness', () => {
  it.each(['course', 'scene', 'renderer'])(
    'pauses a real scene at zero elapsed after blur while %s creation is pending',
    async (phase) => {
      const entered = deferred<void>();
      const gate = deferred<void>();
      let focused = true;
      async function wait(stage: string) {
        if (phase === stage) {
          entered.resolve();
          await gate.promise;
        }
      }
      const h: Awaited<ReturnType<typeof setup>> = await setup({
        isFocused: () => focused,
        loadCourse: async () => {
          await wait('course');
          return definition();
        },
        createScene: async (course) => {
          await wait('scene');
          return realScene(course);
        },
        createRenderer: async () => {
          await wait('renderer');
          return h.renderer;
        },
      });
      const loading = h.load();
      await entered.promise;
      expect(document.hidden).toBe(false);
      focused = false;
      window.dispatchEvent(new Event('blur'));
      gate.resolve();
      await loading;
      expect(h.store.getState().screen).toBe('paused');
      expect(h.host.getSnapshot().race).toMatchObject({
        status: 'paused',
        elapsedMs: 0,
      });
      h.frame(100);
      h.frame(60_000);
      expect(h.host.getSnapshot().race?.elapsedMs).toBe(0);
      expect(h.host.getSnapshot().frame.steps).toBe(0);
      focused = true;
      window.dispatchEvent(new Event('focus'));
      h.frame(100);
      expect(h.store.getState().screen).toBe('paused');
      expect(h.host.getSnapshot().race?.elapsedMs).toBe(0);
      h.store.dispatch({ type: 'RESUME' });
      h.frame(17);
      expect(h.host.getSnapshot().race?.elapsedMs).toBeCloseTo(1000 / 60);
      expect(h.frames.size).toBe(1);
    },
  );

  it('uses actual document focus before attachment even without a delivered blur event', async () => {
    const h = await setup({ isFocused: undefined });
    const hasFocus = vi
      .spyOn(document, 'hasFocus')
      .mockImplementation(
        () => document.activeElement === h.renderer.domElement,
      );
    expect(document.hidden).toBe(false);
    expect(document.hasFocus()).toBe(false);
    await h.load();
    expect(hasFocus).toHaveBeenCalled();
    expect(h.store.getState().screen).toBe('paused');
    h.frame(100);
    expect(h.host.getSnapshot().frame.steps).toBe(0);
    expect(h.host.getSnapshot().race?.elapsedMs).toBe(0);
    h.store.dispatch({ type: 'RESUME' });
    h.frame(17);
    expect(h.host.getSnapshot().race?.elapsedMs).toBeCloseTo(1000 / 60);
  });

  it('balances focus-loss listeners across pause, reattachment, reload and disposal', async () => {
    const addWindow = vi.spyOn(window, 'addEventListener');
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const addDocument = vi.spyOn(document, 'addEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const h = await setup({ isFocused: () => false });
    await h.load();
    h.host.setContainer(null);
    h.host.setContainer(h.container);
    const pause = vi.spyOn(h.runtimes[0], 'pause');
    h.store.dispatch({ type: 'RESUME' });
    window.dispatchEvent(new Event('blur'));
    expect(pause).toHaveBeenCalledTimes(1);
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    await h.load();
    await h.host.dispose();
    for (const type of ['blur', 'focus', 'keydown', 'keyup', 'pagehide']) {
      const added = addWindow.mock.calls.filter(([name]) => name === type);
      const removed = removeWindow.mock.calls.filter(([name]) => name === type);
      expect(removed).toHaveLength(added.length);
      for (const [, listener] of added)
        expect(
          removed.filter(([, candidate]) => candidate === listener),
        ).toHaveLength(
          added.filter(([, candidate]) => candidate === listener).length,
        );
    }
    expect(
      removeDocument.mock.calls.filter(([type]) => type === 'visibilitychange'),
    ).toEqual(
      addDocument.mock.calls.filter(([type]) => type === 'visibilitychange'),
    );
  });
});

describe('async cancellation and retained cleanup', () => {
  it('retains a construction cleanup owner from a failed surface reattachment', async () => {
    const release = vi.fn();
    const owner = new ConstructionCleanupError(
      new Error('input construction'),
      [new Error('input rollback')],
      [release],
      'input owner',
    );
    let constructions = 0;
    const { InputController } =
      await import('../../src/game/input/InputController');
    const h = await setup({
      createInput: (canvas, isPlaying) => {
        if (++constructions === 2) throw owner;
        return new InputController(window, {
          pointerSurface: canvas,
          isPlaying,
        });
      },
    });
    await h.load();
    h.host.setContainer(null);
    h.host.setContainer(h.container);
    expect(h.store.getState().screen).toBe('error');
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(1);
    expect(release).not.toHaveBeenCalled();
    h.host.retryCleanup();
    expect(release).toHaveBeenCalledOnce();
  });

  it('continues independent cleanup when cancelling RAF throws and retains a retry', async () => {
    const cancel = vi.fn<(_: number) => void>(() => {
      throw new Error('cancel failed');
    });
    const h = await setup({ cancelFrame: cancel });
    await h.load();
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    expect(h.renderer.dispose).toHaveBeenCalledOnce();
    expect(h.disconnect).toHaveBeenCalledOnce();
    expect(h.runtimes[0].getDiagnostics().lifecycle).toBe('disposed');
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(1);
    cancel.mockImplementation(() => {});
    h.host.retryCleanup();
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(0);
  });

  it('ignores a stale queued RAF callback after a new course starts', async () => {
    const h = await setup();
    await h.load();
    const oldCallback = [...h.frames.values()][0];
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    await h.load();
    const before = h.host.getSnapshot();
    oldCallback(100);
    expect(h.host.getSnapshot()).toEqual(before);
    expect(h.frames.size).toBe(1);
  });

  it('settles a cancelled load despite failed scene cleanup and can load after explicit retry', async () => {
    const waiting = deferred<HostRenderer>();
    const entered = deferred<void>();
    const runtime = { ...(await realScene(definition())) };
    const dispose = vi.spyOn(runtime, 'dispose').mockImplementation(() => {
      throw new Error('scene retained');
    });
    const factory = vi.fn(async () => {
      entered.resolve();
      return waiting.promise;
    });
    const h = await setup({
      createScene: () => Promise.resolve(runtime),
      createRenderer: factory,
    });
    const load = h.load();
    await entered.promise;
    h.host.setContainer(null);
    waiting.reject(new Error('renderer cancelled'));
    await expect(load).resolves.toBeUndefined();
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(1);
    dispose.mockRestore();
    h.host.retryCleanup();
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    h.host.setContainer(h.container);
    // A fresh renderer failure must run rather than inheriting a rejected promise tail.
    await h.load();
    expect(h.store.getState().screen).toBe('error');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('retains failed renderer disposal but still releases its context and scene', async () => {
    const h = await setup();
    await h.load();
    vi.mocked(h.renderer.dispose).mockImplementation(() => {
      throw new Error('renderer retained');
    });
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    expect(h.renderer.forceContextLoss).toHaveBeenCalledOnce();
    expect(h.runtimes[0].getDiagnostics().lifecycle).toBe('disposed');
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(1);
    vi.mocked(h.renderer.dispose).mockImplementation(() => {});
    h.host.retryCleanup();
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(0);
  });

  it('does not construct after a stale course definition resolves', async () => {
    const waiting = deferred<ReturnType<typeof definition>>();
    const createScene = vi.fn(realScene);
    const h = await setup({ loadCourse: () => waiting.promise, createScene });
    const load = h.load();
    await Promise.resolve();
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    waiting.resolve(definition());
    await load;
    expect(createScene).not.toHaveBeenCalled();
    expect(h.createRenderer).not.toHaveBeenCalled();
    expect(h.store.getState().screen).toBe('title');
  });

  it('disposes a late-created scene without attaching or notifying ready', async () => {
    const waiting = deferred<SceneRuntime>();
    const entered = deferred<void>();
    const h = await setup({
      createScene: () => {
        entered.resolve();
        return waiting.promise;
      },
    });
    const load = h.load();
    await entered.promise;
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    const runtime = await realScene(definition());
    waiting.resolve(runtime);
    await load;
    expect(runtime.getDiagnostics().lifecycle).toBe('disposed');
    expect(h.store.getState().screen).toBe('title');
    expect(h.container.childElementCount).toBe(0);
  });

  it('serializes overlap so a late renderer is released before the next is created', async () => {
    const waiting = deferred<HostRenderer>();
    const entered = deferred<void>();
    const factory = vi.fn(async () => {
      if (factory.mock.calls.length === 1) {
        entered.resolve();
        return waiting.promise;
      }
      expect(h.renderer.dispose).toHaveBeenCalledOnce();
      return { ...h.renderer, domElement: document.createElement('canvas') };
    });
    const h: Awaited<ReturnType<typeof setup>> = await setup({
      createRenderer: factory,
    });
    void h.load();
    await entered.promise;
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    const next = h.load();
    waiting.resolve(h.renderer);
    await next;
    expect(factory).toHaveBeenCalledTimes(2);
    expect(h.container.querySelectorAll('canvas')).toHaveLength(1);
    expect(h.frames.size).toBe(1);
    expect(h.store.getState().screen).toBe('playing');
  });

  it('retains failed stale construction cleanup without implicitly retrying the child', async () => {
    const waiting = deferred<SceneRuntime>();
    const entered = deferred<void>();
    const retry = vi.fn<() => void>(() => {
      throw new Error('child still owns world');
    });
    const owner = new ConstructionCleanupError(
      new Error('build failed'),
      [new Error('rollback failed')],
      [retry],
      'retained child',
    );
    const h = await setup({
      createScene: () => {
        entered.resolve();
        return waiting.promise;
      },
    });
    const load = h.load();
    await entered.promise;
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    waiting.reject(owner);
    await load;
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(1);
    expect(retry).not.toHaveBeenCalled();
    expect(() => h.host.retryCleanup()).toThrow();
    expect(retry).toHaveBeenCalledOnce();
    retry.mockImplementation(() => {});
    h.host.retryCleanup();
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(0);
  });

  it('retains failed scene disposal, tries independent renderer cleanup, and blocks replacement', async () => {
    const h = await setup();
    await h.load();
    expect(h.store.getState().screen).toBe('playing');
    const runtime = h.runtimes[0];
    const originalDispose = runtime.dispose.bind(runtime);
    const dispose = vi.spyOn(runtime, 'dispose').mockImplementation(() => {
      throw new Error('world child retained');
    });
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    expect(h.renderer.dispose).toHaveBeenCalledOnce();
    expect(h.renderer.forceContextLoss).toHaveBeenCalledOnce();
    expect(h.frames.size).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(1);
    expect(h.store.getState().screen).toBe('error');
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    await h.load();
    expect(h.createRenderer).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    dispose.mockImplementation(originalDispose);
    h.host.retryCleanup();
    expect(runtime.getDiagnostics().lifecycle).toBe('disposed');
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(0);
  });
});

describe('coordinated monotonic persistence through real finishes', () => {
  const latest = {
    version: 1,
    courses: {
      'sunlit-shoals': {
        bestElapsedMs: 0.001,
        bestMedal: 'silver',
        bestPearlCount: 4,
      },
      kelpworks: {
        bestElapsedMs: 20,
        bestMedal: 'bronze',
        bestPearlCount: 5,
      },
    },
  };
  const expected = {
    ...latest,
    courses: {
      ...latest.courses,
      'sunlit-shoals': {
        ...latest.courses['sunlit-shoals'],
        bestMedal: 'gold',
      },
    },
  };

  function memory(initial: unknown = { version: 1, courses: {} }) {
    const state: { raw: string | null; readable: boolean; writable: boolean } =
      {
        raw: JSON.stringify(initial),
        readable: true,
        writable: true,
      };
    const storage: StorageLike = {
      getItem: vi.fn(() => {
        if (!state.readable) throw new Error('read denied');
        return state.raw;
      }),
      setItem: vi.fn<StorageLike['setItem']>((_key, value) => {
        if (!state.writable) throw new Error('quota exceeded');
        state.raw = value;
      }),
    };
    return {
      state,
      storage,
      provider: () => storage,
      read: () => {
        if (state.raw === null) throw new Error('Expected persisted progress.');
        return parseProgress(JSON.parse(state.raw));
      },
    };
  }

  const finishCourse = () => Promise.resolve(definition(true));

  function finish(h: Awaited<ReturnType<typeof setup>>) {
    key('KeyW');
    h.frame(100);
    expect(h.store.getState().screen).toBe('results');
    expect(h.store.getState().result).toMatchObject({ medal: 'gold' });
  }

  it('reconciles newer stored records, cached history and the actual earned result', async () => {
    const prior = {
      version: 1,
      courses: {
        'sunlit-shoals': {
          ...latest.courses['sunlit-shoals'],
          bestElapsedMs: 0.0001,
          bestPearlCount: 2,
        },
        'blacksmoker-run': {
          bestElapsedMs: 90,
          bestMedal: null,
          bestPearlCount: 3,
        },
      },
    };
    const m = memory(prior);
    const h = await setup({ loadCourse: finishCourse, storage: m.provider });
    await h.load();
    m.state.raw = JSON.stringify(latest);
    finish(h);
    await h.host.whenIdle();
    expect(m.read()).toEqual({
      version: 1,
      courses: {
        ...expected.courses,
        'sunlit-shoals': {
          ...expected.courses['sunlit-shoals'],
          bestElapsedMs: 0.0001,
        },
        'blacksmoker-run': prior.courses['blacksmoker-run'],
      },
    });
    expect(h.store.getState().progress).toEqual(m.read());
    expect(h.store.getState().progressNotice).toBeNull();
  });

  it.each(['unavailable', 'invalid'])(
    'reconciles newly valid storage after %s startup instead of blindly overwriting or staying disabled',
    async (startup) => {
      const m = memory();
      if (startup === 'unavailable') m.state.readable = false;
      else m.state.raw = '{broken';
      const h = await setup({ loadCourse: finishCourse, storage: m.provider });
      await h.load();
      expect(h.store.getState().progressNotice).toMatch(/session.only/i);
      m.state.readable = true;
      m.state.raw = JSON.stringify(latest);
      finish(h);
      await h.host.whenIdle();
      expect(m.read()).toEqual(expected);
      expect(h.store.getState().progressNotice).toBeNull();
    },
  );

  it.each(['{broken', '{"version":99,"precious":"keep"}'])(
    'preserves newly invalid raw storage despite valid startup: %s',
    async (raw) => {
      const m = memory(latest);
      const h = await setup({ loadCourse: finishCourse, storage: m.provider });
      await h.load();
      m.state.raw = raw;
      finish(h);
      await h.host.whenIdle();
      expect(m.state.raw).toBe(raw);
      expect(m.storage.setItem).not.toHaveBeenCalled();
      expect(h.store.getState().progress).toEqual(expected);
      expect(h.store.getState().progressNotice).toMatch(
        /session.only.*invalid.*preserv/i,
      );
    },
  );

  it('retains an unsaved earned run when storage later becomes missing and a second course finishes', async () => {
    const m = memory();
    const h = await setup({
      loadCourse: (courseId) =>
        Promise.resolve(
          parseCourseDefinition({ ...definition(true), courseId }),
        ),
      storage: m.provider,
    });
    await h.load();
    m.state.readable = false;
    finish(h);
    await h.host.whenIdle();
    expect(h.store.getState().progressNotice).toMatch(/session.only/i);
    const first = h.store.getState().progress!.courses['sunlit-shoals'];
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    m.state.readable = true;
    m.state.raw = null;
    await h.load('kelpworks');
    finish(h);
    await h.host.whenIdle();
    expect(m.read().courses).toEqual({
      'sunlit-shoals': first,
      kelpworks: first,
    });
    expect(h.store.getState().progressNotice).toBeNull();
  });

  it.each(['quota', 'acquisition', 'rejection'])(
    'retains earned results and reports session-only progress on %s failure',
    async (failure) => {
      const m = memory(latest);
      const h = await setup({
        loadCourse: finishCourse,
        storage: m.provider,
        coordinateProgress: (save) => {
          if (failure === 'acquisition')
            throw new Error('lock acquisition failed');
          if (failure === 'rejection')
            return Promise.reject(new Error('lock denied'));
          return Promise.resolve().then(save);
        },
      });
      await h.load();
      m.state.writable = failure !== 'quota';
      finish(h);
      await expect(h.host.whenIdle()).resolves.toBeUndefined();
      expect(h.store.getState().progress).toEqual(expected);
      expect(m.read()).toEqual(latest);
      expect(h.store.getState().progressNotice).toMatch(
        /session.only.*could not save/i,
      );
      expect(h.store.getState().screen).toBe('results');
    },
  );

  it('does not persist unsafely when native coordination is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const m = memory();
    const h = await setup({
      loadCourse: finishCourse,
      storage: m.provider,
      coordinateProgress: undefined,
    });
    await h.load();
    finish(h);
    await h.host.whenIdle();
    expect(m.storage.setItem).not.toHaveBeenCalled();
    expect(
      h.store.getState().progress?.courses['sunlit-shoals']?.bestMedal,
    ).toBe('gold');
    expect(h.store.getState().progressNotice).toMatch(
      /session.only.*persist safely/i,
    );
  });

  it('uses the native exclusive storage-key lock with synchronous read/merge/write for competing hosts', async () => {
    const gate = deferred<void>();
    let tail = gate.promise;
    let locked = false;
    const request = vi.fn(
      (name: string, options: { mode: string }, save: () => void) => {
        expect(name).toBe(PROGRESS_STORAGE_KEY);
        expect(options).toEqual({ mode: 'exclusive' });
        const pending = tail.then(() => {
          expect(locked).toBe(false);
          locked = true;
          try {
            expect(save()).toBeUndefined();
          } finally {
            locked = false;
          }
        });
        tail = pending.catch(() => {});
        return pending;
      },
    );
    vi.stubGlobal('navigator', { locks: { request } });
    const m = memory();
    const options: GameHostDependencies = {
      loadCourse: (courseId) =>
        Promise.resolve(
          parseCourseDefinition({ ...definition(true), courseId }),
        ),
      storage: m.provider,
      coordinateProgress: undefined,
    };
    const a = await setup(options);
    const b = await setup(options);
    await a.load();
    await b.load('kelpworks');
    vi.mocked(m.storage.getItem).mockImplementation(() => {
      expect(locked).toBe(true);
      return m.state.raw;
    });
    vi.mocked(m.storage.setItem).mockImplementation((_key, value) => {
      expect(locked).toBe(true);
      m.state.raw = value;
    });
    try {
      finish(a);
      finish(b);
      expect(m.storage.setItem).not.toHaveBeenCalled();
      expect(a.store.getState().progressNotice).toMatch(
        /session.only.*pending/i,
      );
      expect(b.store.getState().progressNotice).toMatch(
        /session.only.*pending/i,
      );
    } finally {
      gate.resolve();
    }
    await Promise.all([a.host.whenIdle(), b.host.whenIdle()]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(Object.keys(m.read().courses).sort()).toEqual([
      'kelpworks',
      'sunlit-shoals',
    ]);
    expect(m.storage.setItem).toHaveBeenCalledTimes(2);
  });

  it.each(['navigation', 'disposal'])(
    'shows results immediately and drains a queued earned save after %s',
    async (exit) => {
      const gate = deferred<void>();
      const m = memory();
      const h = await setup({
        loadCourse: finishCourse,
        storage: m.provider,
        coordinateProgress: async (save) => {
          await gate.promise;
          save();
        },
      });
      await h.load();
      let settled = false;
      let completion: Promise<void> = Promise.resolve();
      try {
        finish(h);
        expect(m.storage.setItem).not.toHaveBeenCalled();
        expect(h.store.getState().progressNotice).toMatch(
          /session.only.*pending/i,
        );
        if (exit === 'navigation')
          h.store.dispatch({ type: 'RETURN_TO_TITLE' });
        completion = (
          exit === 'disposal' ? h.host.dispose() : h.host.whenIdle()
        ).then(() => {
          settled = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(h.container.childElementCount).toBe(0);
      } finally {
        gate.resolve();
      }
      await completion;
      expect(m.read().courses['sunlit-shoals']?.bestMedal).toBe('gold');
      expect(h.store.getState().progressNotice).toBeNull();
      expect(h.store.getState().screen).toBe(
        exit === 'navigation' ? 'title' : 'results',
      );
    },
  );

  it('merges latest session progress inside the first queued critical section, not its old snapshot', async () => {
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const firstWritten = deferred<void>();
    const m = memory();
    let requests = 0;
    const h = await setup({
      loadCourse: (courseId) =>
        Promise.resolve(
          parseCourseDefinition({ ...definition(true), courseId }),
        ),
      storage: m.provider,
      coordinateProgress: async (save) => {
        const first = ++requests === 1;
        await (first ? firstGate : secondGate).promise;
        save();
        if (first) firstWritten.resolve();
      },
    });
    await h.load();
    try {
      finish(h);
      h.store.dispatch({ type: 'RETURN_TO_TITLE' });
      // Readiness cannot wait for a pending save: observe the actual load instead of whenIdle.
      const ready = deferred<void>();
      const unsubscribe = h.store.subscribe(() => {
        if (h.store.getState().screen === 'playing') ready.resolve();
      });
      void h.load('kelpworks');
      await ready.promise;
      unsubscribe();
      finish(h);
      await Promise.resolve();
      expect(requests).toBe(1);
      firstGate.resolve();
      await firstWritten.promise;
      expect(Object.keys(m.read().courses).sort()).toEqual([
        'kelpworks',
        'sunlit-shoals',
      ]);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
    }
    await h.host.whenIdle();
  });

  it('keeps an existing failure notice until a later queued write actually succeeds', async () => {
    const gate = deferred<void>();
    const m = memory();
    m.state.readable = false;
    const h = await setup({
      loadCourse: finishCourse,
      storage: m.provider,
      coordinateProgress: async (save) => {
        await gate.promise;
        save();
      },
    });
    await h.load();
    const notice = h.store.getState().progressNotice;
    m.state.readable = true;
    try {
      finish(h);
      await Promise.resolve();
      expect(h.store.getState().progressNotice).toBe(notice);
      expect(m.storage.setItem).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
    }
    await h.host.whenIdle();
    expect(h.store.getState().progressNotice).toBeNull();
  });
});

describe('terminal progress and diagnostics', () => {
  it('captures finish knowledge before a queued save discovers a better cross-tab record', async () => {
    const gate = deferred<void>();
    const h = await setup({
      loadCourse: () => Promise.resolve(definition(true)),
      coordinateProgress: async (save) => {
        await gate.promise;
        save();
      },
    });
    await h.load();
    key('KeyW');
    h.frame(100);
    const provenance = h.store.getState().achievements;
    try {
      expect(provenance).toMatchObject({
        firstCompletion: true,
        newTimeRecord: false,
        previousBest: null,
        newlyUnlocked: ['kelpworks'],
      });
      expect(Object.isFrozen(provenance)).toBe(true);
      h.storage.set(
        PROGRESS_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          courses: {
            'sunlit-shoals': {
              bestElapsedMs: 0.00001,
              bestMedal: 'gold',
              bestPearlCount: 4,
            },
          },
        }),
      );
    } finally {
      gate.resolve();
    }
    await h.host.whenIdle();
    expect(
      h.store.getState().progress?.courses['sunlit-shoals']?.bestElapsedMs,
    ).toBe(0.00001);
    expect(h.store.getState().achievements).toBe(provenance);
    expect(provenance?.bestAtFinish.bestElapsedMs).toBe(
      h.store.getState().result?.elapsedMs,
    );
  });

  it('persists a generated Sunlit finish through real scene, loader, timing and progression', async () => {
    const { loadCourseDefinition } =
      await import('../../src/game/course/loadCourseDefinition');
    const points = [
      [0, -4, 12],
      [0, -4, 18],
      [5, -4, 36],
      [5, -4, 40],
      [-4, -5, 60],
      [-4, -5, 64],
      [0, -4, 84],
      [0, -4, 93],
    ];
    let waypoint = 0;
    const h: Awaited<ReturnType<typeof setup>> = await setup({
      loadCourse: async (id) =>
        parseCourseDefinition({
          ...(await loadCourseDefinition(id)),
          visuals: generatedSunlit.visuals,
        }),
      createInput: () => ({
        clear: () => {},
        destroy: () => {},
        setPreferences: () => {},
        readFrame: () => {
          const fish = h.host.getSnapshot().player!;
          if (
            waypoint < points.length - 1 &&
            fish.position[2] >= points[waypoint][2]
          )
            waypoint++;
          const [x, y, z] = points[waypoint];
          const dx = x - fish.position[0],
            dy = y - fish.position[1],
            dz = z - fish.position[2];
          const yawError = Math.atan2(
            Math.sin(Math.atan2(dx, dz) - fish.yaw),
            Math.cos(Math.atan2(dx, dz) - fish.yaw),
          );
          return {
            steerX: Math.max(-1, Math.min(1, yawError * 3)),
            steerY: Math.max(
              -1,
              Math.min(1, Math.atan2(dy, Math.hypot(dx, dz)) / (Math.PI / 3)),
            ),
            throttle: -0.3,
            dashPressed: false,
            pausePressed: false,
            brakeHeld: false,
          };
        },
      }),
    });

    await h.load();
    for (
      let frame = 0;
      frame < 3600 && h.store.getState().screen === 'playing';
      frame++
    )
      h.frame(1000 / 60);
    expect(h.store.getState().screen).toBe('results');
    expect(h.store.getState().result).toMatchObject({
      medal: 'bronze',
      pearlCount: 4,
      totalPearls: 4,
    });
    expect(h.store.getState().result?.elapsedMs).toBeCloseTo(21940.483, 3);
    expect(h.host.getSnapshot().frame.steps).toBe(1317);
    expect(h.host.getSnapshot().race?.checkpointIndex).toBe(4);
    await h.host.whenIdle();
    expect(JSON.parse(h.storage.get(PROGRESS_STORAGE_KEY)!)).toEqual(
      h.store.getState().progress,
    );
    expect(unlockedCourseIds(h.store.getState().progress)).toEqual([
      'sunlit-shoals',
      'kelpworks',
    ]);
  });

  describe('host-owned optional audio and step feedback', () => {
    function audioFixture() {
      const context = new FakeContext();
      const construct = vi.fn(() => context);
      const audio = createAudioEngine({
        createContext: construct,
        isUserGesture: () => true,
      });
      const settings = createSettingsStore(() => ({
        getItem: () => null,
        setItem: () => {},
      }));
      settings.update({ musicEnabled: true });
      return { audio, context, construct, settings };
    }

    it('unlocks synchronously from a gesture, reuses one context across three runtimes, and silences navigation', async () => {
      const f = audioFixture();
      const h = await setup(f);
      expect(f.construct).not.toHaveBeenCalled();
      for (let cycle = 0; cycle < 3; cycle++) {
        const unlocking = h.host.unlockAudio();
        expect(f.construct).toHaveBeenCalledTimes(1);
        await h.load();
        await unlocking;
        expect(h.host.getSnapshot().audio).toMatchObject({
          status: 'ready',
          activeAmbience: 1,
        });
        key('Space');
        h.frame(17);
        expect(h.host.getSnapshot().audio.emittedCues.dash).toBe(cycle + 1);
        h.store.dispatch({ type: 'PAUSE' });
        expect(h.host.getSnapshot().audio).toMatchObject({
          activeEffects: 0,
          activeAmbience: 0,
        });
        h.store.dispatch({ type: 'RETURN_TO_TITLE' });
        expect(h.host.getSnapshot().audio).toMatchObject({
          phase: 'idle',
          ownedNodes: 1,
          ownsContext: true,
        });
      }
      await h.host.dispose();
      expect(f.context.closeCalls).toBe(1);
    });

    it('consumes every step event before terminal transition, with one immediate prioritized publication', async () => {
      const f = audioFixture();
      const h = await setup(f);
      await h.host.unlockAudio();
      await h.load();
      const runtime = h.runtimes[0];
      const realStep = runtime.step.bind(runtime);
      let count = 0;
      vi.spyOn(runtime, 'step').mockImplementation((input, dt) => {
        const step = realStep(input, dt);
        count++;
        f.context.currentTime += 0.1;
        if (count === 1)
          return {
            ...step,
            fishEvents: [
              { type: 'dash' },
              { type: 'hazard-entered', colliderHandle: 1 },
            ],
            raceEvents: [
              { type: 'pearl', pearlId: 'one', fraction: 0.5, elapsedMs: 10 },
            ],
          };
        if (count === 2)
          return {
            ...step,
            fishEvents: [
              { type: 'collision', colliderHandle: 1, normal: [0, 1, 0] },
            ],
            raceEvents: [
              {
                type: 'checkpoint',
                checkpointId: 'one',
                checkpointIndex: 1,
                fraction: 1,
                elapsedMs: 20,
              },
            ],
          };
        const result = {
          courseId: 'sunlit-shoals',
          elapsedMs: 30,
          medal: 'gold',
          pearlCount: 1,
          totalPearls: 1,
        } as const;
        return {
          ...step,
          finished: true,
          snapshot: {
            ...step.snapshot,
            race: { ...step.snapshot.race, status: 'finished', result },
          },
          fishEvents: [{ type: 'breach' }, { type: 'splashdown' }],
          raceEvents: [
            {
              type: 'checkpoint',
              checkpointId: 'two',
              checkpointIndex: 2,
              fraction: 1,
              elapsedMs: 30,
            },
            { type: 'finish', result, fraction: 1, elapsedMs: 30 },
          ],
        };
      });
      const play = vi.spyOn(f.audio, 'play');
      const dispatch = vi.spyOn(h.store, 'dispatch');
      h.frame(100);
      expect(count).toBe(3);
      expect(play.mock.calls.map(([cue]) => cue)).toEqual([
        'dash',
        'hazard',
        'pearl',
        'collision',
        'checkpoint',
        'breach',
        'splashdown',
        'checkpoint',
        'finish',
      ]);
      const updates = dispatch.mock.calls.filter(
        ([action]) => action.type === 'PRESENTATION_UPDATED',
      );
      expect(updates).toHaveLength(1);
      expect(h.store.getState().presentation?.feedback?.cue).toBe('finish');
      expect(h.host.getSnapshot().audio).toMatchObject({
        phase: 'results',
        activeAmbience: 0,
        activeEffects: 1,
        emittedCues: { finish: 1, checkpoint: 2 },
      });
      h.frame(100);
      expect(play).toHaveBeenCalledTimes(9);
      h.store.dispatch({ type: 'REPLAY' });
      await h.host.whenIdle();
      expect(h.host.getSnapshot()).toMatchObject({
        feedback: null,
        frame: { steps: 0, rendered: 0 },
      });
      expect(h.store.getState()).toMatchObject({
        result: null,
        achievements: null,
      });
    });

    it('consumes pause-step events before silencing, and retains the 10Hz HUD limit under contact load', async () => {
      const f = audioFixture();
      const h = await setup(f);
      await h.host.unlockAudio();
      await h.load();
      const step = h.runtimes[0].step.bind(h.runtimes[0]);
      vi.spyOn(h.runtimes[0], 'step').mockImplementation((input, dt) => ({
        ...step(input, dt),
        fishEvents: [
          { type: 'collision', colliderHandle: 1, normal: [0, 1, 0] },
        ],
        raceEvents: [],
      }));
      const play = vi.spyOn(f.audio, 'play');
      const dispatch = vi.spyOn(h.store, 'dispatch');
      for (let i = 0; i < 125; i++) h.frame(8);
      expect(play.mock.calls.length).toBe(h.host.getSnapshot().frame.steps);
      expect(
        dispatch.mock.calls.filter(
          ([action]) => action.type === 'PRESENTATION_UPDATED',
        ).length,
      ).toBeLessThanOrEqual(10);
      expect(
        h.store.getState().presentation?.feedback?.announcement,
      ).toBeNull();
      key('Escape');
      h.frame(17);
      expect(play.mock.calls.length).toBe(h.host.getSnapshot().frame.steps);
      expect(h.store.getState().screen).toBe('paused');
      expect(f.audio.getState().activeEffects).toBe(0);
    });

    it.each(['blur', 'visibilitychange', 'pagehide'])(
      'silences finish voices on %s even on results',
      async (event) => {
        const f = audioFixture();
        const h = await setup({
          ...f,
          loadCourse: () => Promise.resolve(definition(true)),
        });
        await h.host.unlockAudio();
        await h.load();
        key('KeyW');
        h.frame(100);
        expect(f.audio.getState().activeEffects).toBe(1);
        if (event === 'visibilitychange') {
          vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
          document.dispatchEvent(new Event(event));
        } else if (event === 'pagehide') {
          window.dispatchEvent(
            new PageTransitionEvent(event, { persisted: true }),
          );
        } else window.dispatchEvent(new Event(event));
        expect(f.audio.getState()).toMatchObject({
          activeEffects: 0,
          activeAmbience: 0,
        });
        expect(h.store.getState().screen).toBe('results');
      },
    );

    it('does not start ambience even briefly when a hidden pending load reaches COURSE_READY', async () => {
      const f = audioFixture();
      const gate = deferred<void>();
      const h = await setup({
        ...f,
        loadCourse: async () => {
          await gate.promise;
          return definition();
        },
      });
      await h.host.unlockAudio();
      const loading = h.load();
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
      gate.resolve();
      await loading;
      expect(h.store.getState().screen).toBe('paused');
      expect(f.context.oscillators).toHaveLength(0);
      expect(f.audio.getState().activeAmbience).toBe(0);
    });

    it('starts close before a withheld save or resume, retains failed audio independently, and supports explicit retry', async () => {
      const f = audioFixture();
      const saveGate = deferred<void>();
      const resumeGate = deferred<void>();
      const h = await setup({
        ...f,
        loadCourse: () => Promise.resolve(definition(true)),
        coordinateProgress: async (save) => {
          await saveGate.promise;
          save();
        },
      });
      await h.host.unlockAudio();
      await h.load();
      key('KeyW');
      h.frame(100);
      expect(f.audio.getState().activeEffects).toBe(1);
      f.context.state = 'suspended';
      f.context.resumeGate = resumeGate;
      const resume = h.host.unlockAudio();
      f.context.closeError = new Error('close withheld');
      let settled = false;
      const disposal = h.host.dispose();
      const observed = disposal.then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        expect(f.context.closeCalls).toBe(1);
        expect(f.audio.getState()).toMatchObject({
          activeEffects: 0,
          activeAmbience: 0,
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(h.storage.has(PROGRESS_STORAGE_KEY)).toBe(false);
        expect(h.host.getSnapshot()).toMatchObject({
          cleanupError: null,
          resources: { pendingCleanup: 0 },
          audio: { status: 'failed', ownsContext: true, pendingCleanup: true },
        });
      } finally {
        saveGate.resolve();
        resumeGate.resolve();
      }
      await resume;
      expect(await observed).toBeInstanceOf(Error);
      expect(h.storage.has(PROGRESS_STORAGE_KEY)).toBe(true);
      expect(h.host.getAudioNotice()).toMatch(/cleanup/i);
      f.context.closeError = null;
      await h.host.retryAudioCleanup();
      expect(h.host.getSnapshot().audio).toMatchObject({
        status: 'disposed',
        ownsContext: false,
        pendingCleanup: false,
      });
      await expect(h.host.dispose()).resolves.toBeUndefined();
      expect(f.context.closeCalls).toBe(2);
    });

    it('clears a failed live audio retry when terminal disposal releases every owner', async () => {
      const f = audioFixture();
      const h = await setup(f);
      await h.host.unlockAudio();
      await h.load();
      key('Space');
      h.frame(17);
      const oscillator = f.context.oscillators.at(-1)!;
      oscillator.disconnectError = new Error('disconnect failed');
      h.store.dispatch({ type: 'PAUSE' });
      await expect(h.host.retryAudioCleanup()).rejects.toBeInstanceOf(
        AggregateError,
      );
      expect(f.audio.getState().pendingCleanup).toBe(true);

      oscillator.disconnectError = null;
      try {
        await expect(h.host.dispose()).resolves.toBeUndefined();
        expect(h.host.getSnapshot().audio).toMatchObject({
          status: 'disposed',
          ownsContext: false,
          ownedNodes: 0,
          pendingCleanup: false,
        });
        await expect(h.host.dispose()).resolves.toBeUndefined();
        expect(f.context.closeCalls).toBe(1);
      } finally {
        await h.host.retryAudioCleanup();
      }
    });

    it('does not block course loading on optional failed node cleanup and exposes a retry notice', async () => {
      const f = audioFixture();
      const h = await setup(f);
      await h.host.unlockAudio();
      await h.load();
      key('Space');
      h.frame(17);
      const oscillator = f.context.oscillators.at(-1)!;
      oscillator.disconnectError = new Error('disconnect failed');
      h.store.dispatch({ type: 'RETURN_TO_TITLE' });
      expect(h.host.getSnapshot().audio.pendingCleanup).toBe(true);
      expect(h.host.getAudioNotice()).toMatch(/audio/i);
      expect(h.host.getSnapshot().cleanupError).toBeNull();
      await h.load();
      expect(h.store.getState().screen).toBe('playing');
      oscillator.disconnectError = null;
      await h.host.retryAudioCleanup();
      expect(f.audio.getState().pendingCleanup).toBe(false);
      await h.host.unlockAudio();
      expect(f.audio.getState().status).toBe('ready');
    });
  });

  it('finishes inside catchup, saves actual results and renders final state without stepping again', async () => {
    const h = await setup({
      loadCourse: () => Promise.resolve(definition(true)),
    });
    await h.load();
    expect(h.store.getState().screen).toBe('playing');
    const step = vi.spyOn(h.runtimes[0], 'step');
    key('KeyW');
    h.frame(100);
    const result = h.runtimes[0].getSnapshot().race.result;
    expect(h.store.getState().result).toEqual(result);
    expect(h.store.getState().screen).toBe('results');
    expect(result).toMatchObject({
      courseId: 'sunlit-shoals',
      medal: 'gold',
      pearlCount: 1,
    });
    expect(step).toHaveBeenCalledTimes(1);
    await h.host.whenIdle();
    const progress = parseProgress(
      JSON.parse(h.storage.get(PROGRESS_STORAGE_KEY)!),
    );
    expect(progress.courses['sunlit-shoals']?.bestElapsedMs).toBe(
      result?.elapsedMs,
    );
    expect(unlockedCourseIds(progress)).toEqual(['sunlit-shoals', 'kelpworks']);
    h.frame(500);
    expect(step).toHaveBeenCalledTimes(1);
    expect(h.renderer.render).toHaveBeenCalledTimes(2);
  });

  it.each(['invalid', 'unavailable', 'quota'])(
    'keeps results usable and labels session-only progress when storage is %s',
    async (mode) => {
      const raw = '{"version":99,"precious":"do not overwrite"}';
      const setItem = vi.fn(() => {
        if (mode === 'quota') throw new Error('quota exceeded');
      });
      const h = await setup({
        loadCourse: () => Promise.resolve(definition(true)),
        storage: () => {
          if (mode === 'unavailable') throw new Error('storage denied');
          return { getItem: () => (mode === 'invalid' ? raw : null), setItem };
        },
      });
      await h.load();
      expect(h.store.getState().screen).toBe('playing');
      key('KeyW');
      h.frame(100);
      expect(h.store.getState().screen).toBe('results');
      await h.host.whenIdle();
      expect(h.store.getState().progressNotice).toMatch(/session.only/i);
      expect(h.store.getState().progressNotice).toMatch(
        mode === 'invalid' ? /invalid.*preserv/i : /save|storage/i,
      );
      expect(h.store.getState().result?.medal).toBe('gold');
      if (mode !== 'quota') expect(setItem).not.toHaveBeenCalled();
    },
  );

  it('loads prior records and retains independently better time and pearl records', async () => {
    const saved = {
      version: 1,
      courses: {
        'sunlit-shoals': {
          bestElapsedMs: 0.001,
          bestMedal: 'bronze',
          bestPearlCount: 4,
        },
      },
    };
    let raw = JSON.stringify(saved);
    const h = await setup({
      loadCourse: () => Promise.resolve(definition(true)),
      storage: () => ({
        getItem: () => raw,
        setItem: (_key, value) => {
          raw = value;
        },
      }),
    });
    await h.load();
    expect(h.store.getState().progress).toEqual(saved);
    key('KeyW');
    h.frame(100);
    await h.host.whenIdle();
    expect(parseProgress(JSON.parse(raw)).courses['sunlit-shoals']).toEqual({
      bestElapsedMs: 0.001,
      bestMedal: 'gold',
      bestPearlCount: 4,
    });
    expect(h.store.getState().progressNotice).toBeNull();
  });

  it('exposes only cloned deeply frozen observations when the test flag is enabled, and removes the hook', async () => {
    vi.stubEnv('VITE_TEST_HOOKS', 'true');
    const h = await setup();
    await h.load();
    expect(window.__REEF_RUSH_TEST__).toBeDefined();
    const hook = window.__REEF_RUSH_TEST__!;
    expect(Object.keys(hook)).toEqual(['getSnapshot']);
    const snapshot = hook.getSnapshot();
    expect(snapshot.player).not.toBeNull();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.player?.position)).toBe(true);
    expect(hook.getSnapshot().player).not.toBe(snapshot.player);
    expect(() =>
      Object.assign(snapshot.player!.position, { 0: 500 }),
    ).toThrow();
    await h.host.dispose();
    expect(window.__REEF_RUSH_TEST__).toBeUndefined();
    expect(h.host.getSnapshot().player).toBeNull();
  });

  it('does not expose the diagnostic global without the build flag', async () => {
    vi.stubEnv('VITE_TEST_HOOKS', '');
    const h = await setup();
    await h.load();
    expect(h.store.getState().screen).toBe('playing');
    expect(window.__REEF_RUSH_TEST__).toBeUndefined();
  });
});
