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
import * as control from '../fixtures/sunlitPulsePolicy';
import {
  advanceSunlitWaypoint,
  sunlitSteeringTarget,
} from '../fixtures/sunlitWaypointPolicy';
import { loadSunlitChordWitness } from '../fixtures/sunlitChordWitness';

const corpus = await loadNativeTimingCorpus();

afterEach(() => vi.restoreAllMocks());

const recordedChord = {
  brakeHeld: false,
  slowing: true,
  propel: true,
  pulse: 'ArrowDown',
} as const;
const asymmetricTiming = {
  onsetSteps: 30,
  holdSteps: 10,
  observationSteps: 15,
  skewSteps: 11,
  releaseSkewSteps: 5,
};
const expectedAt893 = [
  -4.011307389942512, -4.467194154855966, 62.625659681897,
] as const;
const expectedAt964 = [
  -5.089150446517422, -4.881345323881319, 64.54595914329225,
] as const;

it.each([
  [893, 41, expectedAt893],
  [964, 46, expectedAt964],
] as const)(
  'recorded asymmetric chord reaches step %i from original spawn',
  async (steps, sequence, expectedPosition) => {
    const data = await loadSunlitChordWitness();
    const loads = vi.spyOn(localAssetLoader, 'loadAsync');
    const frames = vi.spyOn(InputController.prototype, 'readFrame');
    const result = await replaySunlitTiming(
      { ...data, events: data.events.slice(0, sequence + 1) },
      { mode: 'motion', scenario: `asymmetric-${steps}` },
    );
    expect(result.steps).toBe(steps);
    expect(result.decisions).toBe(0);
    expect(result.snapshot.race).toMatchObject({
      status: 'running',
      checkpointIndex: 3,
      pearlCount: 2,
    });
    expect(result.snapshot.collectedPearlIds).toEqual([
      'pearl-entry',
      'pearl-bend',
    ]);
    expect(
      Math.hypot(
        ...result.snapshot.fish.position.map(
          (value, axis) => value - expectedPosition[axis],
        ),
      ),
    ).toBeLessThanOrEqual(0.001);
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
    expect(frames).toHaveBeenCalledTimes(steps);
    if (steps === 964) {
      const frame = (index: number) => {
        const read = frames.mock.results[index];
        if (read?.type !== 'return')
          throw new Error(`Missing replay input frame ${index}.`);
        return read.value;
      };
      expect(frame(923).throttle).toBe(0);
      expect(frame(934).steerY).toBe(-1);
      expect(frame(944).steerY).toBe(0);
      expect(frame(949).throttle).toBe(-1);
    }
    console.info(
      JSON.stringify({
        asymmetricReplaySteps: steps,
        observations: result.observations,
        position: result.snapshot.fish.position,
        maxErrors: result.maxErrors,
      }),
    );
  },
);

it('matches all four asymmetric model edges to the untouched recorded chord', async () => {
  const data = await loadSunlitChordWitness();
  const delivered = control.sunlitPulseTimeline(
    false,
    recordedChord,
    asymmetricTiming,
    true,
  );
  expect(
    delivered.events.map((event) => ({
      steps: event.at + 893,
      code: event.key === 'w' ? 'KeyW' : event.key,
      type: event.type,
    })),
  ).toEqual(
    data.events.slice(42, 46).map((event) => {
      if (event.kind !== 'key') throw new Error('Missing recorded chord key.');
      return { steps: event.steps, code: event.code, type: event.type };
    }),
  );
  expect(delivered.observeAt).toBe(71);
  expect(delivered.events.some((event) => event.key === 's')).toBe(false);
});

it('bridges asymmetric prediction to original runtime and rejects the symmetric phase model', async () => {
  const data = await loadSunlitChordWitness();
  const before = await replaySunlitTiming(
    { ...data, events: data.events.slice(0, 42) },
    { mode: 'motion', scenario: 'asymmetric-bridge-before' },
  );
  const after = await replaySunlitTiming(data, {
    mode: 'motion',
    scenario: 'asymmetric-bridge-after',
  });
  const original = structuredClone(before.snapshot);
  const route = {
    position: before.snapshot.fish.position,
    checkpointIndex: before.snapshot.race.checkpointIndex,
    pearlCount: before.snapshot.race.pearlCount,
  };
  const waypoint = advanceSunlitWaypoint(0, route);
  const target = sunlitSteeringTarget(waypoint, route);
  expect(waypoint).toBe(5);
  expect(target.approachingCheckpoint).toBe(false);
  const observed = {
    fish: before.snapshot.fish,
    steps: before.steps,
    waypoint,
    approachingCheckpoint: target.approachingCheckpoint,
    brakeHeld: false,
    slowing: true,
    checkpointIndex: before.snapshot.race.checkpointIndex,
    collectedPearlIds: before.snapshot.collectedPearlIds,
  };
  const forecast = control.predictSunlitPulse(
    observed,
    recordedChord,
    asymmetricTiming,
  );
  expect(forecast.evaluationAt).toBe(71);
  expect(forecast.boundaryFish).toBe(forecast.evaluationFish);
  const errors = {
    position: 0,
    velocity: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    dashEnergy: Math.abs(
      forecast.boundaryFish.dashEnergy - after.snapshot.fish.dashEnergy,
    ),
  };
  for (const key of ['position', 'velocity'] as const) {
    errors[key] = Math.hypot(
      ...forecast.boundaryFish[key].map(
        (value, axis) => value - after.snapshot.fish[key][axis],
      ),
    );
    expect(errors[key]).toBeLessThanOrEqual(0.001);
  }
  for (const key of ['yaw', 'pitch', 'roll'] as const) {
    const delta = forecast.boundaryFish[key] - after.snapshot.fish[key];
    errors[key] = Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
    expect(errors[key]).toBeLessThanOrEqual(0.00001);
  }
  expect(errors.dashEnergy).toBeLessThanOrEqual(0.00000001);
  expect(forecast.boundaryFish.isSubmerged).toBe(
    after.snapshot.fish.isSubmerged,
  );
  const goals = control.sunlitPulseGoals(observed, true);
  expect(goals[forecast.boundaryGoalIndex]?.id).toBe('pearl-passage');
  const passage = goals.findIndex((goal) => goal.id === 'pearl-passage');
  expect(passage).toBe(0);
  const contact = forecast.contacts[passage];
  expect(contact === null || contact > 71).toBe(true);
  expect(after.snapshot.collectedPearlIds).not.toContain('pearl-passage');
  const symmetricForecast = control.predictSunlitPulse(
    observed,
    recordedChord,
    {
      onsetSteps: 30,
      holdSteps: 10,
      observationSteps: 15,
      skewSteps: 8,
    },
  );
  expect(symmetricForecast.evaluationAt).toBe(71);
  const symmetricPositionError = Math.hypot(
    ...symmetricForecast.boundaryFish.position.map(
      (value, axis) => value - after.snapshot.fish.position[axis],
    ),
  );
  expect(symmetricPositionError).toBeGreaterThan(0.001);
  expect(before.snapshot).toEqual(original);
  console.info(
    JSON.stringify({
      asymmetricForecastErrors: errors,
      symmetricPositionError,
    }),
  );
});

it('rejects the same-length symmetric phase in asymmetric original-runtime replay', async () => {
  const data = await loadSunlitChordWitness();
  const shifted = {
    ...data,
    events: data.events.map((event) =>
      event.kind === 'key' && (event.sequence === 43 || event.sequence === 44)
        ? { ...event, steps: event.steps - 3 }
        : event,
    ),
  };
  await expect(
    replaySunlitTiming(shifted, {
      mode: 'motion',
      scenario: 'asymmetric-negative',
    }),
  ).rejects.toThrow(/record 46 step 964 position/);
  expect(data.events[43].steps).toBe(934);
  expect(data.events[44].steps).toBe(944);
});

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
