import type { InputStamp } from '../../src/game/core/exposeGameHost';
import type { HostSnapshot } from '../../src/game/core/GameHost';

export type NativeObservedState = Pick<
  HostSnapshot,
  'screen' | 'frame' | 'player' | 'race' | 'collectedPearlIds' | 'preferences'
>;

export interface NativeObservationAnchor {
  readonly player: HostSnapshot['player'];
  readonly courseId: string | null;
  readonly elapsedMs: number | null;
  readonly checkpointIndex: number | null;
  readonly pearlCount: number | null;
  readonly status: string | null;
  readonly collectedPearlIds: readonly string[];
  readonly mouseSteering: boolean;
}

export type NativeTimingEvent = InputStamp & {
  readonly sequence: number;
  readonly time: number;
} & (
    | { readonly kind: 'observation'; readonly anchor: NativeObservationAnchor }
    | {
        readonly kind: 'key';
        readonly type: 'keydown' | 'keyup';
        readonly code: string;
        readonly repeat: boolean;
        readonly isTrusted: boolean;
        readonly defaultPrevented: boolean;
        readonly canvasTarget: boolean;
        readonly altKey: boolean;
        readonly ctrlKey: boolean;
        readonly metaKey: boolean;
      }
  );

export interface NativeTimingData {
  readonly version: 1;
  readonly events: readonly NativeTimingEvent[];
  readonly failure: string | null;
}

export interface NativeInputRecorder {
  observe(state: NativeObservedState): void;
  finish(): Promise<NativeTimingData>;
}

export function installNativeInputRecorder(
  capacity: number,
): NativeInputRecorder {
  if (!Number.isSafeInteger(capacity) || capacity <= 0)
    throw new Error(
      'Native recording capacity must be a positive safe integer.',
    );
  const hook = window.__REEF_RUSH_TEST__;
  const canvas = document.querySelector('#game-root canvas');
  if (!hook || !canvas)
    throw new Error('Native recording requires the active acceptance host.');
  const keys = new Set([
    'KeyW',
    'KeyS',
    'KeyA',
    'KeyD',
    'ArrowUp',
    'ArrowDown',
    'ShiftLeft',
    'ShiftRight',
  ]);
  const events: NativeTimingEvent[] = [];
  let failure: string | null = null;
  let previous: InputStamp | undefined;
  let lastTime = -Infinity;
  let completion: Promise<NativeTimingData> | undefined;

  function fail(message: string): void {
    failure ??= message;
  }

  function stamp(): InputStamp | undefined {
    if (failure) return;
    if (window.__REEF_RUSH_TEST__ !== hook) {
      fail('Native recording owner changed.');
      return;
    }
    const value = hook!.getInputStamp();
    if (
      ![value.steps, value.rendered, value.inputResets].every(
        (counter) => Number.isSafeInteger(counter) && counter >= 0,
      ) ||
      (previous &&
        (value.steps < previous.steps || value.rendered < previous.rendered))
    )
      fail('Native recording counters are invalid or decreased.');
    else if (
      value.settingsOpen ||
      value.graphicsLost ||
      (value.screen !== 'playing' && value.screen !== 'results')
    )
      fail('Native recording input gate was interrupted.');
    else if (previous) {
      const terminal =
        previous.screen === 'playing' && value.screen === 'results';
      if (value.inputResets - previous.inputResets !== (terminal ? 1 : 0))
        fail('Native recording input reset history is interrupted.');
      else if (previous.screen === 'results' && value.screen !== 'results')
        fail('Native recording returned from results.');
    }
    if (failure) return;
    previous = { ...value };
    return previous;
  }

  function append(
    body:
      | { kind: 'observation'; anchor: NativeObservationAnchor }
      | Omit<
          Extract<NativeTimingEvent, { kind: 'key' }>,
          keyof InputStamp | 'sequence' | 'time'
        >,
    value: InputStamp,
  ): void {
    if (failure) return;
    const time = performance.now();
    if (!Number.isFinite(time) || time < 0 || time < lastTime) {
      fail('Native recording clock is invalid or decreased.');
      return;
    }
    if (events.length >= capacity) {
      fail('Native recording capacity exhausted; evidence is incomplete.');
      return;
    }
    lastTime = time;
    events.push({ ...value, ...body, sequence: events.length, time });
  }

  function observe(state: NativeObservedState): void {
    if (completion) throw new Error('Native recording is finished.');
    const value = stamp();
    if (!value) return;
    if (
      state.screen !== value.screen ||
      state.frame.steps !== value.steps ||
      state.frame.rendered !== value.rendered
    ) {
      fail('Native recording observation counters do not correlate.');
      return;
    }
    const player = state.player;
    const race = state.race;
    if (!player || !race || state.preferences.mouseSteering) {
      fail(
        'Native recording requires active motion anchors and keyboard steering.',
      );
      return;
    }
    const anchor: NativeObservationAnchor = {
      player: {
        position: [player.position[0], player.position[1], player.position[2]],
        velocity: [player.velocity[0], player.velocity[1], player.velocity[2]],
        yaw: player.yaw,
        pitch: player.pitch,
        roll: player.roll,
        dashEnergy: player.dashEnergy,
        isSubmerged: player.isSubmerged,
      },
      courseId: race.courseId,
      elapsedMs: race.elapsedMs,
      checkpointIndex: race.checkpointIndex,
      pearlCount: race.pearlCount,
      status: race.status,
      collectedPearlIds: [...state.collectedPearlIds],
      mouseSteering: state.preferences.mouseSteering,
    };
    append({ kind: 'observation', anchor }, value);
  }

  function key(event: KeyboardEvent, type: 'keydown' | 'keyup'): void {
    if (!keys.has(event.code)) return;
    const body = {
      kind: 'key' as const,
      type,
      code: event.code,
      repeat: event.repeat,
      isTrusted: event.isTrusted,
      defaultPrevented: event.defaultPrevented,
      canvasTarget: event.target === canvas,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    };
    queueMicrotask(() => {
      const value = stamp();
      if (!value) return;
      append(body, value);
      if (
        type === 'keydown' &&
        (!body.canvasTarget ||
          body.altKey ||
          body.ctrlKey ||
          body.metaKey ||
          (value.screen === 'playing' && !body.defaultPrevented))
      )
        fail(
          'Native recording observed an ignored or unordered gameplay keydown.',
        );
    });
  }

  const down = (event: KeyboardEvent) => key(event, 'keydown');
  const up = (event: KeyboardEvent) => key(event, 'keyup');
  const blur = () => fail('Native recording was interrupted by window blur.');
  const visibility = () => {
    if (document.visibilityState !== 'visible')
      fail('Native recording was interrupted by hidden visibility.');
  };
  const initial = stamp();
  if (initial?.screen !== 'playing')
    fail('Native recording did not start during active play.');
  visibility();
  // Installed after the host's window bubble handlers, without intercepting input.
  window.addEventListener('keydown', down, { passive: true });
  window.addEventListener('keyup', up, { passive: true });
  window.addEventListener('blur', blur, { passive: true });
  document.addEventListener('visibilitychange', visibility, { passive: true });

  function freeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }

  return Object.freeze({
    observe,
    finish() {
      if (!completion) {
        window.removeEventListener('keydown', down);
        window.removeEventListener('keyup', up);
        window.removeEventListener('blur', blur);
        document.removeEventListener('visibilitychange', visibility);
        completion = Promise.resolve().then(() => {
          stamp();
          return freeze({ version: 1 as const, events: [...events], failure });
        });
      }
      return completion;
    },
  });
}
