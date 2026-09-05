import { describe, expect, it } from 'vitest';
import {
  createAppStore,
  type AppAction,
  type AppPresentation,
  type AppStore,
} from '../../src/app/appStore';

const updatedPresentation: AppPresentation = {
  elapsedMs: 54_320,
  dashRatio: 0.42,
  checkpointIndex: 2,
  checkpointCount: 5,
  pearlCount: 3,
};

function openCourseSelect(store: AppStore): void {
  store.dispatch({ type: 'OPEN_COURSE_SELECT' });
}

function advanceToPlaying(store: AppStore): void {
  openCourseSelect(store);
  store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
  store.dispatch({ type: 'COURSE_READY' });
}

interface IllegalTransitionCase {
  setup?: (store: AppStore) => void;
  action: AppAction;
  error: string;
}

const illegalTransitionCases: IllegalTransitionCase[] = [
  {
    action: { type: 'PAUSE' },
    error: 'Cannot PAUSE while screen is title',
  },
  {
    setup: advanceToPlaying,
    action: { type: 'RESUME' },
    error: 'Cannot RESUME while screen is playing',
  },
  {
    setup: (store) => {
      advanceToPlaying(store);
      store.dispatch({ type: 'PAUSE' });
    },
    action: {
      type: 'PRESENTATION_UPDATED',
      presentation: updatedPresentation,
    },
    error: 'Cannot PRESENTATION_UPDATED while screen is paused',
  },
  {
    action: { type: 'RETURN_TO_TITLE' },
    error: 'Cannot RETURN_TO_TITLE while screen is title',
  },
];

describe('app screen transitions', () => {
  it.each(['REPLAY', 'OPEN_COURSE_SELECT'] as const)(
    'allows %s from results while clearing the run and retaining pending progress',
    (type) => {
      const store = createAppStore();
      advanceToPlaying(store);
      store.dispatch({
        type: 'PROGRESS_UPDATED',
        progress: { version: 1, courses: {} },
        notice: 'Session-only progress: save pending.',
      });
      store.dispatch({
        type: 'RUN_FINISHED',
        result: {
          courseId: 'sunlit-shoals',
          elapsedMs: 100,
          medal: 'gold',
          pearlCount: 1,
          totalPearls: 1,
        },
      });
      store.dispatch({ type });
      expect(store.getState()).toMatchObject({
        screen: type === 'REPLAY' ? 'loading' : 'course-select',
        selectedCourseId: type === 'REPLAY' ? 'sunlit-shoals' : null,
        result: null,
        achievements: null,
        presentation: null,
        progressNotice: 'Session-only progress: save pending.',
      });
    },
  );

  it('runs title -> select -> loading -> playing -> results', () => {
    const store = createAppStore();
    advanceToPlaying(store);
    store.dispatch({
      type: 'RUN_FINISHED',
      result: {
        courseId: 'sunlit-shoals',
        elapsedMs: 91_250,
        medal: 'bronze',
        pearlCount: 3,
        totalPearls: 4,
      },
    });

    expect(store.getState()).toMatchObject({
      screen: 'results',
      selectedCourseId: 'sunlit-shoals',
      result: {
        elapsedMs: 91_250,
        medal: 'bronze',
        pearlCount: 3,
        totalPearls: 4,
      },
    });
  });

  it('applies presentation updates and legal pause-resume transitions', () => {
    const store = createAppStore();
    advanceToPlaying(store);

    store.dispatch({
      type: 'PRESENTATION_UPDATED',
      presentation: updatedPresentation,
    });
    store.dispatch({ type: 'PAUSE' });

    expect(store.getState()).toMatchObject({
      screen: 'paused',
      presentation: updatedPresentation,
    });

    store.dispatch({ type: 'RESUME' });

    expect(store.getState()).toMatchObject({
      screen: 'playing',
      presentation: updatedPresentation,
    });
  });

  it('shows errors and returns to title cleanly', () => {
    const store = createAppStore();
    advanceToPlaying(store);

    store.dispatch({
      type: 'SHOW_ERROR',
      title: 'Runtime unavailable',
      detail: 'Lost the gameplay render surface.',
    });

    expect(store.getState()).toMatchObject({
      screen: 'error',
      error: {
        title: 'Runtime unavailable',
        detail: 'Lost the gameplay render surface.',
      },
    });

    store.dispatch({ type: 'RETURN_TO_TITLE' });

    expect(store.getState()).toEqual({
      screen: 'title',
      selectedCourseId: null,
      presentation: null,
      result: null,
      achievements: null,
      error: null,
      progress: null,
      progressNotice: null,
      graphicsLost: false,
    });
  });

  describe('graphics lifecycle transitions', () => {
    function at(screen: 'playing' | 'paused' | 'results' | 'error') {
      const store = createAppStore();
      advanceToPlaying(store);
      store.dispatch({
        type: 'PRESENTATION_UPDATED',
        presentation: updatedPresentation,
      });
      store.dispatch({
        type: 'PROGRESS_UPDATED',
        progress: { version: 1, courses: {} },
        notice: 'Save pending.',
      });
      if (screen === 'paused') store.dispatch({ type: 'PAUSE' });
      if (screen === 'results')
        store.dispatch({
          type: 'RUN_FINISHED',
          result: {
            courseId: 'sunlit-shoals',
            elapsedMs: 100,
            medal: 'gold',
            pearlCount: 1,
            totalPearls: 1,
          },
        });
      if (screen === 'error')
        store.dispatch({
          type: 'SHOW_ERROR',
          title: 'Unavailable',
          detail: 'Failed',
        });
      return store;
    }

    it.each(['playing', 'paused', 'results'] as const)(
      'retains %s run data through repeated loss and restoration without resuming',
      (screen) => {
        const store = at(screen);
        const before = store.getState();
        store.dispatch({ type: 'GRAPHICS_LOST' });
        expect(store.getState()).toEqual({
          ...before,
          screen: screen === 'playing' ? 'paused' : screen,
          graphicsLost: true,
        });
        const lost = store.getState();
        store.dispatch({ type: 'GRAPHICS_LOST' });
        expect(store.getState()).toBe(lost);
        store.dispatch({ type: 'GRAPHICS_RESTORED' });
        expect(store.getState()).toEqual({ ...lost, graphicsLost: false });
        const restored = store.getState();
        store.dispatch({ type: 'GRAPHICS_RESTORED' });
        expect(store.getState()).toBe(restored);
      },
    );

    it('rejects resume while lost without mutating the paused attempt', () => {
      const store = at('playing');
      store.dispatch({ type: 'GRAPHICS_LOST' });
      const before = store.getState();
      expect(() => store.dispatch({ type: 'RESUME' })).toThrow(/graphics/i);
      expect(store.getState()).toBe(before);
      store.dispatch({ type: 'GRAPHICS_RESTORED' });
      store.dispatch({ type: 'RESUME' });
      expect(store.getState().screen).toBe('playing');
    });

    it.each(['error', 'paused'] as const)(
      'explicit retry from %s resets only the attempt',
      (screen) => {
        const store = at(screen);
        if (screen === 'paused') store.dispatch({ type: 'GRAPHICS_LOST' });
        const before = store.getState();
        store.dispatch({ type: 'RETRY_COURSE' });
        expect(store.getState()).toEqual({
          ...before,
          screen: 'loading',
          graphicsLost: false,
          presentation: null,
          result: null,
          achievements: null,
          error: null,
        });
        store.dispatch({ type: 'COURSE_READY' });
        expect(store.getState().presentation?.elapsedMs).toBe(0);
      },
    );

    it.each(['playing', 'paused', 'results'] as const)(
      'rejects retry from healthy %s',
      (screen) => {
        const store = at(screen);
        const before = store.getState();
        expect(() => store.dispatch({ type: 'RETRY_COURSE' })).toThrow(
          /retry/i,
        );
        expect(store.getState()).toBe(before);
      },
    );

    it('rejects a course retry from a global error without a selected course', () => {
      const store = createAppStore();
      store.dispatch({
        type: 'SHOW_ERROR',
        title: 'Global error',
        detail: 'Failed',
      });
      expect(() => store.dispatch({ type: 'RETRY_COURSE' })).toThrow(/course/i);
    });

    it.each(['GRAPHICS_LOST', 'GRAPHICS_RESTORED'] as const)(
      'rejects %s outside its runtime lifecycle',
      (type) => {
        const store = createAppStore();
        for (const action of [
          null,
          { type: 'OPEN_COURSE_SELECT' },
          { type: 'LOAD_COURSE', courseId: 'sunlit-shoals' },
          { type: 'SHOW_ERROR', title: 'Failed', detail: 'No runtime' },
        ] satisfies Array<AppAction | null>) {
          if (action) store.dispatch(action);
          const before = store.getState();
          expect(() => store.dispatch({ type })).toThrow(type);
          expect(store.getState()).toBe(before);
        }
      },
    );

    it.each([
      'RETURN_TO_TITLE',
      'SHOW_ERROR',
      'REPLAY',
      'OPEN_COURSE_SELECT',
    ] as const)('clears loss on %s without clearing progress', (type) => {
      const store = at('results');
      store.dispatch({ type: 'GRAPHICS_LOST' });
      const progress = store.getState().progress;
      store.dispatch(
        type === 'SHOW_ERROR'
          ? { type, title: 'Failed', detail: 'No runtime' }
          : { type },
      );
      expect(store.getState().graphicsLost).toBe(false);
      expect(store.getState().progress).toBe(progress);
      expect(store.getState().progressNotice).toBe('Save pending.');
    });
  });

  it.each(illegalTransitionCases)(
    'rejects illegal actions with explicit errors: $error',
    ({ setup, action, error }) => {
      const store = createAppStore();
      setup?.(store);

      expect(() => store.dispatch(action)).toThrow(error);
    },
  );

  it('rejects a finished result for another course before changing state', () => {
    const store = createAppStore();
    advanceToPlaying(store);
    const before = store.getState();
    expect(() =>
      store.dispatch({
        type: 'RUN_FINISHED',
        result: {
          courseId: 'kelpworks',
          elapsedMs: 12,
          medal: 'gold',
          pearlCount: 0,
          totalPearls: 0,
        },
      }),
    ).toThrow(/course/i);
    expect(store.getState()).toBe(before);
  });

  it('keeps progress and its session-only notice across return to title', () => {
    const store = createAppStore();
    store.dispatch({
      type: 'PROGRESS_UPDATED',
      progress: { version: 1, courses: {} },
      notice: 'Session only: storage unavailable.',
    });
    expect(store.getState()).toMatchObject({
      progressNotice: 'Session only: storage unavailable.',
    });
    openCourseSelect(store);
    store.dispatch({ type: 'RETURN_TO_TITLE' });
    expect(store.getState()).toMatchObject({
      progress: { version: 1, courses: {} },
      progressNotice: 'Session only: storage unavailable.',
    });
  });
});
