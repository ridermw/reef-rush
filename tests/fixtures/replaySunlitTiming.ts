import sunlit from '../../src/content/courses/sunlitShoals';
import { createAssetCache } from '../../src/game/assets/AssetCache';
import {
  createSceneRuntime,
  type SceneRuntime,
  type SceneSnapshot,
} from '../../src/game/core/SceneRuntime';
import { InputController } from '../../src/game/input/InputController';
import {
  courseKeyboardPolicy,
  type KeyboardObservation,
} from './courseKeyboardPolicy';
import type {
  NativeTimingData,
  NativeTimingEvent,
} from './nativeInputRecorder';
import { localAssetLoader } from './originalAssets';
import { TRAVERSAL_MAX_STEPS, TRAVERSAL_STEP_SECONDS } from './courseTraversal';
import {
  advanceSunlitWaypoint,
  sunlitSteeringTarget,
} from './sunlitWaypointPolicy';

export interface SunlitReplayOptions {
  readonly mode: 'motion' | 'baseline';
  readonly scenario?: string;
  readonly createRuntime?: () => Promise<SceneRuntime>;
  readonly baselinePolicy?: typeof courseKeyboardPolicy;
}

export interface SunlitReplayResult {
  readonly steps: number;
  readonly observations: number;
  readonly decisions: number;
  readonly snapshot: SceneSnapshot;
  readonly maxErrors: {
    readonly position: number;
    readonly velocity: number;
    readonly angle: number;
    readonly elapsedMs: number;
    readonly dashEnergy: number;
  };
  readonly released: ReturnType<SceneRuntime['getDiagnostics']>;
  readonly assetOwnership: ReturnType<
    ReturnType<typeof createAssetCache>['getDiagnostics']
  > | null;
}

export async function replaySunlitTiming(
  data: NativeTimingData,
  options: SunlitReplayOptions,
): Promise<SunlitReplayResult> {
  if (
    data.failure !== null ||
    !data.events.length ||
    data.events.length > 32_768
  )
    throw new Error('Replay requires bounded, uninterrupted timing data.');
  const cache = options.createRuntime
    ? undefined
    : createAssetCache({ loader: localAssetLoader });
  const runtime = options.createRuntime
    ? await options.createRuntime()
    : await createSceneRuntime(sunlit, { assetCache: cache });
  const failures: unknown[] = [];
  let input: InputController | undefined;
  let outcome:
    Omit<SunlitReplayResult, 'released' | 'assetOwnership'> | undefined;
  const maxErrors = {
    position: 0,
    velocity: 0,
    angle: 0,
    elapsedMs: 0,
    dashEnergy: 0,
  };
  let steps = 0;
  let observations = 0;
  let decisions = 0;
  let currentRecord = 0;
  const label = options.scenario ?? 'Sunlit timing';

  function mismatch(field: string, actual: unknown, expected: unknown): never {
    throw new Error(
      `${label} record ${currentRecord} step ${steps} ${field}: actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
  function error(
    metric: keyof typeof maxErrors,
    actual: number,
    expected: number,
    tolerance: number,
    difference = Math.abs(actual - expected),
  ): void {
    if (!Number.isFinite(difference) || difference > tolerance)
      mismatch(metric, actual, expected);
    maxErrors[metric] = Math.max(maxErrors[metric], difference);
  }

  try {
    runtime.start();
    let state = runtime.getSnapshot();
    input = new InputController(window, {
      isPlaying: () => state.race.status === 'running',
      preferences: {
        mouseSteering: false,
        mouseSensitivity: 1,
        invertMouseY: false,
      },
    });
    const nativeCode = {
      a: 'KeyA',
      d: 'KeyD',
      w: 'KeyW',
      s: 'KeyS',
      ArrowUp: 'ArrowUp',
      ArrowDown: 'ArrowDown',
      Shift: 'ShiftLeft',
    } as const;
    const owned = new Set<string>();
    const releases = new Set<string>();
    const presses = new Set<string>();
    const protocol: {
      phase: 'driving' | 'cleanup' | 'probe-down' | 'probe-up' | 'done';
    } = {
      phase: 'driving',
    };
    const policy = options.baselinePolicy ?? courseKeyboardPolicy;
    let previous: KeyboardObservation | undefined;
    let waypoint = 0;
    let approachingCheckpoint = false;

    function expectedCommand(
      event: Extract<NativeTimingEvent, { kind: 'key' }>,
    ) {
      if (protocol.phase === 'probe-down' || protocol.phase === 'probe-up') {
        const type = protocol.phase === 'probe-down' ? 'keydown' : 'keyup';
        if (event.code !== 'KeyW' || event.type !== type)
          mismatch('topology probe', event, { type, code: 'KeyW' });
        return { type, code: 'KeyW' };
      }
      if (protocol.phase === 'done')
        mismatch('topology after probe', event, 'end of tape');
      const type = releases.size ? 'keyup' : 'keydown';
      const pending = releases.size ? releases : presses;
      const code = [...pending].find((candidate) => candidate === event.code);
      if (event.type !== type || code === undefined)
        mismatch('topology delivery', event, { type, codes: [...pending] });
      return { type, code };
    }

    function settleCommand(command: { type: string; code: string }) {
      if (command.type === 'keyup') {
        if (!owned.delete(command.code))
          mismatch('topology release ownership', command.code, [...owned]);
        releases.delete(command.code);
      } else {
        if (owned.has(command.code))
          mismatch('topology duplicate ownership', command.code, [...owned]);
        owned.add(command.code);
        presses.delete(command.code);
      }
      if (protocol.phase === 'probe-down') protocol.phase = 'probe-up';
      else if (protocol.phase === 'probe-up') protocol.phase = 'done';
      else if (protocol.phase === 'cleanup' && !releases.size)
        protocol.phase = 'probe-down';
    }

    const initialResets = data.events[0].inputResets;
    for (const [index, event] of data.events.entries()) {
      currentRecord = index;
      if (
        event.sequence !== index ||
        !Number.isSafeInteger(event.steps) ||
        event.steps < steps ||
        event.steps > TRAVERSAL_MAX_STEPS
      )
        mismatch('event order/step bound', event, index);
      if (
        options.mode === 'baseline' &&
        event.kind === 'observation' &&
        (protocol.phase !== 'driving' || releases.size || presses.size)
      )
        mismatch(
          'topology pending at observation',
          [...releases, ...presses],
          [],
        );
      const command =
        options.mode === 'baseline' && event.kind === 'key'
          ? expectedCommand(event)
          : undefined;
      while (steps < event.steps) {
        if (state.race.status !== 'running')
          mismatch(
            'finished physics advancement',
            state.race.status,
            'running',
          );
        const advanced = runtime.step(
          input.readFrame(),
          TRAVERSAL_STEP_SECONDS,
        );
        steps++;
        state = advanced.snapshot;
        if (advanced.finished) input.clear();
      }
      const finished = state.race.status === 'finished';
      if (event.screen !== (finished ? 'results' : 'playing'))
        mismatch('screen', state.race.status, event.screen);
      if (event.inputResets !== initialResets + (finished ? 1 : 0))
        mismatch(
          'input reset',
          initialResets + (finished ? 1 : 0),
          event.inputResets,
        );
      if (event.kind === 'key') {
        const key = new KeyboardEvent(command?.type ?? event.type, {
          code: command?.code ?? event.code,
          repeat: event.repeat,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(key);
        if (key.defaultPrevented !== event.defaultPrevented)
          mismatch(
            'input eligibility',
            key.defaultPrevented,
            event.defaultPrevented,
          );
        if (command) settleCommand(command);
        continue;
      }
      const expected = event.anchor;
      if (!expected.player) mismatch('player', state.fish, expected.player);
      for (const metric of ['position', 'velocity'] as const) {
        const actual = state.fish[metric];
        const wanted = expected.player[metric];
        const distance = Math.hypot(
          ...actual.map((value, axis) => value - wanted[axis]),
        );
        if (!Number.isFinite(distance) || distance > 0.001)
          mismatch(metric, actual, wanted);
        maxErrors[metric] = Math.max(maxErrors[metric], distance);
      }
      for (const metric of ['yaw', 'pitch', 'roll'] as const) {
        const delta = state.fish[metric] - expected.player[metric];
        error(
          'angle',
          state.fish[metric],
          expected.player[metric],
          0.00001,
          Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))),
        );
      }
      error(
        'elapsedMs',
        state.race.elapsedMs,
        expected.elapsedMs ?? NaN,
        0.001,
      );
      error(
        'dashEnergy',
        state.fish.dashEnergy,
        expected.player.dashEnergy,
        0.00000001,
      );
      if (state.fish.isSubmerged !== expected.player.isSubmerged)
        mismatch(
          'isSubmerged',
          state.fish.isSubmerged,
          expected.player.isSubmerged,
        );
      for (const field of [
        'courseId',
        'checkpointIndex',
        'pearlCount',
        'status',
      ] as const) {
        if (state.race[field] !== expected[field])
          mismatch(field, state.race[field], expected[field]);
      }
      if (
        JSON.stringify(state.collectedPearlIds) !==
        JSON.stringify(expected.collectedPearlIds)
      )
        mismatch(
          'pearl identities',
          state.collectedPearlIds,
          expected.collectedPearlIds,
        );
      observations++;
      if (options.mode === 'baseline') {
        if (finished) {
          for (const code of owned) releases.add(code);
          protocol.phase = releases.size ? 'cleanup' : 'probe-down';
        } else {
          const route = {
            position: state.fish.position,
            checkpointIndex: state.race.checkpointIndex,
            pearlCount: state.race.pearlCount,
          };
          const nextWaypoint = advanceSunlitWaypoint(waypoint, route);
          if (nextWaypoint !== waypoint) approachingCheckpoint = false;
          waypoint = nextWaypoint;
          const steering = sunlitSteeringTarget(
            waypoint,
            route,
            approachingCheckpoint,
          );
          approachingCheckpoint = steering.approachingCheckpoint;
          const observation = { fish: state.fish, steps };
          const decision = policy({
            observation,
            previous,
            target: steering.target,
          });
          previous = observation;
          const desired = new Set<string>(
            decision.keys.map((key) => nativeCode[key]),
          );
          if (desired.size !== decision.keys.length)
            mismatch(
              'topology duplicate desired key',
              decision.keys,
              'unique keys',
            );
          for (const code of owned) if (!desired.has(code)) releases.add(code);
          for (const code of desired) if (!owned.has(code)) presses.add(code);
          decisions++;
        }
      }
    }
    if (!observations)
      mismatch('observation count', observations, 'at least one');
    if (
      options.mode === 'baseline' &&
      (protocol.phase !== 'done' || owned.size || releases.size || presses.size)
    )
      mismatch(
        'topology incomplete terminal protocol',
        protocol.phase,
        'done without owned or pending keys',
      );
    outcome = {
      steps,
      observations,
      decisions,
      snapshot: state,
      maxErrors: Object.freeze(maxErrors),
    };
  } catch (failure) {
    failures.push(failure);
  }
  for (const release of [() => input?.destroy(), () => runtime.dispose()]) {
    try {
      release();
    } catch (failure) {
      failures.push(failure);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, 'Replay and cleanup failed.');
  if (!outcome) throw new Error('Replay did not produce an outcome.');
  const released = runtime.getDiagnostics();
  const assetOwnership = cache?.getDiagnostics() ?? null;
  if (
    released.lifecycle !== 'disposed' ||
    [
      released.bodies,
      released.colliders,
      released.geometries,
      released.materials,
    ].some((count) => count !== 0) ||
    (assetOwnership &&
      Object.values(assetOwnership).some((count) => count !== 0))
  )
    throw new Error('Replay retained resource ownership.');
  return Object.freeze({ ...outcome, released, assetOwnership });
}
