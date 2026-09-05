import type { WebGLRenderer } from 'three';
import { canRetryCourse, type AppStore } from '../../app/appStore';
import { errorDetail } from './errorDetail';
import type { AppScreen } from '../../app/screens';
import type { CourseId } from '../../content/courses/courseIds';
import type { CourseDefinition } from '../course/courseDefinition';
import { InputController, isPauseKeyEvent } from '../input/InputController';
import {
  emptyProgress,
  mergeProgress,
  updateProgress,
  type Progress,
} from '../progression/progress';
import type { FinishedRaceResult, RaceState } from '../race/raceTypes';
import {
  PROGRESS_STORAGE_KEY,
  readProgress,
  replaceInvalidProgress,
  saveProgress,
  type ProgressRead,
  type ProgressReplacement,
  type StorageProvider,
} from '../save/progressStorage';
import type {
  SceneFishState,
  SceneRuntime,
  SceneSnapshot,
} from './SceneRuntime';
import { FixedStepRunner } from './fixedStep';
import { ConstructionCleanupError, releaseResources } from './resourceCleanup';
import { exposeGameHost } from './exposeGameHost';
import {
  createSettingsStore,
  type SettingsStore,
} from '../../settings/SettingsStore';
import type { Settings } from '../../settings/settings';
import {
  createAudioEngine,
  type AudioEngine,
  type AudioSnapshot,
} from '../audio/AudioEngine';
import { createRunFeedback, type RunFeedback } from './runFeedback';
import { finishAchievements } from '../progression/finishAchievements';

export type HostRenderer = Pick<
  WebGLRenderer,
  | 'domElement'
  | 'setPixelRatio'
  | 'setSize'
  | 'render'
  | 'dispose'
  | 'forceContextLoss'
>;
export type HostInput = Pick<
  InputController,
  'readFrame' | 'clear' | 'destroy' | 'setPreferences'
>;

export interface GameHostDependencies {
  readonly settings?: SettingsStore;
  readonly audio?: AudioEngine;
  readonly createRenderer?: () => Promise<HostRenderer>;
  readonly createInput?: (
    canvas: HTMLCanvasElement,
    isPlaying: () => boolean,
  ) => HostInput;
  readonly loadCourse?: (id: CourseId) => Promise<CourseDefinition>;
  readonly createScene?: (
    definition: CourseDefinition,
  ) => Promise<SceneRuntime>;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (id: number) => void;
  readonly now?: () => number;
  readonly isFocused?: () => boolean;
  readonly measure?: (
    container: HTMLElement,
  ) => Readonly<{ width: number; height: number; dpr: number }>;
  readonly observeResize?: (
    container: HTMLElement,
    callback: () => void,
  ) => () => void;
  readonly storage?: StorageProvider;
  /** Run the synchronous transaction once under an exclusive cross-host lock. */
  readonly coordinateProgress?: (
    save: () => void,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export type ProgressSaveResult =
  | { readonly status: 'saved' }
  | { readonly status: 'failed'; readonly cause: unknown };

export type ProgressRecoveryResult =
  ProgressReplacement | { readonly status: 'failed'; readonly cause: unknown };

export interface HostSnapshot {
  readonly preferences: Settings;
  readonly audio: AudioSnapshot;
  readonly feedback: RunFeedback | null;
  readonly screen: AppScreen;
  readonly graphicsLost: boolean;
  readonly player: SceneFishState | null;
  readonly race: RaceState | null;
  readonly collectedPearlIds: readonly string[];
  readonly lifecycle:
    'idle' | 'loading' | 'active' | 'cleanup-pending' | 'disposed';
  readonly cleanupError: string | null;
  readonly frame: Readonly<{ rendered: number; steps: number }>;
  readonly resources: Readonly<{
    canvases: number;
    rafChains: number;
    pendingCleanup: number;
    scene: ReturnType<SceneRuntime['getDiagnostics']> | null;
  }>;
}

function frozenCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, frozenCopy(child)]),
      ),
    ) as T;
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function coordinateProgress(
  save: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (typeof locks?.request !== 'function') {
    throw new Error(
      'Cannot persist safely: cross-tab save coordination is unavailable.',
    );
  }
  await locks.request(
    PROGRESS_STORAGE_KEY,
    signal ? { mode: 'exclusive', signal } : { mode: 'exclusive' },
    save,
  );
}

/** One long-lived owner per app store, independent of React's screen/remount lifetime. */
export class GameHost {
  readonly settings: SettingsStore;
  private readonly audio: AudioEngine;
  private readonly unsubscribeSettings: () => void;
  private readonly motionQuery: MediaQueryList | null;
  private audioShutdown: Promise<void> | null = null;
  private audioCleanupError: unknown = null;
  private settingsOpen = false;
  private loadingStartsPaused = false;
  private readonly feedback = createRunFeedback();
  private container: HTMLElement | null = null;
  private scene: SceneRuntime | null = null;
  private renderer: HostRenderer | null = null;
  private graphicsLost = false;
  private input: HostInput | null = null;
  private readonly ownedReleases: Array<() => void> = [];
  private readonly surfaceReleases: Array<() => void> = [];
  private readonly pendingReleases: Array<() => void> = [];
  private readonly constructionOwners = new Set<ConstructionCleanupError>();
  private lastCleanupError: unknown = null;
  private readonly runner = new FixedStepRunner();
  private readonly requestFrame;
  private readonly cancelFrame;
  private readonly now;
  private readonly unsubscribe;
  private removeHook: (() => void) | undefined;
  private generation = 0;
  private loadTail = Promise.resolve();
  private saveTail = Promise.resolve();
  private loading = false;
  private disposed = false;
  private reportingError = false;
  private observedScreen: AppScreen;
  private observedCourse: CourseId | null;
  private observedGraphicsLost: boolean;
  private frameId: number | null = null;
  private lastTime = 0;
  private lastHudTime = 0;
  private rendered = 0;
  private steps = 0;
  private hasSize = false;
  private progress: Progress;
  private notice: string | null = null;

  constructor(
    private readonly store: AppStore,
    private readonly deps: GameHostDependencies = {},
  ) {
    this.settings = deps.settings ?? createSettingsStore();
    this.motionQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    this.motionQuery?.addEventListener(
      'change',
      this.applyPresentationPreferences,
    );
    this.audio = deps.audio ?? createAudioEngine();
    this.audio.setSettings(this.settings.getState().settings);
    this.unsubscribeSettings = this.settings.subscribe(this.applySettings);
    this.requestFrame =
      deps.requestFrame ??
      ((callback) => window.requestAnimationFrame(callback));
    this.cancelFrame =
      deps.cancelFrame ?? ((id) => window.cancelAnimationFrame(id));
    this.now = deps.now ?? (() => performance.now());
    const saved = readProgress(deps.storage);
    switch (saved.status) {
      case 'empty':
      case 'loaded':
        this.progress = saved.progress;
        break;
      case 'invalid':
        this.progress = emptyProgress();
        this.notice =
          'Session-only progress: invalid existing save preserved; saving is blocked until the save is valid.';
        break;
      case 'unavailable':
        this.progress = emptyProgress();
        this.notice = `Session-only progress: storage unavailable (${message(saved.cause)}).`;
        break;
    }
    this.publishProgress();
    this.observedScreen = store.getState().screen;
    this.observedCourse = store.getState().selectedCourseId;
    this.observedGraphicsLost = store.getState().graphicsLost;
    this.unsubscribe = store.subscribe(this.onStoreChange);
    window.addEventListener('pagehide', this.onPageHide);
    if (import.meta.env.VITE_TEST_HOOKS === 'true') {
      this.removeHook = exposeGameHost(() => this.getSnapshot());
    }
  }

  readonly setSettingsOpen = (open: boolean): void => {
    this.settingsOpen = open;
    this.input?.clear();
  };

  /** Raw data is available only for explicit inspection, never diagnostics. */
  readonly inspectSavedProgress = (): ProgressRead =>
    readProgress(this.deps.storage);

  readonly retrySaving = (): Promise<ProgressSaveResult> => {
    if (this.disposed) {
      return Promise.resolve({
        status: 'failed',
        cause: new Error('This expedition has closed. Reload before saving.'),
      });
    }
    const pending = this.saveTail.then(() => this.persistProgress());
    this.saveTail = pending.then(() => {});
    return pending;
  };

  readonly replaceSavedProgress = (
    expectedRaw: unknown,
    signal: AbortSignal,
  ): Promise<ProgressRecoveryResult> => {
    const pending = this.saveTail.then(() =>
      this.recoverProgress(expectedRaw, signal),
    );
    this.saveTail = pending.then(() => {});
    return pending;
  };

  private async recoverProgress(
    expectedRaw: unknown,
    signal: AbortSignal,
  ): Promise<ProgressRecoveryResult> {
    let outcome: ProgressRecoveryResult = {
      status: 'failed',
      cause: new Error('Save coordination did not run the recovery.'),
    };
    let committed = false;
    let coordinationFailure: string | null = null;
    try {
      if (this.disposed) {
        throw new Error('This expedition has closed. Reload before saving.');
      }
      if (typeof expectedRaw !== 'string' || !(signal instanceof AbortSignal)) {
        outcome = {
          status: 'invalid-request',
          cause: new TypeError(
            'Recovery requires an inspected save and cancellation signal.',
          ),
        };
      } else if (signal.aborted) {
        outcome = { status: 'cancelled' };
      } else {
        await (this.deps.coordinateProgress ?? coordinateProgress)(() => {
          outcome = replaceInvalidProgress(
            expectedRaw,
            this.progress,
            this.deps.storage,
            signal,
          );
          committed = outcome.status === 'replaced';
        }, signal);
      }
    } catch (cause) {
      // A coordinator can fail after setItem committed. Closing cannot undo that write.
      if (committed) {
        coordinationFailure = `Progress saved; save coordination failed (${message(cause)}).`;
      } else {
        outcome =
          signal instanceof AbortSignal && signal.aborted
            ? { status: 'cancelled' }
            : { status: 'failed', cause };
      }
    }
    this.notice = committed
      ? coordinationFailure
      : `Session-only progress: save not replaced (${outcome.status}${'cause' in outcome ? `: ${message(outcome.cause)}` : ''}). Inspect the saved progress again before retrying.`;
    this.publishProgress();
    return outcome;
  }

  /** Must be called directly in the trusted event, never from a render or effect. */
  readonly unlockAudio = (): Promise<AudioSnapshot> => this.audio.unlock();
  readonly getAudioNotice = (): string | null => this.audio.getState().notice;
  readonly subscribeAudio = (listener: () => void): (() => void) =>
    this.audio.subscribe(listener);

  readonly retryAudioCleanup = async (): Promise<void> => {
    try {
      await this.audio.retryCleanup();
      this.audioCleanupError = null;
    } catch (error) {
      this.audioCleanupError = error;
      throw error;
    }
  };

  private readonly applySettings = (): void => {
    const settings = this.settings.getState().settings;
    this.audio.setSettings(settings);
    this.applyInputPreferences();
    this.applyPresentationPreferences();
  };

  private effectivePreferences(): Settings {
    const settings = this.settings.getState().settings;
    return Object.freeze({
      ...settings,
      reducedMotion:
        settings.reducedMotion || this.motionQuery?.matches === true,
    });
  }

  private readonly applyPresentationPreferences = (): void => {
    this.scene?.setReducedMotion(this.effectivePreferences().reducedMotion);
  };

  private applyInputPreferences(): void {
    const { mouseSteering, mouseSensitivity, invertMouseY } =
      this.settings.getState().settings;
    this.input?.setPreferences({
      mouseSteering,
      mouseSensitivity,
      invertMouseY,
    });
  }

  /** Stable React ref callback. Detaching suspends the surface, not its retry owner. */
  readonly setContainer = (container: HTMLElement | null): void => {
    if (this.container === container) return;
    if (this.disposed && container)
      throw new Error('Cannot attach a disposed GameHost.');
    this.generation += 1;
    this.container = container;
    try {
      this.stopFrame();
      this.releaseSurface();
      if (!container) {
        // A StrictMode ref probe or title unmount is not a window focus loss.
        if (this.scene) this.autoPause();
        return;
      }
      if (this.scene && this.renderer) {
        this.attachSurface();
        this.scheduleFrame();
      } else if (this.store.getState().screen === 'loading') {
        this.queueLoad();
      }
    } catch (error) {
      this.fail(error);
    }
  };

  async whenIdle(): Promise<void> {
    let loads: Promise<void>;
    let saves: Promise<void>;
    do {
      loads = this.loadTail;
      saves = this.saveTail;
      await Promise.all([loads, saves]);
    } while (loads !== this.loadTail || saves !== this.saveTail);
  }

  /** Explicit retry only; failed constructors/children are never retried in their first catch. */
  retryCleanup(): void {
    const errors = releaseResources(this.pendingReleases);
    if (errors.length) {
      this.lastCleanupError = new AggregateError(
        errors,
        'GameHost cleanup is still pending.',
      );
      throw this.lastCleanupError;
    }
    this.lastCleanupError = null;
  }

  readonly retryCourse = (): void => {
    if (this.disposed) throw new Error('Cannot retry a disposed GameHost.');
    if (!canRetryCourse(this.store.getState()))
      throw new Error(
        'Cannot retry course without a selected course in error or paused with lost graphics.',
      );
    try {
      this.retryCleanup();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.store.dispatch({ type: 'RETRY_COURSE' });
  };

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      // Observe rejection immediately, independently of synchronous runtime releases
      // and the potentially withheld cross-tab progress transaction.
      this.audioShutdown = this.audio.dispose().then(
        () => {
          this.audioCleanupError = null;
        },
        (error: unknown) => {
          this.audioCleanupError = error;
        },
      );
      this.generation += 1;
      this.unsubscribe();
      this.unsubscribeSettings();
      this.motionQuery?.removeEventListener(
        'change',
        this.applyPresentationPreferences,
      );
      window.removeEventListener('pagehide', this.onPageHide);
      this.removeHook?.();
      this.removeHook = undefined;
      this.container = null;
      try {
        this.cleanupCurrent();
      } catch (error) {
        this.lastCleanupError = error;
      }
    }
    await this.whenIdle();
    await this.audioShutdown;
    const errors: unknown[] = [];
    if (this.pendingReleases.length) {
      errors.push(
        new Error(
          'GameHost cleanup is pending; retain this host and call retryCleanup().',
          { cause: this.lastCleanupError },
        ),
      );
    }
    if (this.audioCleanupError !== null || this.audio.getState().pendingCleanup)
      errors.push(
        new Error(
          'Audio cleanup is pending; retain this host and call retryAudioCleanup().',
          { cause: this.audioCleanupError },
        ),
      );
    if (errors.length)
      throw new AggregateError(errors, 'GameHost cleanup is pending.');
  }

  getSnapshot(): HostSnapshot {
    const snapshot = this.scene?.getSnapshot();
    return frozenCopy({
      preferences: this.effectivePreferences(),
      audio: this.audio.getSnapshot(),
      feedback: this.feedback.getState(this.now()),
      screen: this.store.getState().screen,
      graphicsLost: this.graphicsLost,
      player: snapshot?.fish ?? null,
      race: snapshot?.race ?? null,
      collectedPearlIds: snapshot?.collectedPearlIds ?? [],
      lifecycle: this.pendingReleases.length
        ? 'cleanup-pending'
        : this.disposed
          ? 'disposed'
          : this.scene
            ? 'active'
            : this.loading
              ? 'loading'
              : 'idle',
      cleanupError:
        this.lastCleanupError === null
          ? null
          : errorDetail(this.lastCleanupError),
      frame: { rendered: this.rendered, steps: this.steps },
      resources: {
        canvases: this.renderer?.domElement.parentElement ? 1 : 0,
        rafChains: this.frameId === null ? 0 : 1,
        pendingCleanup: this.pendingReleases.length,
        scene: this.scene?.getDiagnostics() ?? null,
      },
    });
  }

  private readonly onStoreChange = (): void => {
    const state = this.store.getState();
    if (
      state.screen === this.observedScreen &&
      state.selectedCourseId === this.observedCourse &&
      state.graphicsLost === this.observedGraphicsLost
    )
      return;
    this.observedScreen = state.screen;
    this.observedCourse = state.selectedCourseId;
    this.observedGraphicsLost = state.graphicsLost;
    if (this.reportingError || this.disposed) return;
    try {
      const restored =
        this.graphicsLost &&
        !state.graphicsLost &&
        (state.screen === 'paused' || state.screen === 'results');
      if (state.graphicsLost && !this.graphicsLost) {
        this.graphicsLost = true;
        // Invalidate even a cancelled callback delivered after restoration.
        this.generation += 1;
        this.audio.setPhase('paused');
        this.stopFrame();
        this.resetTimingAndInput();
      } else if (!state.graphicsLost) {
        this.graphicsLost = false;
      }
      switch (state.screen) {
        case 'loading':
          this.audio.setPhase('idle');
          this.feedback.clear();
          if (this.container) this.queueLoad();
          break;
        case 'paused':
          this.audio.setPhase('paused');
          if (this.scene?.getSnapshot().race.status === 'running')
            this.scene.pause();
          this.resetTimingAndInput();
          break;
        case 'playing':
          this.audio.setPhase(
            this.loadingStartsPaused || document.hidden ? 'paused' : 'playing',
          );
          if (this.scene?.getSnapshot().race.status === 'paused') {
            this.scene.resume();
            this.resetTimingAndInput();
            this.renderer?.domElement.focus({ preventScroll: true });
          }
          break;
        case 'results':
          this.audio.setPhase(state.graphicsLost ? 'paused' : 'results');
          this.resetTimingAndInput();
          break;
        default:
          this.audio.setPhase('idle');
          this.generation += 1;
          this.cleanupCurrent();
      }
      if (restored) {
        this.resetTimingAndInput();
        this.resize();
        this.scheduleFrame();
      }
    } catch (error) {
      this.fail(error);
    }
  };

  private queueLoad(): void {
    const id = this.store.getState().selectedCourseId;
    if (!id || !this.container)
      throw new Error('Course loading requires a course and surface.');
    const generation = ++this.generation;
    this.loadTail = this.loadTail.then(() => this.load(id, generation));
  }

  private isCurrent(generation: number): boolean {
    return (
      !this.disposed &&
      this.generation === generation &&
      this.container !== null
    );
  }

  private async load(id: CourseId, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    this.loading = true;
    try {
      if (this.pendingReleases.length)
        throw new Error(
          'Previous runtime cleanup is pending. Retain the host and retry cleanup before loading.',
        );
      this.cleanupCurrent();
      const loadCourse =
        this.deps.loadCourse ??
        (await import('../course/loadCourseDefinition')).loadCourseDefinition;
      if (!this.isCurrent(generation)) return;
      const definition = await loadCourse(id);
      if (!this.isCurrent(generation)) return;
      const createScene =
        this.deps.createScene ??
        (await import('./SceneRuntime')).createSceneRuntime;
      if (!this.isCurrent(generation)) return;
      const scene = await createScene(definition);
      this.ownedReleases.push(() => scene.dispose());
      if (!this.isCurrent(generation)) {
        this.cleanupCurrent();
        return;
      }
      let createRenderer = this.deps.createRenderer;
      if (!createRenderer) {
        const { WebGLRenderer } = await import('three');
        if (!this.isCurrent(generation)) {
          this.cleanupCurrent();
          return;
        }
        createRenderer = () =>
          Promise.resolve(new WebGLRenderer({ antialias: true }));
      }
      const renderer = await createRenderer();
      this.ownedReleases.push(
        () => renderer.domElement.remove(),
        () => renderer.forceContextLoss(),
        () => renderer.dispose(),
      );
      if (!this.isCurrent(generation)) {
        this.cleanupCurrent();
        return;
      }
      this.scene = scene;
      this.applyPresentationPreferences();
      this.renderer = renderer;
      this.bindGraphicsEvents(renderer, scene);
      this.rendered = 0;
      this.steps = 0;
      // Canvas focus during attachment must not erase a loss of window focus while loading.
      const startPaused =
        document.hidden ||
        !(this.deps.isFocused ?? (() => document.hasFocus()))();
      this.attachSurface();
      scene.start();
      this.resetTimingAndInput();
      this.lastHudTime = this.lastTime;
      this.loadingStartsPaused = startPaused;
      this.store.dispatch({ type: 'COURSE_READY' });
      this.loadingStartsPaused = false;
      this.publishPresentation(scene.getSnapshot());
      if (startPaused) this.autoPause();
      this.scheduleFrame();
    } catch (error) {
      this.retainConstruction(error);
      if (this.isCurrent(generation)) this.fail(error);
      else {
        // A cancelled load still transfers every failed release to the long-lived owner.
        try {
          this.cleanupCurrent();
        } catch (cleanupError) {
          // Keep the failure observable and its owners retryable without poisoning the load queue.
          this.lastCleanupError = cleanupError;
        }
      }
    } finally {
      this.loading = false;
    }
  }

  private attachSurface(): void {
    const container = this.container;
    const renderer = this.renderer;
    if (!container || !renderer || !this.scene)
      throw new Error('Cannot attach an incomplete runtime.');
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.append(canvas);
    this.surfaceReleases.push(() => canvas.remove());
    const input = (
      this.deps.createInput ??
      ((surface, isPlaying) =>
        new InputController(window, { pointerSurface: surface, isPlaying }))
    )(
      canvas,
      () =>
        !this.settingsOpen &&
        !this.graphicsLost &&
        this.store.getState().screen === 'playing',
    );
    this.input = input;
    this.surfaceReleases.push(() => input.destroy());
    this.applyInputPreferences();
    window.addEventListener('blur', this.autoPause);
    this.surfaceReleases.push(() =>
      window.removeEventListener('blur', this.autoPause),
    );
    document.addEventListener('visibilitychange', this.onVisibility);
    this.surfaceReleases.push(() =>
      document.removeEventListener('visibilitychange', this.onVisibility),
    );
    window.addEventListener('keydown', this.onPausedKey);
    this.surfaceReleases.push(() =>
      window.removeEventListener('keydown', this.onPausedKey),
    );
    const disconnect = (
      this.deps.observeResize ??
      ((element, callback) => {
        const observer = new ResizeObserver(callback);
        observer.observe(element);
        return () => observer.disconnect();
      })
    )(container, this.onResize);
    this.surfaceReleases.push(disconnect);
    this.resize();
    canvas.focus({ preventScroll: true });
  }

  private bindGraphicsEvents(
    renderer: HostRenderer,
    scene: SceneRuntime,
  ): void {
    const ownsRuntime = () => {
      const screen = this.store.getState().screen;
      return (
        !this.disposed &&
        this.renderer === renderer &&
        this.scene === scene &&
        (screen === 'playing' || screen === 'paused' || screen === 'results')
      );
    };
    const lost = (event: Event) => {
      if (!ownsRuntime()) return;
      event.preventDefault();
      if (this.graphicsLost) return;
      this.store.dispatch({ type: 'GRAPHICS_LOST' });
    };
    const restored = () => {
      if (!ownsRuntime() || !this.graphicsLost) return;
      this.store.dispatch({ type: 'GRAPHICS_RESTORED' });
    };
    const canvas = renderer.domElement;
    // LIFO releases remove these before renderer disposal/forced context loss.
    canvas.addEventListener('webglcontextlost', lost);
    this.ownedReleases.push(() =>
      canvas.removeEventListener('webglcontextlost', lost),
    );
    canvas.addEventListener('webglcontextrestored', restored);
    this.ownedReleases.push(() =>
      canvas.removeEventListener('webglcontextrestored', restored),
    );
  }

  private readonly onResize = (): void => {
    try {
      this.resize();
    } catch (error) {
      this.fail(error);
    }
  };

  private resize(): void {
    if (!this.container || !this.renderer || !this.scene || this.graphicsLost)
      return;
    const { width, height, dpr } = (
      this.deps.measure ??
      ((element) => ({
        width: element.clientWidth,
        height: element.clientHeight,
        dpr: window.devicePixelRatio,
      }))
    )(this.container);
    if (
      ![width, height, dpr].every(Number.isFinite) ||
      width < 0 ||
      height < 0 ||
      dpr <= 0
    ) {
      throw new RangeError('Invalid render surface dimensions or pixel ratio.');
    }
    this.hasSize = width > 0 && height > 0;
    if (!this.hasSize) return;
    this.renderer.setPixelRatio(Math.min(2, dpr));
    this.renderer.setSize(width, height, false);
    this.scene.camera.aspect = width / height;
    this.scene.camera.updateProjectionMatrix();
  }

  private readonly autoPause = (): void => {
    this.audio.setPhase('paused');
    if (this.store.getState().screen === 'playing' && this.scene) {
      this.store.dispatch({ type: 'PAUSE' });
    }
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) this.autoPause();
  };

  private readonly onPageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      this.autoPause();
    } else {
      void this.dispose().catch((error: unknown) => {
        console.error('Reef Rush shutdown cleanup remains pending.', error);
      });
    }
  };

  private readonly onPausedKey = (event: KeyboardEvent): void => {
    if (
      !event.defaultPrevented &&
      !this.settingsOpen &&
      !this.graphicsLost &&
      isPauseKeyEvent(event) &&
      this.store.getState().screen === 'paused'
    ) {
      void this.unlockAudio();
      this.store.dispatch({ type: 'RESUME' });
    }
  };

  private resetTimingAndInput(): void {
    this.runner.reset();
    this.lastTime = this.now();
    this.input?.clear();
  }

  private scheduleFrame(): void {
    if (
      !this.disposed &&
      !this.graphicsLost &&
      this.container &&
      this.scene &&
      this.frameId === null
    ) {
      const generation = this.generation;
      this.frameId = this.requestFrame((timestamp) => {
        if (this.isCurrent(generation) && !this.graphicsLost)
          this.onFrame(timestamp);
      });
    }
  }

  private readonly onFrame = (timestamp: number): void => {
    this.frameId = null;
    const scene = this.scene;
    const renderer = this.renderer;
    if (
      !scene ||
      !renderer ||
      !this.container ||
      this.disposed ||
      this.graphicsLost
    )
      return;
    try {
      const dt = Math.max(0, (timestamp - this.lastTime) / 1000);
      this.lastTime = timestamp;
      let alpha = 1;
      if (this.store.getState().screen === 'playing') {
        const result = this.runner.advance(dt, (stepSeconds) => {
          if (!this.input)
            throw new Error('Playing runtime has no input owner.');
          const step = scene.step(this.input.readFrame(), stepSeconds);
          this.steps += 1;
          for (const cue of this.feedback.consume(
            step.fishEvents,
            step.raceEvents,
            timestamp,
          ))
            this.audio.play(cue);
          if (step.pauseRequested) {
            this.publishPresentation(step.snapshot);
            this.store.dispatch({ type: 'PAUSE' });
            return false;
          }
          if (step.finished) {
            const finished = step.snapshot.race.result;
            if (!finished)
              throw new Error('Finished scene did not provide a race result.');
            this.publishPresentation(step.snapshot);
            this.finish(finished);
            return false;
          }
          if (
            this.scene !== scene ||
            this.store.getState().screen !== 'playing'
          )
            return false;
        });
        alpha = result.alpha;
        if (
          this.store.getState().screen === 'playing' &&
          timestamp - this.lastHudTime >= 100
        ) {
          this.lastHudTime = timestamp;
          this.publishPresentation(scene.getSnapshot());
        }
      }
      if (scene !== this.scene) return;
      if (this.hasSize) {
        scene.present(alpha, Math.min(dt, 0.1));
        renderer.render(scene.scene, scene.camera);
        this.rendered += 1;
      }
      this.scheduleFrame();
    } catch (error) {
      this.fail(error);
    }
  };

  private publishPresentation(snapshot: SceneSnapshot): void {
    this.store.dispatch({
      type: 'PRESENTATION_UPDATED',
      presentation: {
        elapsedMs: snapshot.race.elapsedMs,
        checkpointIndex: snapshot.race.checkpointIndex,
        checkpointCount: snapshot.race.checkpointCount,
        pearlCount: snapshot.race.pearlCount,
        dashRatio: snapshot.fish.dashEnergy,
        feedback: this.feedback.getState(this.now()),
      },
    });
  }

  private publishProgress(): void {
    this.store.dispatch({
      type: 'PROGRESS_UPDATED',
      progress: this.progress,
      notice: this.notice,
    });
  }

  private finish(result: FinishedRaceResult): void {
    const achievements = finishAchievements(this.progress, result);
    this.progress = updateProgress(this.progress, result);
    this.notice ??= 'Session-only progress: save pending.';
    // Earned progress belongs to the host, not the scene/navigation generation.
    this.saveTail = this.saveTail.then(async () => {
      await this.persistProgress();
    });
    this.publishProgress();
    this.store.dispatch({ type: 'RUN_FINISHED', result, achievements });
  }

  private async persistProgress(): Promise<ProgressSaveResult> {
    let committed = false;
    let outcome: ProgressSaveResult = {
      status: 'failed',
      cause: new Error('Save coordination did not run the save.'),
    };
    try {
      await (this.deps.coordinateProgress ?? coordinateProgress)(() => {
        const storage = (this.deps.storage ?? (() => window.localStorage))();
        const current = readProgress(() => storage);
        if (current.status === 'invalid') {
          throw new Error(
            `Invalid existing save preserved (${current.reason}); refusing to overwrite it.`,
          );
        }
        if (current.status === 'unavailable') {
          throw new Error(`Storage unavailable (${message(current.cause)}).`, {
            cause: current.cause,
          });
        }
        // Read the latest session records after acquiring the lock, with no awaits before writing.
        this.progress = mergeProgress(current.progress, this.progress);
        saveProgress(this.progress, () => storage);
        committed = true;
        this.notice = null;
      });
      if (committed) outcome = { status: 'saved' };
      else throw outcome.cause;
    } catch (error) {
      outcome = committed
        ? { status: 'saved' }
        : // Writer error causes can contain raw storage; only inspection exposes it.
          { status: 'failed', cause: new Error(message(error)) };
      this.notice = committed
        ? `Progress saved; save coordination failed (${message(error)}).`
        : `Session-only progress: could not save (${message(error)}).`;
    }
    this.publishProgress();
    return outcome;
  }

  private stopFrame(): void {
    const id = this.frameId;
    this.frameId = null;
    this.runner.reset();
    if (id !== null) {
      const releases = [() => this.cancelFrame(id)];
      const errors = releaseResources(releases);
      this.pendingReleases.push(...releases);
      if (errors.length)
        throw new AggregateError(
          errors,
          'Animation frame cancellation failed.',
        );
    }
  }

  private releaseSurface(): void {
    this.input = null;
    const errors = releaseResources(this.surfaceReleases);
    this.pendingReleases.push(...this.surfaceReleases.splice(0));
    if (errors.length)
      throw new AggregateError(errors, 'GameHost surface cleanup failed.');
  }

  private cleanupCurrent(): void {
    const errors: unknown[] = [];
    try {
      this.stopFrame();
    } catch (error) {
      errors.push(error);
    }
    this.input = null;
    this.scene = null;
    this.renderer = null;
    this.graphicsLost = false;
    this.hasSize = false;
    errors.push(
      ...releaseResources(this.surfaceReleases),
      ...releaseResources(this.ownedReleases),
    );
    this.pendingReleases.push(
      ...this.surfaceReleases.splice(0),
      ...this.ownedReleases.splice(0),
    );
    if (errors.length) {
      this.lastCleanupError = new AggregateError(
        errors,
        'GameHost resource cleanup failed.',
      );
      throw this.lastCleanupError;
    }
  }

  private retainConstruction(error: unknown): void {
    if (
      error instanceof ConstructionCleanupError &&
      !this.constructionOwners.has(error)
    ) {
      this.constructionOwners.add(error);
      this.lastCleanupError = error;
      this.pendingReleases.push(() => {
        error.retryCleanup();
        this.constructionOwners.delete(error);
      });
    }
  }

  private fail(error: unknown): void {
    if (this.reportingError) return;
    this.audio.setPhase('idle');
    this.retainConstruction(error);
    this.reportingError = true;
    this.generation += 1;
    let detail = errorDetail(error);
    try {
      this.cleanupCurrent();
    } catch (cleanupError) {
      detail = errorDetail(
        new AggregateError(
          [error, cleanupError],
          'Run failed and cleanup remains owned; retry is required.',
        ),
      );
    }
    try {
      if (!this.disposed)
        this.store.dispatch({
          type: 'SHOW_ERROR',
          title: 'Run unavailable',
          detail,
        });
    } finally {
      this.reportingError = false;
    }
  }
}
