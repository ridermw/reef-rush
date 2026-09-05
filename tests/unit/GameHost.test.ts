import { afterEach, describe, expect, it, vi } from 'vitest';
import { Material, Mesh } from 'three';
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
  emptyProgress,
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
import * as frameMetricsModule from '../../src/game/core/frameMetrics';
import * as feedbackModule from '../../src/game/core/runFeedback';

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

describe('bounded host diagnostics', () => {
  it('profiles only successful playing frames with runner input, actual dropped time and synchronous work', async () => {
    let clock = 0;
    const h = await setup({ now: () => clock });
    await h.load();
    const present = h.runtimes[0].present.bind(h.runtimes[0]);
    vi.spyOn(h.runtimes[0], 'present').mockImplementation((...args) => {
      clock += 2;
      present(...args);
    });
    vi.mocked(h.renderer.render).mockImplementation(() => {
      clock += 3;
    });
    const dispatch = vi.spyOn(h.store, 'dispatch');
    h.frame(250);
    const diagnostics = h.host.getDiagnostics();
    expect(diagnostics.frame).toEqual({ rendered: 1, steps: 5, profiled: 1 });
    expect(diagnostics.frameMetrics.sampleCount).toBe(1);
    expect(diagnostics.frameMetrics.intervalMs).toEqual({
      mean: 250,
      p95: 250,
      max: 250,
    });
    expect(diagnostics.frameMetrics.cpuWorkMs).toEqual({
      mean: 5,
      p95: 5,
      max: 5,
    });
    expect(diagnostics.frameMetrics.droppedMs!.mean).toBeCloseTo(1000 / 6);
    expect(diagnostics.frameMetrics.droppedSampleCount).toBe(1);
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      'PRESENTATION_UPDATED',
    ]);
    expect(h.host.getSnapshot().frame).toEqual(diagnostics.frame);
  });

  it('retains windows through pause/title/disposal, excludes paused wall time and resets only on fresh load or actual quality change', async () => {
    const settings = createSettingsStore(() => ({
      getItem: () => null,
      setItem: () => {},
    }));
    const h = await setup({ settings });
    await h.load();
    h.frame(17);
    const before = h.host.getDiagnostics();
    h.store.dispatch({ type: 'PAUSE' });
    h.frame(60_000);
    expect(h.host.getDiagnostics().frameMetrics).toEqual(before.frameMetrics);
    expect(h.host.getSnapshot().frame).toEqual({
      rendered: 2,
      steps: 1,
      profiled: 1,
    });
    h.store.dispatch({ type: 'RESUME' });
    h.frame(17);
    expect(h.host.getDiagnostics().frameMetrics.intervalMs).toEqual({
      mean: 17,
      p95: 17,
      max: 17,
    });
    settings.update({ renderQuality: 'high', masterVolume: 0.2 });
    expect(h.host.getDiagnostics().frameMetrics.sampleCount).toBe(2);
    settings.update({ renderQuality: 'low' });
    expect(h.host.getDiagnostics().frameMetrics.sampleCount).toBe(0);
    expect(h.host.getSnapshot().frame.profiled).toBe(2);
    h.frame(0);
    expect(h.host.getDiagnostics().frameMetrics.intervalMs?.mean).toBe(0);
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    expect(h.host.getDiagnostics().frameMetrics.sampleCount).toBe(1);
    await h.load();
    expect(h.host.getDiagnostics().frameMetrics.sampleCount).toBe(0);
    h.frame(17);
    const retained = h.host.getDiagnostics().frameMetrics;
    await h.host.dispose();
    h.frame(17);
    expect(h.host.getDiagnostics().frameMetrics).toEqual(retained);
    expect(h.host.getDiagnostics().lifecycle).toBe('disposed');
  });

  describe('sampling exclusions preserve baseline runtime behavior', () => {
    it.each(['zero-size', 'hidden'] as const)(
      'continues simulation, HUD and input/pause consumption while %s, without profiling',
      async (excluded) => {
        const h = await setup();
        await h.load();
        h.frame(17);
        const before = h.host.getDiagnostics().frameMetrics;
        if (excluded === 'zero-size') h.resize({ width: 0, height: 0, dpr: 1 });
        else vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        // A queued hidden callback is not itself a visibilitychange event.
        const step = vi.spyOn(h.runtimes[0], 'step');
        const dispatch = vi.spyOn(h.store, 'dispatch');
        key('KeyW');
        key('Space');
        h.frame(100);
        expect(step).toHaveBeenCalledTimes(5);
        expect(step.mock.calls.map(([input]) => input.dashPressed)).toEqual([
          true,
          false,
          false,
          false,
          false,
        ]);
        expect(
          step.mock.calls.every(
            ([input, dt]) => input.throttle === 1 && dt === 1 / 60,
          ),
        ).toBe(true);
        expect(h.store.getState().screen).toBe('playing');
        expect(h.store.getState().presentation?.elapsedMs).toBeCloseTo(100);
        expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
          'PRESENTATION_UPDATED',
        ]);
        expect(h.host.getSnapshot().frame).toEqual({
          rendered: excluded === 'hidden' ? 2 : 1,
          steps: 6,
          profiled: 1,
        });
        expect(h.host.getDiagnostics().frameMetrics).toEqual(before);
        expect(h.frames.size).toBe(1);

        key('Escape');
        h.frame(100);
        expect(step).toHaveBeenCalledTimes(6);
        expect(step.mock.lastCall?.[0].pausePressed).toBe(true);
        expect(h.store.getState().screen).toBe('paused');
        expect(h.runtimes[0].getSnapshot().race.status).toBe('paused');
        expect(h.host.getSnapshot().frame).toEqual({
          rendered: excluded === 'hidden' ? 3 : 1,
          steps: 7,
          profiled: 1,
        });
        h.frame(100);
        expect(step).toHaveBeenCalledTimes(6);
        expect(h.host.getSnapshot().frame.rendered).toBe(
          excluded === 'hidden' ? 4 : 1,
        );
        expect(h.host.getDiagnostics().frameMetrics).toEqual(before);
        expect(h.frames.size).toBe(1);
      },
    );

    it.each(['zero-size', 'hidden'] as const)(
      'retains runner fractional time across %s callbacks and surface restoration',
      async (excluded) => {
        const h = await setup();
        await h.load();
        const hidden = vi
          .spyOn(document, 'hidden', 'get')
          .mockReturnValue(false);
        const step = vi.spyOn(h.runtimes[0], 'step');
        h.frame(4);
        const before = h.host.getDiagnostics().frameMetrics;
        if (excluded === 'zero-size') h.resize({ width: 0, height: 0, dpr: 1 });
        else hidden.mockReturnValue(true);
        for (let i = 0; i < 2; i++) {
          h.frame(4);
          expect(h.frames.size).toBe(1);
          expect(h.host.getDiagnostics().frameMetrics).toEqual(before);
        }
        expect(step).not.toHaveBeenCalled();
        expect(h.host.getSnapshot().frame).toEqual({
          rendered: excluded === 'hidden' ? 3 : 1,
          steps: 0,
          profiled: 1,
        });
        hidden.mockReturnValue(false);
        h.resize({ width: 800, height: 400, dpr: 1 });
        h.frame(5);
        expect(step).toHaveBeenCalledTimes(1);
        expect(h.runtimes[0].getSnapshot().race.elapsedMs).toBeCloseTo(
          1000 / 60,
        );
        expect(h.host.getSnapshot().frame).toEqual({
          rendered: excluded === 'hidden' ? 4 : 2,
          steps: 1,
          profiled: 2,
        });
        expect(h.host.getDiagnostics().frameMetrics.intervalMs).toEqual({
          mean: 4.5,
          p95: 5,
          max: 5,
        });
        expect(h.frames.size).toBe(1);
      },
    );

    it.each(['zero-size', 'hidden'] as const)(
      'finishes the baseline render and keeps its chain when %s begins during presentation',
      async (excluded) => {
        const h = await setup();
        await h.load();
        const hidden = vi
          .spyOn(document, 'hidden', 'get')
          .mockReturnValue(false);
        const present = h.runtimes[0].present.bind(h.runtimes[0]);
        vi.spyOn(h.runtimes[0], 'present').mockImplementationOnce((...args) => {
          present(...args);
          if (excluded === 'zero-size')
            h.resize({ width: 0, height: 0, dpr: 1 });
          else hidden.mockReturnValue(true);
        });
        h.frame(17);
        expect(h.renderer.render).toHaveBeenCalledOnce();
        expect(h.host.getSnapshot().frame).toEqual({
          rendered: 1,
          steps: 1,
          profiled: 0,
        });
        expect(h.host.getDiagnostics().frameMetrics.sampleCount).toBe(0);
        expect(h.frames.size).toBe(1);
        hidden.mockReturnValue(false);
        h.resize({ width: 800, height: 400, dpr: 1 });
        h.frame(17);
        expect(h.host.getSnapshot().frame).toEqual({
          rendered: 2,
          steps: 2,
          profiled: 1,
        });
        expect(h.frames.size).toBe(1);
      },
    );

    it('does not retroactively profile a hidden callback when visibility clears during presentation', async () => {
      const h = await setup();
      await h.load();
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      const present = h.runtimes[0].present.bind(h.runtimes[0]);
      vi.spyOn(h.runtimes[0], 'present').mockImplementationOnce((...args) => {
        present(...args);
        hidden.mockReturnValue(false);
      });
      h.frame(17);
      expect(h.host.getSnapshot().frame).toEqual({
        rendered: 1,
        steps: 1,
        profiled: 0,
      });
      expect(h.host.getDiagnostics().frameMetrics.sampleCount).toBe(0);
      expect(h.frames.size).toBe(1);
      h.frame(17);
      expect(h.host.getSnapshot().frame).toEqual({
        rendered: 2,
        steps: 2,
        profiled: 1,
      });
    });

    it('keeps real visibilitychange auto-pause, clears input, and resets only the paused runner before explicit resume', async () => {
      const h = await setup();
      await h.load();
      const step = vi.spyOn(h.runtimes[0], 'step');
      h.frame(8);
      const before = h.host.getDiagnostics().frameMetrics;
      key('KeyW');
      key('Space');
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(h.store.getState().screen).toBe('paused');
      h.frame(1000);
      expect(step).not.toHaveBeenCalled();
      expect(h.host.getSnapshot().frame).toEqual({
        rendered: 2,
        steps: 0,
        profiled: 1,
      });
      expect(h.host.getDiagnostics().frameMetrics).toEqual(before);
      expect(h.frames.size).toBe(1);
      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(h.store.getState().screen).toBe('paused');
      h.elapse(60_000);
      h.store.dispatch({ type: 'RESUME' });
      h.frame(8);
      expect(step).not.toHaveBeenCalled();
      h.frame(9);
      expect(step).toHaveBeenCalledOnce();
      expect(step.mock.lastCall?.[0]).toMatchObject({
        throttle: 0,
        dashPressed: false,
        pausePressed: false,
      });
      expect(h.runtimes[0].getSnapshot().race.elapsedMs).toBeCloseTo(1000 / 60);
      expect(h.host.getDiagnostics().frameMetrics.intervalMs?.max).toBe(9);
      expect(h.host.getSnapshot().frame).toEqual({
        rendered: 4,
        steps: 1,
        profiled: 3,
      });
      expect(h.frames.size).toBe(1);
    });
  });

  it('retains through loss, excludes cancelled callbacks, restores paused and defers backing dimensions', async () => {
    const h = await setup({
      settings: createSettingsStore(() => ({
        getItem: () => null,
        setItem: () => {},
      })),
    });
    await h.load();
    h.renderer.domElement.width = 800;
    h.renderer.domElement.height = 400;
    h.frame(17);
    const old = [...h.frames.values()][0];
    const metrics = h.host.getDiagnostics().frameMetrics;
    h.renderer.domElement.dispatchEvent(
      new Event('webglcontextlost', { cancelable: true }),
    );
    h.elapse(60_000);
    old(60_017);
    expect(h.host.getDiagnostics().frameMetrics).toEqual(metrics);
    h.host.settings.update({ renderQuality: 'low' });
    expect(h.host.getDiagnostics()).toMatchObject({
      graphicsLost: true,
      selectedQuality: 'low',
      backingPixels: { width: 800, height: 400 },
      frameMetrics: { sampleCount: 0 },
    });
    h.renderer.domElement.dispatchEvent(new Event('webglcontextrestored'));
    const pending = [...h.frames.values()];
    old(60_017);
    expect([...h.frames.values()]).toEqual(pending);
    h.frame(17);
    expect(h.host.getDiagnostics().frameMetrics.sampleCount).toBe(0);
    h.store.dispatch({ type: 'RESUME' });
    h.frame(17);
    expect(h.host.getDiagnostics().frameMetrics.intervalMs?.mean).toBe(17);
  });

  it.each(['step', 'present', 'render'] as const)(
    'retains prior metrics when %s fails and never profiles the failed frame',
    async (phase) => {
      const h = await setup();
      await h.load();
      h.frame(17);
      const before = h.host.getDiagnostics().frameMetrics;
      const fail = () => {
        throw new Error('frame failed');
      };
      if (phase === 'render')
        vi.mocked(h.renderer.render).mockImplementationOnce(fail);
      else vi.spyOn(h.runtimes[0], phase).mockImplementationOnce(fail);
      h.frame(17);
      expect(h.store.getState().screen).toBe('error');
      expect(h.host.getDiagnostics().frameMetrics).toEqual(before);
      expect(h.host.getSnapshot().frame.profiled).toBe(1);
      expect(h.frames.size).toBe(0);
    },
  );

  it.each(['pause', 'loss', 'detach', 'title', 'dispose', 'quality'] as const)(
    'rejects a frame invalidated during render by %s',
    async (action) => {
      const h = await setup({
        settings: createSettingsStore(() => ({
          getItem: () => null,
          setItem: () => {},
        })),
      });
      await h.load();
      vi.mocked(h.renderer.render).mockImplementationOnce(() => {
        switch (action) {
          case 'pause':
            h.store.dispatch({ type: 'PAUSE' });
            break;
          case 'loss':
            h.renderer.domElement.dispatchEvent(
              new Event('webglcontextlost', { cancelable: true }),
            );
            break;
          case 'detach':
            h.host.setContainer(null);
            break;
          case 'title':
            h.store.dispatch({ type: 'RETURN_TO_TITLE' });
            break;
          case 'dispose':
            void h.host.dispose();
            break;
          case 'quality':
            h.host.settings.update({ renderQuality: 'low' });
            break;
        }
      });
      h.frame(17);
      expect(h.host.getDiagnostics().frameMetrics.sampleCount).toBe(0);
      expect(h.host.getSnapshot().frame.profiled).toBe(0);
      expect(h.frames.size).toBe(
        action === 'pause' || action === 'quality' ? 1 : 0,
      );
    },
  );

  it('excludes pause input and finished frames, leaving existing step/render behavior intact', async () => {
    const h = await setup();
    await h.load();
    key('Escape');
    h.frame(100);
    expect(h.host.getSnapshot().frame).toEqual({
      rendered: 1,
      steps: 1,
      profiled: 0,
    });
    expect(h.host.getDiagnostics().frameMetrics.sampleCount).toBe(0);
    const finished = await setup({
      loadCourse: () => Promise.resolve(definition(true)),
    });
    await finished.load();
    key('KeyW');
    finished.frame(100);
    expect(finished.store.getState().screen).toBe('results');
    expect(finished.host.getDiagnostics().frameMetrics.sampleCount).toBe(0);
  });

  it('ignores stale callbacks after fresh load without changing counters, summaries or scheduling', async () => {
    const h = await setup();
    await h.load();
    const stale = [...h.frames.values()][0];
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    await h.load();
    const before = h.host.getDiagnostics();
    const pending = [...h.frames.values()];
    stale(60_000);
    expect(h.host.getDiagnostics()).toEqual(before);
    expect([...h.frames.values()]).toEqual(pending);
  });

  it('projects primitives before freezing without reading opaque payloads, storage, feedback, timers or full snapshots', async () => {
    const audio = createAudioEngine();
    const feedback = feedbackModule.createRunFeedback();
    vi.spyOn(feedbackModule, 'createRunFeedback').mockReturnValue(feedback);
    const storage = vi.fn(() => ({ getItem: () => null, setItem: () => {} }));
    const now = vi.fn(() => 0);
    const h = await setup({ audio, storage, now });
    await h.load();
    h.frame(17);
    feedback.consume([{ type: 'dash' }], [], 0);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const trap = vi.fn(() => {
      throw new Error('opaque data accessed');
    });
    Object.defineProperty(cyclic, 'secret', { enumerable: true, get: trap });
    const audioState = { ...audio.getState(), cause: cyclic };
    for (const key of ['cleanupErrors', 'observerErrors', 'notice'])
      Object.defineProperty(audioState, key, { get: trap, enumerable: true });
    vi.spyOn(audio, 'getState').mockReturnValue(audioState);
    const audioSnapshot = vi
      .spyOn(audio, 'getSnapshot')
      .mockImplementation(trap);
    const fullSnapshot = vi
      .spyOn(h.host, 'getSnapshot')
      .mockImplementation(trap);
    const sceneSnapshot = vi
      .spyOn(h.runtimes[0], 'getSnapshot')
      .mockImplementation(trap);
    const feedbackRead = vi.spyOn(feedback, 'getState');
    const dispatch = vi.spyOn(h.store, 'dispatch');
    const timer = vi.spyOn(window, 'setInterval');
    const timeout = vi.spyOn(window, 'setTimeout');
    const context = vi
      .spyOn(h.renderer.domElement, 'getContext')
      .mockImplementation(trap);
    storage.mockClear();
    now.mockClear();
    const detachedRead = h.host.getDiagnostics;
    const first = detachedRead();
    expect(detachedRead()).toEqual(first);
    expect(first.resources.scene).toEqual(h.runtimes[0].getDiagnostics());
    expect(first.audio).toEqual({
      status: audioState.status,
      phase: audioState.phase,
      contextState: audioState.contextState,
      ownsContext: audioState.ownsContext,
      ownedNodes: audioState.ownedNodes,
      activeEffects: audioState.activeEffects,
      activeAmbience: audioState.activeAmbience,
      pendingUnlock: audioState.pendingUnlock,
      pendingCleanup: audioState.pendingCleanup,
    });
    function assertPrimitiveTree(value: unknown) {
      if (value === null || typeof value !== 'object') return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) {
        expect(['object', 'string', 'number', 'boolean']).toContain(
          typeof child,
        );
        assertPrimitiveTree(child);
      }
    }
    assertPrimitiveTree(first);
    expect(Object.keys(first).sort()).toEqual([
      'audio',
      'backingPixels',
      'cleanup',
      'frame',
      'frameMetrics',
      'graphicsLost',
      'lifecycle',
      'resources',
      'screen',
      'selectedQuality',
    ]);
    for (const spy of [
      trap,
      storage,
      now,
      feedbackRead,
      dispatch,
      timer,
      timeout,
      context,
      audioSnapshot,
      fullSnapshot,
      sceneSnapshot,
    ])
      expect(spy).not.toHaveBeenCalled();
    expect(feedback.getState(1)?.cue).toBe('dash');
  });

  it('does not summarize during collection or ordinary acceptance snapshots', async () => {
    const metrics = frameMetricsModule.createFrameMetrics();
    vi.spyOn(frameMetricsModule, 'createFrameMetrics').mockReturnValue(metrics);
    const summarize = vi.spyOn(metrics, 'getSnapshot');
    const h = await setup();
    await h.load();
    for (let i = 0; i < 10; i++) {
      h.frame(17);
      h.host.getSnapshot();
    }
    expect(summarize).not.toHaveBeenCalled();
    expect(h.host.getDiagnostics().frameMetrics.sampleCount).toBe(10);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it('distinguishes cleared active resources from retained failed release owners without examining errors', async () => {
    const h = await setup();
    await h.load();
    vi.mocked(h.renderer.dispose).mockImplementationOnce(() => {
      throw new Error('retained renderer');
    });
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    const diagnostics = h.host.getDiagnostics();
    expect(diagnostics).toMatchObject({
      lifecycle: 'cleanup-pending',
      cleanup: {
        pendingReleases: 1,
        constructionOwners: 0,
        failed: true,
        audioFailed: false,
      },
      resources: { canvases: 0, rafChains: 0, pendingCleanup: 1, scene: null },
      backingPixels: null,
    });
    h.host.retryCleanup();
    expect(diagnostics.cleanup.pendingReleases).toBe(1);
    expect(h.host.getDiagnostics().cleanup.pendingReleases).toBe(0);
  });
});

describe('retained render quality sizing', () => {
  function preferences() {
    return createSettingsStore(() => ({
      getItem: () => null,
      setItem: () => {},
    }));
  }

  it.each([
    ['low', 1],
    ['medium', 1.5],
    ['high', 2],
  ] as const)(
    'initializes %s without changing CSS dimensions or owners',
    async (renderQuality, ratio) => {
      const settings = preferences();
      settings.update({ renderQuality });
      const h = await setup({ settings });
      await h.load();
      expect(h.renderer.setPixelRatio).toHaveBeenLastCalledWith(ratio);
      expect(h.renderer.setSize).toHaveBeenLastCalledWith(800, 400, false);
      expect(h.renderer.domElement.style.width).toBe('100%');
      expect(h.renderer.domElement.style.height).toBe('100%');
      expect(h.runtimes[0].camera.aspect).toBe(2);
      expect(h.createRenderer).toHaveBeenCalledOnce();
      expect(h.runtimes).toHaveLength(1);
      expect(h.frames.size).toBe(1);
    },
  );

  it('changes only the retained buffer while paused and ignores unrelated or unchanged preferences', async () => {
    const settings = preferences();
    const createInput = vi.fn(
      (canvas: HTMLCanvasElement, isPlaying: () => boolean) =>
        new InputController(window, { pointerSurface: canvas, isPlaying }),
    );
    const h = await setup({ settings, createInput });
    await h.load();
    h.frame(50);
    h.store.dispatch({ type: 'PAUSE' });
    const before = h.host.getSnapshot();
    const canvas = h.renderer.domElement;
    const projection = h.runtimes[0].camera.projectionMatrix.clone();
    const pending = [...h.frames.values()];
    const dispatch = vi.spyOn(h.store, 'dispatch');
    vi.mocked(h.renderer.setPixelRatio).mockClear();
    vi.mocked(h.renderer.setSize).mockClear();
    for (const [renderQuality, ratio] of [
      ['medium', 1.5],
      ['low', 1],
      ['high', 2],
    ] as const) {
      settings.update({ renderQuality });
      expect(h.renderer.setPixelRatio).toHaveBeenLastCalledWith(ratio);
      expect(h.renderer.setSize).toHaveBeenLastCalledWith(800, 400, false);
    }
    expect(h.renderer.setSize).toHaveBeenCalledTimes(3);
    settings.update({ renderQuality: 'high' });
    settings.update({
      masterVolume: 0.2,
      mouseSteering: false,
      reducedMotion: true,
    });
    settings.update({});
    expect(h.renderer.setSize).toHaveBeenCalledTimes(3);
    expect(h.renderer.setPixelRatio).toHaveBeenCalledTimes(3);
    expect([...h.frames.values()]).toEqual(pending);
    expect(h.runtimes[0].camera.projectionMatrix).toEqual(projection);
    h.frame(1000);
    const after = h.host.getSnapshot();
    expect(after.race).toEqual(before.race);
    expect(after.player).toEqual(before.player);
    expect(after.frame.steps).toBe(before.frame.steps);
    expect(after.resources).toEqual(before.resources);
    expect(h.container.firstElementChild).toBe(canvas);
    expect(h.createRenderer).toHaveBeenCalledOnce();
    expect(createInput).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    await h.host.dispose();
    settings.update({ renderQuality: 'low' });
    expect(h.renderer.setSize).toHaveBeenCalledTimes(3);
    expect(h.host.getSnapshot().resources).toEqual({
      canvases: 0,
      rafChains: 0,
      pendingCleanup: 0,
      scene: null,
    });
  });

  it('uses the latest pending choice on load, zero-size recovery, and display resize', async () => {
    const gate = deferred<void>();
    const settings = preferences();
    const h = await setup({
      settings,
      loadCourse: async () => {
        await gate.promise;
        return definition();
      },
    });
    h.resize({ width: 0, height: 0, dpr: 2 });
    const loading = h.load();
    settings.update({ renderQuality: 'low' });
    gate.resolve();
    await loading;
    h.frame(17);
    expect(h.renderer.setSize).not.toHaveBeenCalled();
    settings.update({ renderQuality: 'medium' });
    expect(h.renderer.setSize).not.toHaveBeenCalled();
    h.resize({ width: 900, height: 600, dpr: 1.25 });
    expect(h.renderer.setPixelRatio).toHaveBeenLastCalledWith(0.9375);
    expect(h.renderer.setSize).toHaveBeenLastCalledWith(900, 600, false);
    expect(h.runtimes[0].camera.aspect).toBe(1.5);
    h.frame(17);
    expect(h.renderer.render).toHaveBeenCalled();
  });

  it('defers quality sizing during loss, restores the latest on the same paused run and keeps it on retry', async () => {
    const settings = preferences();
    const h = await setup({ settings });
    await h.load();
    h.frame(50);
    const canvas = h.renderer.domElement;
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    const lost = h.host.getSnapshot();
    vi.mocked(h.renderer.setSize).mockClear();
    vi.mocked(h.renderer.setPixelRatio).mockClear();
    settings.update({ renderQuality: 'low' });
    settings.update({ renderQuality: 'medium' });
    h.resize({ width: 640, height: 480, dpr: 1 });
    h.frame(1000);
    expect(h.renderer.setPixelRatio).not.toHaveBeenCalled();
    expect(h.renderer.setSize).not.toHaveBeenCalled();
    expect(h.host.getSnapshot().frame).toEqual(lost.frame);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(h.renderer.setPixelRatio).toHaveBeenLastCalledWith(0.75);
    expect(h.renderer.setSize).toHaveBeenLastCalledWith(640, 480, false);
    h.frame(17);
    expect(h.host.getSnapshot()).toMatchObject({
      screen: 'paused',
      graphicsLost: false,
      race: lost.race,
      player: lost.player,
      frame: { steps: lost.frame.steps },
      resources: { ...lost.resources, rafChains: 1 },
    });
    expect(h.createRenderer).toHaveBeenCalledOnce();
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    settings.update({ renderQuality: 'low' });
    const replacement = {
      ...h.renderer,
      domElement: document.createElement('canvas'),
    };
    h.createRenderer.mockResolvedValue(replacement);
    h.host.retryCourse();
    await h.host.whenIdle();
    expect(h.container.firstElementChild).toBe(replacement.domElement);
    expect(h.renderer.setPixelRatio).toHaveBeenLastCalledWith(0.5);
    expect(h.host.getSnapshot().preferences.renderQuality).toBe('low');
    expect(h.runtimes).toHaveLength(2);
    expect(h.runtimes[0].getDiagnostics().lifecycle).toBe('disposed');
    expect(h.frames.size).toBe(1);
  });

  it.each(
    (['measure', 'setPixelRatio', 'setSize'] as const).flatMap((phase) =>
      (['saved', 'session-only'] as const).map((status) => ({ phase, status })),
    ),
  )(
    'contains settings-triggered $phase failure while reporting $status and notifying subscribers',
    async ({ phase, status }) => {
      const values = new Map<string, string>();
      const settings = createSettingsStore(() => ({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          if (status === 'session-only')
            throw new DOMException('Full', 'QuotaExceededError');
          values.set(key, value);
        },
      }));
      const measure = vi.fn(() => ({ width: 800, height: 400, dpr: 2 }));
      const h = await setup({ settings, measure });
      await h.load();
      h.frame(17);
      const dispatch = vi.spyOn(h.store, 'dispatch');
      const failure = new Error(`quality ${phase} failed`);
      if (phase === 'measure')
        measure.mockImplementation(() => {
          throw failure;
        });
      else
        vi.mocked(h.renderer[phase]).mockImplementation(() => {
          throw failure;
        });
      const subscriber = vi.fn();
      settings.subscribe(subscriber);
      expect(() => settings.update({ renderQuality: 'low' })).not.toThrow();
      expect(dispatch).toHaveBeenCalledWith({
        type: 'SHOW_ERROR',
        title: 'Run unavailable',
        detail: failure.message,
      });
      expect(h.store.getState().screen).toBe('error');
      expect(h.frames.size).toBe(0);
      expect(h.host.getSnapshot().resources).toEqual({
        canvases: 0,
        rafChains: 0,
        pendingCleanup: 0,
        scene: null,
      });
      expect(subscriber).toHaveBeenCalledOnce();
      expect(settings.getState()).toMatchObject({
        status,
        settings: { version: 2, renderQuality: 'low' },
      });
      if (status === 'saved') {
        expect(settings.getState().notice).toBeNull();
        expect(JSON.parse(values.get('reef-rush.settings') ?? 'null')).toEqual(
          settings.getState().settings,
        );
      } else {
        expect(settings.getState().notice).toMatch(/could not save.*session/i);
        expect(values.size).toBe(0);
      }
    },
  );
});

describe('owned graphics loss and explicit course retry', () => {
  function graphics(canvas: HTMLCanvasElement, type: 'lost' | 'restored') {
    const event = new Event(`webglcontext${type}`, { cancelable: true });
    canvas.dispatchEvent(event);
    return event;
  }

  it.each(['playing', 'paused', 'results'] as const)(
    'freezes %s CPU state and restores the same owner without automatic resume',
    async (screen) => {
      const context = new FakeContext();
      const audio = createAudioEngine({
        createContext: () => context,
        isUserGesture: () => true,
      });
      const settings = createSettingsStore(() => ({
        getItem: () => null,
        setItem: () => {},
      }));
      settings.update({ musicEnabled: true });
      const h = await setup({
        audio,
        settings,
        loadCourse: () => Promise.resolve(definition(screen === 'results')),
      });
      await h.host.unlockAudio();
      await h.load();
      key('Space');
      key('KeyW');
      h.frame(17);
      if (screen === 'paused') h.store.dispatch({ type: 'PAUSE' });
      expect(h.store.getState().screen).toBe(screen);
      const runtime = h.runtimes[0];
      const resources = runtime.getDiagnostics();
      const result = h.store.getState().result;
      const progress = h.store.getState().progress;
      const before = h.host.getSnapshot();
      const dispatch = vi.spyOn(h.store, 'dispatch');
      const staleFrame = [...h.frames.values()][0];
      expect(graphics(h.renderer.domElement, 'lost').defaultPrevented).toBe(
        true,
      );
      expect(h.host.getSnapshot()).toMatchObject({
        graphicsLost: true,
        screen: screen === 'results' ? 'results' : 'paused',
        race: { status: screen === 'results' ? 'finished' : 'paused' },
        audio: { activeEffects: 0, activeAmbience: 0 },
        resources: { rafChains: 0, canvases: 1, scene: resources },
      });
      const lost = h.host.getSnapshot();
      graphics(h.renderer.domElement, 'lost');
      key('Escape');
      key('Space');
      h.elapse(60_000);
      staleFrame(60_017);
      h.frame(1000);
      expect(h.host.getSnapshot().frame).toEqual(lost.frame);
      expect(h.host.getSnapshot().player).toEqual(before.player);
      expect(h.host.getSnapshot().race).toEqual(lost.race);
      expect(h.host.getSnapshot().collectedPearlIds).toEqual(
        before.collectedPearlIds,
      );
      expect(h.frames.size).toBe(0);
      graphics(h.renderer.domElement, 'restored');
      graphics(h.renderer.domElement, 'restored');
      staleFrame(60_017);
      expect(h.host.getSnapshot().graphicsLost).toBe(false);
      expect(h.host.getSnapshot().race).toEqual(lost.race);
      expect(h.frames.size).toBe(1);
      h.frame(17);
      expect(h.host.getSnapshot().frame.steps).toBe(before.frame.steps);
      expect(h.host.getSnapshot().frame.rendered).toBeGreaterThan(
        before.frame.rendered,
      );
      expect(h.runtimes).toEqual([runtime]);
      expect(h.createRenderer).toHaveBeenCalledOnce();
      expect(runtime.getDiagnostics()).toEqual(resources);
      expect(h.renderer.dispose).not.toHaveBeenCalled();
      expect(h.store.getState().result).toBe(result);
      expect(h.store.getState().progress).toBe(progress);
      expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
        'GRAPHICS_LOST',
        'GRAPHICS_RESTORED',
      ]);
      if (screen !== 'results') {
        h.store.dispatch({ type: 'RESUME' });
        h.frame(17);
        const resumed = h.host.getSnapshot();
        expect(resumed.frame.steps - before.frame.steps).toBe(1);
        expect(resumed.race!.elapsedMs - before.race!.elapsedMs).toBeCloseTo(
          1000 / 60,
        );
        expect(resumed.audio.emittedCues.dash).toBe(
          before.audio.emittedCues.dash,
        );
      }
      key('KeyW', 'keyup');
      key('Space', 'keyup');
    },
  );

  it('keeps renderer listeners across detach, restores while detached and ignores removed or stale callbacks', async () => {
    const h = await setup();
    const add = vi.spyOn(h.renderer.domElement, 'addEventListener');
    const remove = vi.spyOn(h.renderer.domElement, 'removeEventListener');
    await h.load();
    const bindings = add.mock.calls.filter(([type]) =>
      type.startsWith('webglcontext'),
    );
    expect(bindings.map(([type]) => type)).toEqual([
      'webglcontextlost',
      'webglcontextrestored',
    ]);
    for (let cycle = 0; cycle < 2; cycle++) {
      h.host.setContainer(null);
      graphics(h.renderer.domElement, 'lost');
      expect(h.store.getState().graphicsLost).toBe(true);
      h.host.setContainer(h.container);
      expect(h.frames.size).toBe(0);
      h.host.setContainer(null);
      graphics(h.renderer.domElement, 'restored');
      expect(h.store.getState().graphicsLost).toBe(false);
      expect(h.frames.size).toBe(0);
      h.host.setContainer(h.container);
      expect(h.frames.size).toBe(1);
      expect(h.store.getState().screen).toBe('paused');
    }
    expect(
      remove.mock.calls.filter(([type]) => type.startsWith('webglcontext')),
    ).toHaveLength(0);
    vi.mocked(h.renderer.dispose).mockImplementation(() => {
      expect(
        remove.mock.calls.filter(([type]) => type.startsWith('webglcontext')),
      ).toHaveLength(2);
      graphics(h.renderer.domElement, 'lost');
    });
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    vi.mocked(h.renderer.dispose).mockImplementation(() => {});
    const oldCanvas = h.renderer.domElement;
    h.createRenderer.mockResolvedValue({
      ...h.renderer,
      domElement: document.createElement('canvas'),
    });
    await h.load();
    const next = h.host.getSnapshot();
    for (const [type, listener] of bindings) {
      const event = new Event(type, { cancelable: true });
      if (typeof listener === 'function') listener.call(oldCanvas, event);
      else listener.handleEvent(event);
      oldCanvas.dispatchEvent(event);
    }
    expect(h.host.getSnapshot()).toEqual(next);
    await h.host.dispose();
    expect(h.host.getSnapshot().resources).toEqual({
      canvases: 0,
      rafChains: 0,
      pendingCleanup: 0,
      scene: null,
    });
  });

  it('fresh retry restarts only the attempt and rejects calls outside error or paused loss', async () => {
    const h = await setup();
    expect(h.host.retryCourse).toBeTypeOf('function');
    expect(() => h.host.retryCourse()).toThrow(/retry/i);
    await h.load();
    expect(() => h.host.retryCourse()).toThrow(/retry/i);
    h.frame(50);
    h.store.dispatch({ type: 'PAUSE' });
    expect(() => h.host.retryCourse()).toThrow(/retry/i);
    h.host.settings.update({ mouseSensitivity: 1.5 });
    h.store.dispatch({
      type: 'PROGRESS_UPDATED',
      progress: { version: 1, courses: {} },
      notice: 'Save pending.',
    });
    graphics(h.renderer.domElement, 'lost');
    const progress = h.store.getState().progress;
    const old = h.runtimes[0];
    h.host.retryCourse();
    expect(h.store.getState()).toMatchObject({
      screen: 'loading',
      graphicsLost: false,
    });
    await h.host.whenIdle();
    expect(old.getDiagnostics().lifecycle).toBe('disposed');
    expect(h.runtimes).toHaveLength(2);
    expect(h.host.getSnapshot()).toMatchObject({
      frame: { steps: 0 },
      collectedPearlIds: [],
      race: { elapsedMs: 0 },
      preferences: { mouseSensitivity: 1.5 },
    });
    expect(h.store.getState().progress).toBe(progress);
    expect(h.frames.size).toBe(1);
    await h.host.dispose();
    expect(() => h.host.retryCourse()).toThrow(/disposed/i);
  });

  it('retries failed construction cleanup only on explicit retry and reports failed retries without constructing', async () => {
    const release = vi.fn<() => void>(() => {
      throw new Error('child still owns resources');
    });
    const owner = new ConstructionCleanupError(
      new Error('build failed'),
      [new Error('rollback failed')],
      [release],
      'Retained construction',
    );
    const createScene = vi.fn(realScene).mockRejectedValueOnce(owner);
    const h = await setup({ createScene });
    await h.load();
    const initialDetail = h.store.getState().error?.detail;
    expect(h.host.retryCourse).toBeTypeOf('function');
    expect(release).not.toHaveBeenCalled();
    h.host.retryCourse();
    await h.host.whenIdle();
    expect(release).toHaveBeenCalledOnce();
    expect(h.store.getState().screen).toBe('error');
    expect(h.store.getState().error?.detail).toMatch(/cleanup/i);
    const retryDetail = h.store.getState().error?.detail;
    expect(createScene).toHaveBeenCalledOnce();
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(1);
    release.mockImplementation(() => {});
    h.host.retryCourse();
    await h.host.whenIdle();
    expect(release).toHaveBeenCalledTimes(2);
    expect(createScene).toHaveBeenCalledTimes(2);
    expect(h.store.getState().screen).toBe('playing');
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(0);
    expect(initialDetail).toContain('build failed');
    expect(initialDetail).toContain('rollback failed');
    expect(retryDetail).toContain('child still owns resources');
  });

  it('shows a real nested scene child cleanup cause on initial failure and explicit retry', async () => {
    const h = await setup();
    await h.load();
    let retained: Material | undefined;
    h.runtimes[0].scene.traverse((node) => {
      if (node instanceof Mesh && node.material instanceof Material)
        retained ??= node.material;
    });
    if (!retained) throw new Error('Expected a real scene material.');
    const release = vi.spyOn(retained, 'dispose').mockImplementation(() => {
      throw new Error('scene material still owns resources');
    });
    try {
      graphics(h.renderer.domElement, 'lost');
      h.host.retryCourse();
      await h.host.whenIdle();
      const initialDetail = h.store.getState().error?.detail;
      h.host.retryCourse();
      await h.host.whenIdle();
      expect(release).toHaveBeenCalledTimes(2);
      expect(h.runtimes).toHaveLength(1);
      expect(h.host.getSnapshot().resources.pendingCleanup).toBe(1);
      expect(initialDetail).toContain('scene material still owns resources');
      expect(h.store.getState().error?.detail).toContain(
        'scene material still owns resources',
      );
    } finally {
      release.mockRestore();
    }
    h.host.retryCourse();
    await h.host.whenIdle();
    expect(h.runtimes).toHaveLength(2);
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(0);
  });

  it('reports cyclic and shared failure causes once without changing their ownership graph', async () => {
    const child = new Error('shared child failure');
    const failure = new AggregateError([child, child], 'outer failure', {
      cause: child,
    });
    child.cause = failure;
    const h = await setup({
      loadCourse: () => Promise.reject(failure),
    });
    await h.load();
    const detail = h.store.getState().error?.detail ?? '';
    expect(detail).toContain('outer failure');
    expect(detail.match(/shared child failure/g)).toHaveLength(1);
    expect(child.cause).toBe(failure);
    expect(failure.errors).toEqual([child, child]);
  });

  it('bounds failure history and retains the latest nested retry message', async () => {
    const history = Array.from(
      { length: 200 },
      (_, index) => new Error(`older retry ${index}`),
    );
    const h = await setup({
      loadCourse: () =>
        Promise.reject(
          new AggregateError(
            [...history, new Error('latest retry failure')],
            'retained owner',
          ),
        ),
    });
    await h.load();
    const detail = h.store.getState().error?.detail ?? '';
    expect(detail).toContain('latest retry failure');
    expect(detail).toContain('[additional error detail omitted]');
    expect(detail.length).toBeLessThanOrEqual(2048);
  });

  it('bounds deep failure causes and oversized error text with explicit truncation', async () => {
    let failure: Error = new Error('x'.repeat(10_000));
    for (let index = 0; index < 100; index++)
      failure = new Error(`layer ${index}`, { cause: failure });
    const h = await setup({
      loadCourse: () => Promise.reject(failure),
    });
    await h.load();
    expect(h.store.getState().error?.detail).toContain(
      '[additional error detail omitted]',
    );
    expect(h.store.getState().error!.detail.length).toBeLessThanOrEqual(2048);
    failure = new Error('x'.repeat(10_000));
    h.host.retryCourse();
    await h.host.whenIdle();
    const detail = h.store.getState().error?.detail ?? '';
    expect(detail).toMatch(/^x+/);
    expect(detail).toContain('[additional error detail omitted]');
    expect(detail.length).toBeLessThanOrEqual(2048);
  });

  it('keeps failed live cleanup pending and does not retry it in the first fresh-load catch', async () => {
    const h = await setup();
    await h.load();
    const dispose = vi
      .spyOn(h.runtimes[0], 'dispose')
      .mockImplementation(() => {
        throw new Error('live scene retained');
      });
    graphics(h.renderer.domElement, 'lost');
    expect(h.host.retryCourse).toBeTypeOf('function');
    h.host.retryCourse();
    await h.host.whenIdle();
    expect(dispose).toHaveBeenCalledOnce();
    expect(h.runtimes).toHaveLength(1);
    expect(h.store.getState().screen).toBe('error');
    h.host.retryCourse();
    await h.host.whenIdle();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(h.runtimes).toHaveLength(1);
    expect(h.store.getState().error?.detail).toContain('live scene retained');
    dispose.mockRestore();
    h.host.retryCourse();
    await h.host.whenIdle();
    expect(h.runtimes).toHaveLength(2);
    expect(h.frames.size).toBe(1);
  });

  it('blocks a queued retry behind late cleanup and retains its failed owner', async () => {
    const entered = deferred<void>();
    const pending = deferred<SceneRuntime>();
    const runtime = { ...(await realScene(definition())) };
    const dispose = vi.spyOn(runtime, 'dispose').mockImplementation(() => {
      throw new Error('late owner');
    });
    const createScene = vi.fn(realScene).mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    const h = await setup({ createScene });
    const load = h.load();
    await entered.promise;
    h.store.dispatch({
      type: 'SHOW_ERROR',
      title: 'Cancelled',
      detail: 'Loading interrupted',
    });
    expect(h.host.retryCourse).toBeTypeOf('function');
    h.host.retryCourse();
    expect(h.store.getState().screen).toBe('loading');
    expect(dispose).not.toHaveBeenCalled();
    pending.resolve(runtime);
    await load;
    await h.host.whenIdle();
    expect(createScene).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(h.store.getState().screen).toBe('error');
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(1);
    dispose.mockRestore();
    h.host.retryCourse();
    await h.host.whenIdle();
    expect(createScene).toHaveBeenCalledTimes(2);
    expect(h.store.getState().screen).toBe('playing');
  });

  it('retains a failed loss-time RAF cancellation and ignores its late callback', async () => {
    const cancel = vi.fn<() => void>(() => {
      throw new Error('RAF retained');
    });
    const h = await setup({ cancelFrame: cancel });
    await h.load();
    const callback = [...h.frames.values()][0];
    graphics(h.renderer.domElement, 'lost');
    expect(h.store.getState().screen).toBe('error');
    expect(h.host.getSnapshot().resources.pendingCleanup).toBe(1);
    const before = h.host.getSnapshot();
    callback(1000);
    expect(h.host.getSnapshot()).toEqual(before);
    expect(cancel).toHaveBeenCalledOnce();
    cancel.mockImplementation(() => {
      h.frames.clear();
    });
    h.host.retryCourse();
    await h.host.whenIdle();
    expect(h.frames.size).toBe(1);
  });

  it('drains a withheld earned save across results loss, restoration and disposal', async () => {
    const gate = deferred<void>();
    const h = await setup({
      loadCourse: () => Promise.resolve(definition(true)),
      coordinateProgress: async (save) => {
        await gate.promise;
        save();
      },
    });
    await h.load();
    let disposed = Promise.resolve();
    try {
      h.frame(100);
      expect(h.store.getState().screen).toBe('results');
      const result = h.store.getState().result;
      graphics(h.renderer.domElement, 'lost');
      expect(h.store.getState().graphicsLost).toBe(true);
      expect(h.store.getState().result).toBe(result);
      expect(h.store.getState().progressNotice).toMatch(/pending/);
      graphics(h.renderer.domElement, 'restored');
      expect(h.store.getState().result).toBe(result);
      disposed = h.host.dispose();
      expect(h.host.getSnapshot().resources.scene).toBeNull();
    } finally {
      gate.resolve();
      await disposed;
    }
    await h.host.whenIdle();
    expect(JSON.parse(h.storage.get(PROGRESS_STORAGE_KEY)!)).toEqual(
      h.store.getState().progress,
    );
    expect(h.store.getState().progressNotice).toBeNull();
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

  it('inspects storage freshly without putting raw data in diagnostics', async () => {
    const m = memory();
    const h = await setup({ storage: m.provider });
    m.state.raw = '{private';
    expect(h.host.inspectSavedProgress?.()).toMatchObject({
      status: 'invalid',
      raw: '{private',
      reason: 'malformed-json',
    });
    expect(JSON.stringify(h.host.getSnapshot())).not.toContain('{private');
    m.state.raw = null;
    expect(h.host.inspectSavedProgress?.()).toMatchObject({ status: 'empty' });
  });

  it.each(
    [
      ['malformed-json', '{private-record'],
      ['invalid-schema', '{"version":1,"private-record":true}'],
      ['unsupported-version', '{"version":99,"private-record":true}'],
    ].flatMap(([reason, raw]) =>
      [false, true].map((duringWriteGuard) => ({
        reason,
        raw,
        duringWriteGuard,
      })),
    ),
  )(
    'keeps $reason raw data out of ordinary retry results (write guard: $duringWriteGuard)',
    async ({ reason, raw, duringWriteGuard }) => {
      const m = memory();
      const h = await setup({ storage: m.provider });
      m.state.raw = raw;
      if (duringWriteGuard) {
        vi.mocked(m.storage.getItem).mockReturnValueOnce(
          JSON.stringify(emptyProgress()),
        );
      }
      const result = await h.host.retrySaving();
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.cause).toBeInstanceOf(Error);
        expect(result.cause).not.toHaveProperty('cause');
        expect(String(result.cause)).toMatch(/invalid.*save/i);
        expect(String(result.cause)).not.toContain('private-record');
        if (!duringWriteGuard) expect(String(result.cause)).toContain(reason);
      }
      expect(m.storage.setItem).not.toHaveBeenCalled();
      expect(m.state.raw).toBe(raw);
      expect(JSON.stringify(h.host.getSnapshot())).not.toContain(
        'private-record',
      );
      expect(h.host.inspectSavedProgress()).toMatchObject({ raw, reason });
    },
  );

  it('queues recovery behind ordinary saves and captures a finish earned while waiting inside the lock', async () => {
    const m = memory();
    m.state.raw = '{broken';
    const gate = deferred<void>();
    const entered = deferred<void>();
    let requests = 0;
    const h = await setup({
      storage: m.provider,
      loadCourse: finishCourse,
      coordinateProgress: async (save) => {
        requests++;
        entered.resolve();
        await gate.promise;
        save();
      },
    });
    await h.load();
    expect(h.host.replaceSavedProgress).toBeTypeOf('function');
    const pending = h.host.replaceSavedProgress(
      '{broken',
      new AbortController().signal,
    );
    try {
      await entered.promise;
      finish(h);
      expect(requests).toBe(1);
      expect(m.storage.setItem).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
    }
    expect(await pending).toEqual({ status: 'replaced' });
    await h.host.whenIdle();
    expect(m.read()).toEqual(h.store.getState().progress);
    expect(m.read().courses['sunlit-shoals']?.bestMedal).toBe('gold');
    expect(h.store.getState().progressNotice).toBeNull();
    expect(requests).toBe(2);
  });

  it.each(['changed', 'loaded', 'empty', 'unsupported-version'] as const)(
    'aborts a queued replacement if storage becomes %s, then can retry ordinary merging',
    async (status) => {
      const m = memory();
      m.state.raw = '{broken';
      const gate = deferred<void>();
      const entered = deferred<void>();
      const h = await setup({
        loadCourse: finishCourse,
        storage: m.provider,
        coordinateProgress: async (save) => {
          entered.resolve();
          await gate.promise;
          save();
        },
      });
      await h.load();
      expect(h.host.replaceSavedProgress).toBeTypeOf('function');
      finish(h);
      const pending = h.host.replaceSavedProgress(
        '{broken',
        new AbortController().signal,
      );
      try {
        await entered.promise;
        m.state.raw = {
          changed: '{different',
          loaded: JSON.stringify(latest),
          empty: null,
          'unsupported-version': '{"version":99,"keep":true}',
        }[status];
      } finally {
        gate.resolve();
      }
      const result = await pending;
      // The ordinary save ahead of recovery may turn empty storage into valid storage.
      expect(result).toEqual({
        status: status === 'empty' ? 'loaded' : status,
      });
      if (status === 'changed' || status === 'unsupported-version')
        expect(m.storage.setItem).not.toHaveBeenCalled();
      if (status === 'loaded') expect(m.read()).toEqual(expected);
      expect(h.store.getState().progressNotice).toMatch(/not replaced/i);
      m.state.raw = JSON.stringify(latest);
      expect(await h.host.retrySaving()).toEqual({ status: 'saved' });
      expect(m.read()).toEqual(expected);
      expect(h.store.getState().progressNotice).toBeNull();
    },
  );

  it.each(['before-queue', 'waiting-lock', 'behind-save'] as const)(
    'cancels uncommitted recovery %s without poisoning later ordinary saves',
    async (when) => {
      const m = memory();
      m.state.raw = '{broken';
      const gate = deferred<void>();
      const entered = deferred<void>();
      const request = new AbortController();
      const h = await setup({
        storage: m.provider,
        loadCourse: finishCourse,
        coordinateProgress: async (save) => {
          entered.resolve();
          await gate.promise;
          save();
        },
      });
      await h.load();
      expect(h.host.replaceSavedProgress).toBeTypeOf('function');
      if (when === 'before-queue') request.abort();
      if (when === 'behind-save') finish(h);
      const pending = h.host.replaceSavedProgress('{broken', request.signal);
      try {
        if (when !== 'before-queue') await entered.promise;
        request.abort();
      } finally {
        gate.resolve();
      }
      expect(await pending).toEqual({ status: 'cancelled' });
      expect(m.state.raw).toBe('{broken');
      expect(m.storage.setItem).not.toHaveBeenCalled();
      m.state.raw = JSON.stringify(latest);
      expect(await h.host.retrySaving()).toEqual({ status: 'saved' });
      await expect(h.host.whenIdle()).resolves.toBeUndefined();
      expect(m.read().courses.kelpworks).toEqual(latest.courses.kelpworks);
    },
  );

  it.each(['abort', 'abort-and-reject'] as const)(
    'never reports a committed replacement as cancelled after %s',
    async (afterCommit) => {
      const m = memory();
      m.state.raw = '{broken';
      const request = new AbortController();
      const h = await setup({
        storage: m.provider,
        coordinateProgress: (save) =>
          Promise.resolve().then(() => {
            save();
            request.abort();
            if (afterCommit === 'abort-and-reject')
              throw new Error('lock release failed');
          }),
      });
      expect(
        await h.host.replaceSavedProgress?.('{broken', request.signal),
      ).toEqual({
        status: 'replaced',
      });
      expect(m.read().courses).toEqual({});
      if (afterCommit === 'abort-and-reject')
        expect(h.store.getState().progressNotice).toMatch(
          /saved.*coordination.*failed/i,
        );
    },
  );

  it.each(['write', 'lock', 'no-callback'] as const)(
    'reports %s failure truthfully and permits a subsequent queued operation',
    async (failure) => {
      const m = memory();
      m.state.raw = '{broken';
      let fail = true;
      const h = await setup({
        storage: m.provider,
        coordinateProgress: (save) =>
          Promise.resolve().then(() => {
            if (fail && failure === 'lock') throw new Error('lock denied');
            if (fail && failure === 'no-callback') return;
            save();
          }),
      });
      m.state.writable = failure !== 'write';
      const result = await h.host.replaceSavedProgress?.(
        '{broken',
        new AbortController().signal,
      );
      expect(result).toMatchObject({
        status: failure === 'write' ? 'write-failed' : 'failed',
      });
      expect(result).toHaveProperty('cause');
      expect(m.state.raw).toBe('{broken');
      expect(h.store.getState().progressNotice).toMatch(/not replaced/i);
      fail = false;
      m.state.writable = true;
      expect(
        await h.host.replaceSavedProgress(
          '{broken',
          new AbortController().signal,
        ),
      ).toEqual({ status: 'replaced' });
      await expect(h.host.whenIdle()).resolves.toBeUndefined();
    },
  );

  it('reports ordinary retry failure instead of unconditional success, rejects bad recovery requests and disposed hosts', async () => {
    const m = memory();
    m.state.raw = '{broken';
    const h = await setup({ storage: m.provider });
    expect(await h.host.retrySaving?.()).toMatchObject({ status: 'failed' });
    expect(
      await h.host.replaceSavedProgress?.(null, new AbortController().signal),
    ).toMatchObject({
      status: 'invalid-request',
    });
    expect(m.storage.setItem).not.toHaveBeenCalled();
    await h.host.dispose();
    expect(
      await h.host.replaceSavedProgress(
        '{broken',
        new AbortController().signal,
      ),
    ).toMatchObject({ status: 'failed' });
    expect(await h.host.retrySaving()).toMatchObject({ status: 'failed' });
  });

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

  it('observes actual collected pearl identities from the active real scene', async () => {
    const h = await setup({
      loadCourse: () => Promise.resolve(definition(true)),
    });
    await h.load();
    expect(h.host.getSnapshot()).toMatchObject({ collectedPearlIds: [] });
    key('KeyW');
    h.frame(100);
    expect(h.runtimes[0].getSnapshot().collectedPearlIds).toEqual(['pearl']);
    expect(h.host.getSnapshot()).toMatchObject({
      collectedPearlIds: ['pearl'],
      race: { pearlCount: 1, status: 'finished' },
    });
  });

  it('observes empty pearl identities before loading and after returning to title or disposal', async () => {
    const h = await setup({
      loadCourse: () => Promise.resolve(definition(true)),
    });
    expect(h.host.getSnapshot()).toMatchObject({ collectedPearlIds: [] });
    await h.load();
    key('KeyW');
    h.frame(100);
    expect(h.host.getSnapshot()).toMatchObject({
      collectedPearlIds: ['pearl'],
    });
    h.store.dispatch({ type: 'RETURN_TO_TITLE' });
    await h.host.whenIdle();
    expect(h.host.getSnapshot()).toMatchObject({
      screen: 'title',
      player: null,
      collectedPearlIds: [],
    });
    await h.host.dispose();
    expect(h.host.getSnapshot()).toMatchObject({ collectedPearlIds: [] });
  });

  it('exposes only cloned deeply frozen observations when the test flag is enabled, and removes the hook', async () => {
    vi.stubEnv('VITE_TEST_HOOKS', 'true');
    const h = await setup({
      loadCourse: () => Promise.resolve(definition(true)),
    });
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
    expect(snapshot).toMatchObject({ collectedPearlIds: [] });
    key('KeyW');
    h.frame(100);
    const collected = hook.getSnapshot();
    expect(collected).toMatchObject({ collectedPearlIds: ['pearl'] });
    const ids =
      'collectedPearlIds' in collected
        ? collected.collectedPearlIds
        : undefined;
    if (!Array.isArray(ids)) throw new Error('Missing pearl identity array.');
    expect(Object.isFrozen(ids)).toBe(true);
    expect(ids).not.toBe(h.runtimes[0].getSnapshot().collectedPearlIds);
    expect(() => Object.assign(ids, { 0: 'not-a-real-pearl' })).toThrow();
    expect(snapshot).toMatchObject({ collectedPearlIds: [] });
    expect(hook.getSnapshot()).toMatchObject({ collectedPearlIds: ['pearl'] });
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
