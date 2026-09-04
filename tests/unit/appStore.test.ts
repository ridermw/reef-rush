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
  it('runs title -> select -> loading -> playing -> results', () => {
    const store = createAppStore();
    advanceToPlaying(store);
    store.dispatch({ type: 'RUN_FINISHED', elapsedMs: 91_250 });

    expect(store.getState()).toMatchObject({
      screen: 'results',
      selectedCourseId: 'sunlit-shoals',
      result: { elapsedMs: 91_250 },
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
      error: null,
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
});
