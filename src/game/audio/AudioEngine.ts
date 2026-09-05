import {
  DEFAULT_SETTINGS,
  parseSettings,
  type Settings,
} from '../../settings/settings';
import { AudioGraph } from './AudioGraph';

export type AudioCue =
  | 'dash'
  | 'checkpoint'
  | 'pearl'
  | 'finish'
  | 'collision'
  | 'hazard'
  | 'breach'
  | 'splashdown';
export type AudioPhase = 'idle' | 'playing' | 'paused' | 'results';
export type AudioStatus =
  | 'locked'
  | 'unlocking'
  | 'ready'
  | 'blocked'
  | 'unavailable'
  | 'failed'
  | 'disposing'
  | 'disposed';
export type AudioDropReason =
  'inactive' | 'not-ready' | 'cooldown' | 'capacity' | 'failed';

// Structural subsets of the native API: native nodes and deterministic fakes
// both satisfy these interfaces without an adapter or unsafe casts.
export interface AudioParamPort {
  value: number;
  setValueAtTime(value: number, time: number): AudioParamPort;
  linearRampToValueAtTime(value: number, time: number): AudioParamPort;
  cancelAndHoldAtTime(time: number): AudioParamPort;
  cancelScheduledValues(time: number): AudioParamPort;
}
export interface AudioNodePort {
  connect(destination: AudioNodePort): AudioNodePort;
  disconnect(): void;
}
export interface AudioGainPort extends AudioNodePort {
  readonly gain: AudioParamPort;
}
export interface AudioOscillatorPort extends AudioNodePort {
  type: OscillatorType;
  readonly frequency: AudioParamPort;
  onended: ((event: Event) => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}
export interface AudioContextPort {
  readonly currentTime: number;
  readonly state: AudioContextState;
  readonly destination: AudioNodePort;
  onstatechange: ((event: Event) => void) | null;
  createGain(): AudioGainPort;
  createOscillator(): AudioOscillatorPort;
  resume(): Promise<void>;
  close(): Promise<void>;
}
export interface AudioEngineDependencies {
  /** Tests may supply a factory or constructor with the same native API shape. */
  readonly createContext?: () => AudioContextPort;
  readonly AudioContext?: new () => AudioContextPort;
  readonly isUserGesture?: () => boolean;
}
export interface AudioSnapshot {
  readonly status: AudioStatus;
  readonly phase: AudioPhase;
  readonly settings: Settings;
  readonly notice: string | null;
  readonly cause: unknown;
  readonly contextState: AudioContextState | null;
  readonly ownsContext: boolean;
  /** Includes retired nodes whose synchronous releases have not succeeded. */
  readonly ownedNodes: number;
  /** May remain true after disposal: shutdown never waits for resume. */
  readonly pendingUnlock: boolean;
  readonly pendingCleanup: boolean;
  readonly cleanupErrors: readonly unknown[];
  /** The latest observer fault, separate from backend and cleanup outcomes. */
  readonly observerErrors: readonly unknown[];
  readonly activeEffects: number;
  readonly activeAmbience: number;
  readonly emittedCues: Readonly<Record<AudioCue, number>>;
  readonly emittedCount: number;
  readonly droppedCount: number;
  readonly replacedCount: number;
  readonly lastCue: AudioCue | null;
  readonly lastDropReason: AudioDropReason | null;
}
export interface AudioEngine {
  /** Gesture-only; optional backend failures resolve to an observable status. */
  unlock(): Promise<AudioSnapshot>;
  /** Parses complete Settings before mutation; malformed input throws. */
  setSettings(input: unknown): void;
  setPhase(phase: AudioPhase): void;
  /** True only after successful start and bounded stop scheduling; never queues. */
  play(cue: AudioCue): boolean;
  getState(): AudioSnapshot;
  getSnapshot(): AudioSnapshot;
  subscribe(listener: () => void): () => void;
  /** Terminal. Silences/closes immediately; rejects AggregateError on cleanup failure. */
  dispose(): Promise<void>;
  /** Retries failed work only. Live recovery stays locked until another unlock. */
  retryCleanup(): Promise<void>;
}

/** Create once per host; course replays keep this owner and its healthy context. */
export function createAudioEngine(
  deps: AudioEngineDependencies = {},
): AudioEngine {
  let settings = DEFAULT_SETTINGS;
  let phase: AudioPhase = 'idle';
  let status: AudioStatus = 'locked';
  let notice: string | null = null;
  let cause: unknown = null;
  let context: AudioContextPort | null = null;
  let graph: AudioGraph | null = null;
  let unlockPromise: Promise<AudioSnapshot> | null = null;
  let disposePromise: Promise<void> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let closeErrors: unknown[] = [];
  let silenceErrors: unknown[] = [];
  let observerErrors: unknown[] = [];
  let intent = 0;
  let disposed = false;
  let droppedCount = 0;
  let emittedCount = 0;
  let replacedCount = 0;
  let lastCue: AudioCue | null = null;
  let lastDropReason: AudioDropReason | null = null;
  const lastPlayed = new Map<AudioCue, number>();
  const listeners = new Set<() => void>();
  const emittedCues: Record<AudioCue, number> = {
    dash: 0,
    checkpoint: 0,
    pearl: 0,
    finish: 0,
    collision: 0,
    hazard: 0,
    breach: 0,
    splashdown: 0,
  };

  function snapshot(): AudioSnapshot {
    return Object.freeze({
      status,
      phase,
      settings,
      notice:
        notice ??
        (observerErrors.length > 0 ? 'An audio status listener failed.' : null),
      cause,
      contextState: context?.state ?? null,
      ownsContext: context !== null,
      ownedNodes: graph?.ownedNodes ?? 0,
      pendingUnlock: unlockPromise !== null,
      pendingCleanup: Boolean(
        graph?.pendingCleanup ||
        silenceErrors.length ||
        cleanupPromise ||
        (disposed && context),
      ),
      cleanupErrors: Object.freeze([
        ...(graph?.cleanupErrors ?? []),
        ...silenceErrors,
        ...closeErrors,
      ]),
      observerErrors: Object.freeze([...observerErrors]),
      activeEffects: graph?.activeEffects ?? 0,
      activeAmbience: graph?.activeAmbience ?? 0,
      emittedCues: Object.freeze({ ...emittedCues }),
      emittedCount,
      droppedCount,
      replacedCount,
      lastCue,
      lastDropReason,
    });
  }
  let state = snapshot();
  function publish() {
    state = snapshot();
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch (error) {
        observerErrors = [error];
        state = snapshot();
      }
    }
  }
  function audioEnabled() {
    return (
      settings.masterVolume > 0 &&
      (settings.sfxEnabled || settings.musicEnabled)
    );
  }
  function fail(error: unknown, unlocking = false) {
    intent++;
    cause = error;
    status =
      unlocking &&
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'NotAllowedError'
        ? 'blocked'
        : 'failed';
    notice = unlocking
      ? 'Audio could not be unlocked.'
      : 'Audio failed; cleanup can be retried.';
    const errors = graph?.silence() ?? [];
    silenceErrors = errors.filter(
      (error) => !graph?.cleanupErrors.includes(error),
    );
  }
  function reconcile() {
    if (!graph || status === 'failed') return;
    if (status === 'ready' && context?.state !== 'running') {
      status = 'blocked';
      notice = 'Audio context is not running; a new user gesture is required.';
    }
    const audible =
      !disposed &&
      status === 'ready' &&
      audioEnabled() &&
      (phase === 'playing' || (phase === 'results' && settings.sfxEnabled));
    try {
      graph.setVolume(audible ? settings.masterVolume : 0);
      const errors = graph.stopWhere(
        (cue) =>
          !audible ||
          (cue === 'ambience'
            ? !settings.musicEnabled || phase !== 'playing'
            : !settings.sfxEnabled ||
              (phase === 'results' && cue !== 'finish')),
      );
      if (errors.length > 0) throw errors[0];
      if (
        audible &&
        phase === 'playing' &&
        settings.musicEnabled &&
        graph.activeAmbience === 0
      ) {
        graph.start('ambience');
      }
    } catch (error) {
      fail(error);
    }
  }
  function unlock(): Promise<AudioSnapshot> {
    if (disposed) return Promise.resolve(state);
    if (unlockPromise) return unlockPromise;
    if (graph?.pendingCleanup || silenceErrors.length || cleanupPromise)
      return Promise.resolve(state);
    if (!audioEnabled()) return Promise.resolve(state);
    const trusted =
      deps.isUserGesture ??
      (() =>
        typeof navigator !== 'undefined' &&
        navigator.userActivation?.isActive === true);
    try {
      if (!trusted()) {
        status = 'blocked';
        notice = 'Audio requires an active user gesture.';
        reconcile();
        publish();
        return Promise.resolve(state);
      }
      if (!context) {
        const Constructor = deps.AudioContext ?? globalThis.AudioContext;
        if (!deps.createContext && !Constructor) {
          status = 'unavailable';
          notice = 'Web Audio is not available in this environment.';
          publish();
          return Promise.resolve(state);
        }
        context = deps.createContext ? deps.createContext() : new Constructor();
        graph = new AudioGraph(
          context,
          () => {
            reconcile();
            publish();
          },
          (error) => {
            fail(error);
            publish();
          },
        );
        const owned = context;
        context.onstatechange = () => {
          if (disposed || context !== owned) return;
          reconcile();
          publish();
        };
      }
      graph?.initialize();
      return resumeOwned(context);
    } catch (error) {
      fail(error, true);
      publish();
      return Promise.resolve(state);
    }
  }
  function resumeOwned(owned: AudioContextPort): Promise<AudioSnapshot> {
    const requestedIntent = intent;
    let resolve!: (snapshot: AudioSnapshot) => void;
    const work = new Promise<AudioSnapshot>((yes) => {
      resolve = yes;
    });
    // Reserve the shared promise before native code can dispatch a state event.
    unlockPromise = work;
    status = 'unlocking';
    function finish(failure?: { cause: unknown }) {
      unlockPromise = null;
      if (!disposed && context === owned && intent === requestedIntent) {
        if (failure) fail(failure.cause, true);
        else {
          status = owned.state === 'running' ? 'ready' : 'blocked';
          cause = null;
          notice = status === 'ready' ? null : 'Audio context did not resume.';
          reconcile();
        }
      } else if (!disposed && status === 'unlocking') {
        status = 'locked';
      }
      publish();
      resolve(state);
    }
    try {
      const resuming =
        owned.state === 'running' ? Promise.resolve() : owned.resume();
      void resuming.then(
        () => finish(),
        (error: unknown) => finish({ cause: error }),
      );
    } catch (error) {
      finish({ cause: error });
      return work;
    }
    publish();
    return work;
  }
  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    disposed = true;
    intent++;
    if (context) context.onstatechange = null;
    return cleanup();
  }
  function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const work = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    cleanupPromise = work;
    if (disposed) {
      disposePromise = work;
      status = 'disposing';
    }
    // Silence starts synchronously; no dependency on a pending resume or host save.
    // cleanup visits each node once, so failed work waits for an explicit retry.
    const errors: unknown[] = [];
    if ((disposed || silenceErrors.length > 0) && graph) {
      silenceErrors = [];
      try {
        graph.setVolume(0);
      } catch (error) {
        silenceErrors = [error];
        errors.push(error);
      }
    }
    errors.push(...(graph?.cleanup(disposed) ?? []));
    const owned = disposed ? context : null;
    if (!owned) {
      finish();
      return work;
    }
    let closing: Promise<void>;
    try {
      closing = owned.state !== 'closed' ? owned.close() : Promise.resolve();
    } catch (error) {
      closeErrors = [error];
      errors.push(error);
      finish();
      return work;
    }
    void closing.then(
      () => {
        if (owned) context = null;
        closeErrors = [];
        finish();
      },
      (error: unknown) => {
        closeErrors = [error];
        errors.push(error);
        finish();
      },
    );
    function finish() {
      cleanupPromise = null;
      if (errors.length > 0) {
        cause ??= errors[0];
        status = 'failed';
        notice = 'Audio cleanup failed; retryCleanup is required.';
        publish();
        reject(new AggregateError(errors, notice, { cause }));
      } else {
        status = disposed ? 'disposed' : 'locked';
        cause = null;
        notice = null;
        if (disposed) graph = null;
        publish();
        resolve();
      }
    }
    publish();
    return work;
  }
  function drop(reason: AudioDropReason): false {
    droppedCount++;
    lastDropReason = reason;
    publish();
    return false;
  }
  return {
    unlock,
    setSettings(input) {
      const parsed = parseSettings(input);
      if (disposed) return;
      if (
        (Object.keys(parsed) as Array<keyof Settings>).every(
          (key) => parsed[key] === settings[key],
        )
      )
        return;
      settings = parsed;
      if (!audioEnabled()) intent++;
      reconcile();
      publish();
    },
    setPhase(next) {
      if (!['idle', 'playing', 'paused', 'results'].includes(next)) {
        throw new TypeError(`Invalid audio phase: ${String(next)}`);
      }
      if (disposed || phase === next) return;
      phase = next;
      if (phase === 'paused' || phase === 'idle') {
        intent++;
        lastPlayed.clear();
      }
      reconcile();
      publish();
    },
    play(cue) {
      if (!Object.hasOwn(emittedCues, cue)) {
        throw new TypeError(`Invalid audio cue: ${String(cue)}`);
      }
      if (
        disposed ||
        !audioEnabled() ||
        !settings.sfxEnabled ||
        (phase !== 'playing' && !(phase === 'results' && cue === 'finish'))
      ) {
        return drop('inactive');
      }
      reconcile();
      if (status !== 'ready' || !context || !graph) {
        return drop(status === 'failed' ? 'failed' : 'not-ready');
      }
      const now = context.currentTime;
      const cooldown = cue === 'collision' || cue === 'hazard' ? 0.25 : 0.06;
      if (now - (lastPlayed.get(cue) ?? -Infinity) < cooldown)
        return drop('cooldown');
      try {
        if (graph.activeEffects >= 8) {
          if (cue !== 'finish' || !graph.replaceOldestEffect())
            return drop('capacity');
          replacedCount++;
        }
        graph.start(cue);
      } catch (error) {
        fail(error);
        return drop('failed');
      }
      lastPlayed.set(cue, now);
      emittedCues[cue]++;
      emittedCount++;
      lastCue = cue;
      publish();
      return true;
    },
    getState: () => state,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose,
    retryCleanup() {
      if (cleanupPromise) return cleanupPromise;
      if (disposed && status === 'disposed')
        return disposePromise ?? Promise.resolve();
      if (
        !disposed &&
        status !== 'failed' &&
        !graph?.pendingCleanup &&
        silenceErrors.length === 0
      )
        return Promise.resolve();
      return cleanup();
    },
  };
}
