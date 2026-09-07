import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import sunlit from '../../src/content/courses/sunlitShoals';
import type { InputStamp } from '../../src/game/core/exposeGameHost';
import { InputController } from '../../src/game/input/InputController';
import { RaceSession } from '../../src/game/race/RaceSession';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import {
  installNativeInputRecorder,
  type NativeInputRecorder,
  type NativeObservedState,
} from '../fixtures/nativeInputRecorder';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  delete window.__REEF_RUSH_TEST__;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function setup(capacity = 100) {
  expect(installNativeInputRecorder).toBeTypeOf('function');
  if (!installNativeInputRecorder)
    throw new Error('Missing recorder installer.');
  const root = document.createElement('div');
  root.id = 'game-root';
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  root.append(canvas);
  document.body.append(root);
  canvas.focus();
  let stamp: InputStamp = {
    screen: 'playing',
    steps: 5,
    rendered: 2,
    settingsOpen: false,
    graphicsLost: false,
    inputResets: 1,
  };
  let time = 10;
  const tasks: Array<() => void> = [];
  const snapshotRead = vi.fn((): never => {
    throw new Error('Recorder must not request snapshots.');
  });
  const stampRead = vi.fn(() => Object.freeze({ ...stamp }));
  window.__REEF_RUSH_TEST__ = Object.freeze({
    getSnapshot: snapshotRead,
    getInputStamp: stampRead,
  });
  const input = new InputController(window, {
    pointerSurface: canvas,
    isPlaying: () =>
      stamp.screen === 'playing' && !stamp.settingsOpen && !stamp.graphicsLost,
  });
  const flush = () => {
    for (const task of tasks.splice(0)) task();
  };
  cleanup.push(() => {
    input.destroy();
    return Promise.resolve();
  });
  const recorder = runInNewContext(
    `(${installNativeInputRecorder.toString()})(capacity)`,
    {
      capacity,
      window,
      document,
      performance: { now: () => time++ },
      queueMicrotask: (task: () => void) => tasks.push(task),
    },
  ) as NativeInputRecorder;
  cleanup.push(async () => {
    flush();
    await recorder.finish();
  });
  const state = (): NativeObservedState => ({
    screen: stamp.screen,
    frame: { steps: stamp.steps, rendered: stamp.rendered, profiled: 2 },
    player: {
      position: [0, -3, 0],
      velocity: [0, 0, 1],
      yaw: 0,
      pitch: 0,
      roll: 0,
      dashEnergy: 1,
      isSubmerged: true,
    },
    race: {
      ...new RaceSession(sunlit).start(),
      status: stamp.screen === 'results' ? 'finished' : 'running',
    },
    collectedPearlIds: [],
    preferences: { ...DEFAULT_SETTINGS, mouseSteering: false },
  });
  return {
    recorder,
    stampRead,
    snapshotRead,
    input,
    canvas,
    flush,
    state,
    change: (next: Partial<InputStamp>) => {
      stamp = { ...stamp, ...next };
    },
    clock: (next: number) => {
      time = next;
    },
    key: (
      code: string,
      type = 'keydown',
      options: KeyboardEventInit = {},
      target: EventTarget = canvas,
    ) => {
      const event = new KeyboardEvent(type, {
        code,
        bubbles: true,
        cancelable: true,
        ...options,
      });
      target.dispatchEvent(event);
      return event;
    },
  };
}

it('retains copied correlated motion anchors without another snapshot read', async () => {
  const h = setup();
  const state = h.state();
  h.recorder.observe(state);
  Object.assign(state.player!.position, { 0: 999 });
  const data = await h.recorder.finish();
  expect(data.failure).toBeNull();
  expect(data.events).toHaveLength(1);
  expect(data.events[0]).toMatchObject({
    kind: 'observation',
    sequence: 0,
    steps: 5,
    rendered: 2,
    anchor: {
      courseId: sunlit.courseId,
      elapsedMs: 0,
      checkpointIndex: 0,
      pearlCount: 0,
      player: { position: [0, -3, 0], velocity: [0, 0, 1] },
      collectedPearlIds: [],
      mouseSteering: false,
    },
  });
  expect(h.snapshotRead).not.toHaveBeenCalled();
  expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  expect(Object.isFrozen(data.events[0])).toBe(true);
  if (data.events[0].kind !== 'observation') throw new Error('Missing anchor.');
  expect(Object.isFrozen(data.events[0].anchor.player?.position)).toBe(true);
});

it('observes after real input handlers and drains queued edges once before finishing', async () => {
  const h = setup();
  h.recorder.observe(h.state());
  const reads = h.stampRead.mock.calls.length;
  const event = h.key('KeyW', 'keydown', { repeat: true });
  expect(event.defaultPrevented).toBe(true);
  expect(h.input.readFrame().throttle).toBe(1);
  expect(h.stampRead).toHaveBeenCalledTimes(reads);
  h.key('KeyW', 'keyup');
  const complete = h.recorder.finish();
  h.flush();
  const data = await complete;
  expect(data.failure).toBeNull();
  expect(data.events.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
  expect(data.events[1]).toMatchObject({
    kind: 'key',
    type: 'keydown',
    code: 'KeyW',
    repeat: true,
    isTrusted: false,
    defaultPrevented: true,
    canvasTarget: true,
    steps: 5,
  });
  expect(data.events[2]).toMatchObject({ type: 'keyup', repeat: false });
  expect(await h.recorder.finish()).toBe(data);
  h.key('KeyA');
  window.dispatchEvent(new Event('blur'));
  document.dispatchEvent(new Event('visibilitychange'));
  h.flush();
  expect(await h.recorder.finish()).toBe(data);
  expect(() => h.recorder.observe(h.state())).toThrow(/finished/i);
});

it('ignores keys outside the native movement domain', async () => {
  const h = setup();
  h.recorder.observe(h.state());
  h.key('KeyX');
  h.flush();
  expect((await h.recorder.finish()).events).toHaveLength(1);
});

it.each([0, -1, 1.5, Infinity])('rejects invalid capacity %s', (capacity) => {
  expect(() => setup(capacity)).toThrow(/capacity/i);
});

it.each([
  ['steps', { steps: 4 }],
  ['rendered', { rendered: 1 }],
  ['invalid counter', { steps: NaN }],
  ['settings', { settingsOpen: true }],
  ['graphics', { graphicsLost: true }],
  ['pause', { screen: 'paused' as const }],
  ['reset', { inputResets: 3 }],
])('invalidates %s interruption', async (_name, update) => {
  const h = setup();
  h.recorder.observe(h.state());
  h.change(update);
  h.recorder.observe(h.state());
  expect((await h.recorder.finish()).failure).not.toBeNull();
});

it.each([
  ['ordinary finish', 2, true],
  ['settings open/close then finish', 4, false],
  ['pause/resume then finish', 4, false],
  ['missing terminal clear', 1, false],
])('classifies %s reset history', async (_name, inputResets, valid) => {
  const h = setup();
  h.recorder.observe(h.state());
  h.change({ screen: 'results', inputResets });
  h.recorder.observe(h.state());
  const data = await h.recorder.finish();
  expect(data.failure === null).toBe(valid);
});

it('rejects an unexplained reset after the terminal transition', async () => {
  const h = setup();
  h.recorder.observe(h.state());
  h.change({ screen: 'results', inputResets: 2 });
  h.recorder.observe(h.state());
  h.change({ inputResets: 3 });
  h.recorder.observe(h.state());
  expect((await h.recorder.finish()).failure).toMatch(/reset/i);
});

it.each([
  ['modifier', { ctrlKey: true }],
  ['alt modifier', { altKey: true }],
  ['meta modifier', { metaKey: true }],
])('rejects ignored keydown with %s', async (_name, options) => {
  const h = setup();
  h.recorder.observe(h.state());
  h.key('KeyW', 'keydown', options);
  h.flush();
  expect((await h.recorder.finish()).failure).toMatch(/keydown/i);
});

it('rejects a controlled keydown on a blocked target', async () => {
  const h = setup();
  h.recorder.observe(h.state());
  const button = document.createElement('button');
  document.body.append(button);
  h.key('KeyW', 'keydown', {}, button);
  h.flush();
  expect((await h.recorder.finish()).failure).toMatch(/keydown/i);
});

it.each(['blur', 'hidden'])(
  'invalidates %s even without another observation',
  async (kind) => {
    const h = setup();
    h.recorder.observe(h.state());
    if (kind === 'blur') window.dispatchEvent(new Event('blur'));
    else {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    }
    expect((await h.recorder.finish()).failure).not.toBeNull();
  },
);

it.each(['owner', 'clock', 'capacity', 'mouse', 'correlation'])(
  'retains explicit partial evidence after %s failure',
  async (kind) => {
    const h = setup(kind === 'capacity' ? 1 : 100);
    h.recorder.observe(h.state());
    const state = h.state();
    if (kind === 'owner') delete window.__REEF_RUSH_TEST__;
    if (kind === 'clock') h.clock(-1);
    if (kind === 'mouse')
      Object.assign(state.preferences, { mouseSteering: true });
    if (kind === 'correlation') Object.assign(state.frame, { steps: 9 });
    h.recorder.observe(state);
    const data = await h.recorder.finish();
    expect(data.events).toHaveLength(1);
    expect(data.failure).not.toBeNull();
    expect(Object.isFrozen(data.events)).toBe(true);
  },
);
