import sunlit from '../../src/content/courses/sunlitShoals';
import { createAssetCache } from '../../src/game/assets/AssetCache';
import { createSceneRuntime } from '../../src/game/core/SceneRuntime';
import { InputController } from '../../src/game/input/InputController';
import type { RaceEvent } from '../../src/game/race/raceTypes';
import { TRAVERSAL_MAX_STEPS, TRAVERSAL_STEP_SECONDS } from './courseTraversal';
import { releaseNativeKeys } from './nativeKeyboard';
import { localAssetLoader } from './originalAssets';
import {
  sunlitPulsePolicy,
  sunlitPulseTimeline,
  type SunlitPulseCommand,
  type SunlitPulseObservation,
  type SunlitPulseTiming,
} from './sunlitPulsePolicy';
import {
  advanceSunlitWaypoint,
  sunlitSteeringTarget,
} from './sunlitWaypointPolicy';

export interface SunlitPulseProfile {
  readonly initialSteps: number;
  readonly timings: readonly SunlitPulseTiming[];
  readonly isolatedDelay?: {
    readonly decision: number;
    readonly timing: SunlitPulseTiming;
  };
  readonly maxSteps?: number;
  readonly maxDecisions?: number;
  readonly policy?: (observation: SunlitPulseObservation) => SunlitPulseCommand;
}

export async function simulateSunlitPulses(profile: SunlitPulseProfile) {
  const maxSteps = profile.maxSteps ?? TRAVERSAL_MAX_STEPS;
  const maxDecisions = profile.maxDecisions ?? maxSteps;
  if (
    !Number.isSafeInteger(profile.initialSteps) ||
    profile.initialSteps < 0 ||
    !Number.isSafeInteger(maxSteps) ||
    maxSteps <= profile.initialSteps ||
    maxSteps > TRAVERSAL_MAX_STEPS ||
    !Number.isSafeInteger(maxDecisions) ||
    maxDecisions < 1 ||
    !profile.timings.length
  )
    throw new RangeError('Invalid bounded pulse simulation profile.');
  const loadedAssets: string[] = [];
  const cache = createAssetCache({
    loader: {
      loadAsync(url) {
        loadedAssets.push(url.slice('/reef-rush/assets/'.length));
        return localAssetLoader.loadAsync(url);
      },
    },
  });
  const runtime = await createSceneRuntime(sunlit, { assetCache: cache });
  const failures: unknown[] = [];
  const owned = new Set<string>();
  const events: RaceEvent[] = [];
  const deliveries: Array<{
    tick: number;
    steps: number;
    key: string;
    type: 'keydown' | 'keyup';
    accepted: boolean;
  }> = [];
  const decisions: Array<{
    steps: number;
    waypoint: number;
    approachingCheckpoint: boolean;
    observation: SunlitPulseObservation;
    position: readonly number[];
    command: SunlitPulseCommand;
    timing: SunlitPulseTiming;
  }> = [];
  let state = runtime.getSnapshot();
  let input: InputController | undefined;
  let steps = 0;
  let tick = 0;
  let waypoint = 0;
  let approachingCheckpoint = false;
  let previousSteps: number | undefined;

  function deliver(key: string, type: 'keydown' | 'keyup') {
    if (type === 'keydown') {
      if (owned.has(key))
        throw new Error(`Duplicate simulated ownership: ${key}`);
      owned.add(key);
    } else if (!owned.has(key)) {
      throw new Error(`Simulated release without ownership: ${key}`);
    }
    const code =
      key === 'Shift'
        ? 'ShiftLeft'
        : key.length === 1
          ? `Key${key.toUpperCase()}`
          : key;
    const event = new KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    deliveries.push({
      tick,
      steps,
      key,
      type,
      accepted: event.defaultPrevented,
    });
    if (type === 'keyup') owned.delete(key);
  }

  function advance(count: number) {
    if (!input) throw new Error('Pulse simulation input is not initialized.');
    for (let index = 0; index < count; index++) {
      // Protocol time still advances after finish; completed physics does not.
      if (state.race.status === 'running' && steps < maxSteps) {
        const result = runtime.step(input.readFrame(), TRAVERSAL_STEP_SECONDS);
        steps++;
        state = result.snapshot;
        events.push(...result.raceEvents);
        if (result.finished) input.clear();
      }
      tick++;
    }
  }

  try {
    runtime.start();
    state = runtime.getSnapshot();
    input = new InputController(window, {
      isPlaying: () => state.race.status === 'running',
      preferences: {
        mouseSteering: false,
        mouseSensitivity: 1,
        invertMouseY: false,
      },
    });
    advance(profile.initialSteps);
    while (
      state.race.status === 'running' &&
      steps < maxSteps &&
      decisions.length < maxDecisions
    ) {
      const route = {
        position: state.fish.position,
        checkpointIndex: state.race.checkpointIndex,
        pearlCount: state.race.pearlCount,
      };
      const nextWaypoint = advanceSunlitWaypoint(waypoint, route);
      if (nextWaypoint !== waypoint) approachingCheckpoint = false;
      waypoint = nextWaypoint;
      approachingCheckpoint = sunlitSteeringTarget(
        waypoint,
        route,
        approachingCheckpoint,
      ).approachingCheckpoint;
      const observation: SunlitPulseObservation = {
        fish: state.fish,
        steps,
        previousSteps,
        waypoint,
        approachingCheckpoint,
        brakeHeld: owned.has('Shift'),
        slowing: owned.has('s'),
        accelerating: owned.has('w'),
        checkpointIndex: state.race.checkpointIndex,
        collectedPearlIds: state.collectedPearlIds,
      };
      const command = (profile.policy ?? sunlitPulsePolicy)(observation);
      const timing =
        profile.isolatedDelay?.decision === decisions.length
          ? profile.isolatedDelay.timing
          : profile.timings[decisions.length % profile.timings.length];
      const timeline = sunlitPulseTimeline(
        owned.has('Shift'),
        command,
        timing,
        owned.has('s'),
        owned.has('w'),
      );
      if (timeline.observeAt > maxSteps)
        throw new RangeError('Pulse delivery exceeds the simulation budget.');
      decisions.push({
        steps,
        waypoint,
        approachingCheckpoint,
        observation,
        position: state.fish.position,
        command,
        timing,
      });
      previousSteps = steps;
      let cursor = 0;
      for (const edge of timeline.events) {
        advance(edge.at - cursor);
        deliver(edge.key, edge.type);
        cursor = edge.at;
      }
      advance(timeline.observeAt - cursor);
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    await releaseNativeKeys(
      {
        up: (key) => Promise.resolve().then(() => deliver(key, 'keyup')),
        down: (key) => Promise.resolve().then(() => deliver(key, 'keydown')),
      },
      owned,
    );
  } catch (error) {
    failures.push(error);
  }
  for (const release of [() => input?.destroy(), () => runtime.dispose()]) {
    try {
      release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, 'Pulse simulation and cleanup failed.');
  const released = runtime.getDiagnostics();
  const assetOwnership = cache.getDiagnostics();
  if (
    owned.size ||
    released.lifecycle !== 'disposed' ||
    [
      released.bodies,
      released.colliders,
      released.geometries,
      released.materials,
    ].some((count) => count !== 0) ||
    Object.values(assetOwnership).some((count) => count !== 0)
  )
    throw new Error('Pulse simulation retained ownership.');
  return Object.freeze({
    steps,
    tick,
    waypoint,
    snapshot: state,
    decisions: Object.freeze(decisions),
    events: Object.freeze(events),
    deliveries: Object.freeze(deliveries),
    remainingOwnedKeys: Object.freeze([...owned]),
    loadedAssets: Object.freeze(loadedAssets),
    released,
    assetOwnership,
  });
}
