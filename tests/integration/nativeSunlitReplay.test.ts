import { afterEach, expect, it, vi } from 'vitest';
import {
  createSceneRuntime,
  type SceneRuntime,
  type SceneSnapshot,
} from '../../src/game/core/SceneRuntime';
import { parseCourseDefinition } from '../../src/game/course/courseDefinition';
import { InputController } from '../../src/game/input/InputController';
import type { InputFrame } from '../../src/game/input/InputFrame';
import { courseFixture } from '../fixtures/courseDefinition';
import type {
  NativeTimingData,
  NativeTimingEvent,
} from '../fixtures/nativeInputRecorder';
import { replaySunlitTiming } from '../fixtures/replaySunlitTiming';
import { loadNativeTimingCorpus } from '../fixtures/nativeTimingCorpus';
import { courseKeyboardPolicy } from '../fixtures/courseKeyboardPolicy';
import { localAssetLoader } from '../fixtures/originalAssets';

const corpus = await loadNativeTimingCorpus();

afterEach(() => vi.restoreAllMocks());

const definition = parseCourseDefinition({
  ...courseFixture(),
  objects: [],
  pearls: [],
});
const neutral: InputFrame = {
  steerX: 0,
  steerY: 0,
  throttle: 0,
  brakeHeld: false,
  dashPressed: false,
  pausePressed: false,
};
const forward: InputFrame = { ...neutral, throttle: 1 };
const left: InputFrame = { ...neutral, steerX: 1 };
const right: InputFrame = { ...neutral, steerX: -1 };

function replay() {
  expect(replaySunlitTiming).toBeTypeOf('function');
  if (!replaySunlitTiming) throw new Error('Missing physical replay.');
  return replaySunlitTiming;
}

async function reference(inputs: readonly InputFrame[]) {
  const runtime = await createSceneRuntime(definition);
  try {
    runtime.start();
    const snapshots = [runtime.getSnapshot()];
    for (const input of inputs) {
      runtime.step(input, 1 / 60);
      snapshots.push(runtime.getSnapshot());
      if (snapshots.at(-1)?.race.status === 'finished') break;
    }
    return snapshots;
  } finally {
    runtime.dispose();
  }
}

function stamp(snapshot: SceneSnapshot, steps: number) {
  return {
    steps,
    rendered: 0,
    screen:
      snapshot.race.status === 'finished'
        ? ('results' as const)
        : ('playing' as const),
    inputResets: snapshot.race.status === 'finished' ? 1 : 0,
    settingsOpen: false,
    graphicsLost: false,
    sequence: 0,
    time: 0,
  };
}

function observation(
  snapshot: SceneSnapshot,
  steps: number,
): NativeTimingEvent {
  return {
    ...stamp(snapshot, steps),
    kind: 'observation',
    anchor: {
      player: snapshot.fish,
      courseId: snapshot.race.courseId,
      elapsedMs: snapshot.race.elapsedMs,
      checkpointIndex: snapshot.race.checkpointIndex,
      pearlCount: snapshot.race.pearlCount,
      status: snapshot.race.status,
      collectedPearlIds: snapshot.collectedPearlIds,
      mouseSteering: false,
    },
  };
}

function edge(
  snapshot: SceneSnapshot,
  steps: number,
  type: 'keydown' | 'keyup',
  code: string,
): NativeTimingEvent {
  return {
    ...stamp(snapshot, steps),
    kind: 'key',
    type,
    code,
    repeat: false,
    isTrusted: false,
    defaultPrevented: type === 'keydown' && snapshot.race.status === 'running',
    canvasTarget: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  };
}

function tape(events: readonly NativeTimingEvent[]): NativeTimingData {
  return {
    version: 1,
    failure: null,
    events: events.map((event, sequence) => ({
      ...event,
      sequence,
      time: sequence,
    })),
  };
}

async function pulseTape() {
  const snapshots = await reference([
    neutral,
    neutral,
    neutral,
    neutral,
    forward,
    neutral,
    left,
    left,
    right,
    right,
  ]);
  return {
    snapshots,
    data: tape([
      observation(snapshots[0], 0),
      observation(snapshots[1], 1),
      observation(snapshots[4], 4),
      edge(snapshots[4], 4, 'keydown', 'KeyW'),
      observation(snapshots[5], 5),
      edge(snapshots[5], 5, 'keyup', 'KeyW'),
      observation(snapshots[6], 6),
      edge(snapshots[6], 6, 'keydown', 'KeyA'),
      edge(snapshots[8], 8, 'keyup', 'KeyA'),
      observation(snapshots[8], 8),
      edge(snapshots[8], 8, 'keydown', 'KeyD'),
      observation(snapshots[10], 10),
      edge(snapshots[10], 10, 'keyup', 'KeyD'),
    ]),
  };
}

it('calibrates one-step input, same-step ordering and empty transitions against literal frames', async () => {
  const run = replay();
  const { snapshots, data } = await pulseTape();
  const result = await run(data, {
    mode: 'motion',
    createRuntime: () => createSceneRuntime(definition),
  });
  expect(result.steps).toBe(10);
  expect(result.observations).toBe(7);
  expect(result.snapshot).toEqual(snapshots[10]);
  expect(result.maxErrors).toEqual({
    position: 0,
    velocity: 0,
    angle: 0,
    elapsedMs: 0,
    dashEnergy: 0,
  });
  expect(result.released).toEqual({
    lifecycle: 'disposed',
    bodies: 0,
    colliders: 0,
    geometries: 0,
    materials: 0,
  });
});

it('rejects an effectful one-step delay and releases the real scene and input', async () => {
  const run = replay();
  const { data } = await pulseTape();
  Object.assign(data.events[3], { steps: 5 });
  let runtime: SceneRuntime | undefined;
  const destroy = vi.spyOn(InputController.prototype, 'destroy');
  await expect(
    run(data, {
      mode: 'motion',
      scenario: 'delayed pulse',
      createRuntime: async () => {
        runtime = await createSceneRuntime(definition);
        return runtime;
      },
    }),
  ).rejects.toThrow(/delayed pulse.*(position|velocity)/i);
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(runtime?.getDiagnostics()).toMatchObject({
    lifecycle: 'disposed',
    bodies: 0,
    colliders: 0,
    geometries: 0,
    materials: 0,
  });
});

it('clears game input at physical finish but drains late deliveries and the ignored probe', async () => {
  const run = replay();
  const snapshots = await reference([
    ...Array.from({ length: 20 }, () => forward),
    ...Array.from({ length: 220 }, () => neutral),
  ]);
  const end = snapshots.length - 1;
  expect(end).toBeGreaterThan(20);
  expect(snapshots[end].race.status).toBe('finished');
  const data = tape([
    observation(snapshots[0], 0),
    edge(snapshots[0], 0, 'keydown', 'KeyW'),
    edge(snapshots[20], 20, 'keyup', 'KeyW'),
    observation(snapshots[20], 20),
    edge(snapshots[end], end, 'keydown', 'KeyS'),
    observation(snapshots[end], end),
    edge(snapshots[end], end, 'keyup', 'KeyS'),
    edge(snapshots[end], end, 'keydown', 'KeyW'),
    edge(snapshots[end], end, 'keyup', 'KeyW'),
  ]);
  const clear = vi.spyOn(InputController.prototype, 'clear');
  const result = await run(data, {
    mode: 'motion',
    createRuntime: () => createSceneRuntime(definition),
  });
  expect(result.snapshot).toEqual(snapshots[end]);
  expect(result.steps).toBe(end);
  expect(clear).toHaveBeenCalledTimes(1);
});

it('propagates factory failure without manufacturing a replay result', async () => {
  const run = replay();
  const { data } = await pulseTape();
  const failure = new Error('scene construction failed');
  await expect(
    run(data, {
      mode: 'motion',
      createRuntime: () => Promise.reject(failure),
    }),
  ).rejects.toBe(failure);
});

for (const mode of ['motion', 'baseline'] as const) {
  it.each(corpus.cases)(
    `${mode} recorded $scenario matches every original-physics anchor`,
    async (entry) => {
      const run = replay();
      const loads = vi.spyOn(localAssetLoader, 'loadAsync');
      const result = await run(entry.data, { mode, scenario: entry.scenario });
      const observed = entry.data.events.filter(
        (event) => event.kind === 'observation',
      );
      const terminal = observed.at(-1);
      if (!terminal || terminal.kind !== 'observation')
        throw new Error('Missing corpus terminal.');
      expect(result.steps).toBe(terminal.steps);
      expect(result.observations).toBe(observed.length);
      expect(result.decisions).toBe(
        mode === 'baseline' ? observed.length - 1 : 0,
      );
      expect(result.snapshot.race).toMatchObject({
        status: 'finished',
        checkpointIndex: 4,
        pearlCount: 4,
        result: { medal: null },
      });
      expect(
        Math.abs(result.snapshot.race.elapsedMs - terminal.anchor.elapsedMs!),
      ).toBeLessThanOrEqual(0.001);
      expect(result.snapshot.collectedPearlIds).toEqual(
        terminal.anchor.collectedPearlIds,
      );
      expect(loads.mock.calls.map(([url]) => url).sort()).toEqual([
        '/reef-rush/assets/courses/sunlit-shoals.collision.glb',
        '/reef-rush/assets/courses/sunlit-shoals.visual.glb',
        '/reef-rush/assets/fish/sunfin.glb',
      ]);
      expect(result.assetOwnership).toEqual({
        entries: 0,
        reservations: 0,
        geometries: 0,
        materials: 0,
        textures: 0,
      });
      expect(result.released).toEqual({
        lifecycle: 'disposed',
        bodies: 0,
        colliders: 0,
        geometries: 0,
        materials: 0,
      });
      console.info(
        `${mode} ${entry.scenario}: ${JSON.stringify({
          steps: result.steps,
          observations: result.observations,
          decisions: result.decisions,
          elapsedMs: result.snapshot.race.elapsedMs,
          maxErrors: result.maxErrors,
        })}`,
      );
    },
  );
}

it('rejects an incompatible generated baseline policy instead of supplying recorded commands', async () => {
  const run = replay();
  await expect(
    run(corpus.cases[0].data, {
      mode: 'baseline',
      baselinePolicy: (input) => ({
        ...courseKeyboardPolicy(input),
        keys: ['a'],
      }),
    }),
  ).rejects.toThrow(/topology/i);
});

it.each(['duplicate', 'missing', 'wrong'])(
  'rejects %s native command topology',
  async (kind) => {
    const run = replay();
    const data = structuredClone(corpus.cases[0].data);
    const events = [...data.events];
    const index = events.findIndex((event) => event.kind === 'key');
    if (kind === 'duplicate') events.splice(index + 1, 0, { ...events[index] });
    if (kind === 'missing') events.splice(index, 1);
    if (kind === 'wrong') Object.assign(events[index], { code: 'KeyA' });
    Object.assign(data, {
      events: events.map((event, sequence) => ({ ...event, sequence })),
    });
    await expect(run(data, { mode: 'baseline' })).rejects.toThrow(/topology/i);
  },
);

it.each([
  ['late pending press', 290],
  ['owned terminal release', 294],
  ['results probe', 297],
] as const)(
  'rejects removal of %s from the terminal overlap',
  async (_name, index) => {
    const run = replay();
    const data = structuredClone(corpus.cases[1].data);
    const events = data.events.filter((_event, position) => position !== index);
    Object.assign(data, {
      events: events.map((event, sequence) => ({ ...event, sequence })),
    });
    await expect(run(data, { mode: 'baseline' })).rejects.toThrow(/topology/i);
  },
);

it('rejects a claim that a pending key was accepted after physical completion', async () => {
  const run = replay();
  const data = structuredClone(corpus.cases[1].data);
  Object.assign(data.events[290], { defaultPrevented: true });
  await expect(run(data, { mode: 'baseline' })).rejects.toThrow(/eligibility/i);
});

it('compares the actual initial state before evaluating the baseline policy', async () => {
  const run = replay();
  const data = structuredClone(corpus.cases[0].data);
  const first = data.events[0];
  if (first.kind !== 'observation' || !first.anchor.player)
    throw new Error('Missing fixture anchor.');
  Object.assign(first.anchor.player.position, {
    0: first.anchor.player.position[0] + 0.01,
  });
  const policy = vi.fn(courseKeyboardPolicy);
  await expect(
    run(data, { mode: 'baseline', baselinePolicy: policy }),
  ).rejects.toThrow(/position/i);
  expect(policy).not.toHaveBeenCalled();
});

it('preserves a step failure together with a disposal failure after releasing ownership', async () => {
  const run = replay();
  const { data } = await pulseTape();
  const primary = new Error('step failed');
  const cleanup = new Error('disposal reported failure');
  let runtime: SceneRuntime | undefined;
  const failure = await run(data, {
    mode: 'motion',
    createRuntime: async () => {
      const live = await createSceneRuntime(definition);
      runtime = {
        ...live,
        step: () => {
          throw primary;
        },
        dispose: () => {
          live.dispose();
          throw cleanup;
        },
      };
      return runtime;
    },
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError))
    throw new Error('Missing combined failure.');
  expect(failure.errors).toEqual([primary, cleanup]);
  expect(runtime?.getDiagnostics()).toMatchObject({
    lifecycle: 'disposed',
    bodies: 0,
    colliders: 0,
  });
});
