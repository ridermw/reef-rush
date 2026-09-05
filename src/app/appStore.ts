import type { CourseId } from '../content/courses/courseIds';
import type { AppPresentation, AppState } from './screens';
import {
  finishedRaceResultSchema,
  type FinishedRaceResult,
} from '../game/race/raceTypes';
import type { Progress } from '../game/progression/progress';
import type { FinishAchievements } from '../game/progression/finishAchievements';

export type { CourseId } from '../content/courses/courseIds';
export type { AppPresentation, AppScreen, AppState } from './screens';

export type AppAction =
  | { type: 'OPEN_COURSE_SELECT' }
  | { type: 'LOAD_COURSE'; courseId: CourseId }
  | { type: 'COURSE_READY' }
  | { type: 'PRESENTATION_UPDATED'; presentation: AppPresentation }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'REPLAY' }
  | {
      type: 'RUN_FINISHED';
      result: FinishedRaceResult;
      achievements?: FinishAchievements;
    }
  | { type: 'PROGRESS_UPDATED'; progress: Progress; notice: string | null }
  | { type: 'SHOW_ERROR'; title: string; detail: string }
  | { type: 'RETURN_TO_TITLE' };

export interface AppStore {
  getState: () => AppState;
  subscribe: (listener: () => void) => () => void;
  dispatch: (action: AppAction) => void;
}

function createInitialState(): AppState {
  return {
    screen: 'title',
    selectedCourseId: null,
    presentation: null,
    result: null,
    achievements: null,
    error: null,
    progress: null,
    progressNotice: null,
  };
}

function createDefaultPresentation(): AppPresentation {
  return {
    elapsedMs: 0,
    dashRatio: 1,
    checkpointIndex: 0,
    checkpointCount: 0,
    pearlCount: 0,
  };
}

function assertScreen(
  action: AppAction['type'],
  screen: AppState['screen'],
  allowedScreens: readonly AppState['screen'][],
): void {
  if (!allowedScreens.includes(screen)) {
    throw new Error(`Cannot ${action} while screen is ${screen}`);
  }
}

function reduceAppState(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'OPEN_COURSE_SELECT':
      assertScreen(action.type, state.screen, ['title', 'results']);
      return {
        ...state,
        screen: 'course-select',
        selectedCourseId: null,
        presentation: null,
        result: null,
        achievements: null,
        error: null,
      };

    case 'LOAD_COURSE':
      assertScreen(action.type, state.screen, ['course-select']);
      return {
        ...state,
        screen: 'loading',
        selectedCourseId: action.courseId,
        presentation: null,
        result: null,
        achievements: null,
        error: null,
      };

    case 'REPLAY':
      assertScreen(action.type, state.screen, ['results']);
      return {
        ...state,
        screen: 'loading',
        presentation: null,
        result: null,
        achievements: null,
        error: null,
      };

    case 'COURSE_READY':
      assertScreen(action.type, state.screen, ['loading']);
      return {
        ...state,
        screen: 'playing',
        presentation: state.presentation ?? createDefaultPresentation(),
        result: null,
        error: null,
      };

    case 'PRESENTATION_UPDATED':
      assertScreen(action.type, state.screen, ['playing']);
      return {
        ...state,
        presentation: action.presentation,
      };

    case 'PAUSE':
      assertScreen(action.type, state.screen, ['playing']);
      return {
        ...state,
        screen: 'paused',
      };

    case 'RESUME':
      assertScreen(action.type, state.screen, ['paused']);
      return {
        ...state,
        screen: 'playing',
      };

    case 'RUN_FINISHED':
      assertScreen(action.type, state.screen, ['playing']);
      if (action.result.courseId !== state.selectedCourseId) {
        throw new Error('Finished result does not match the selected course.');
      }
      return {
        ...state,
        screen: 'results',
        result: finishedRaceResultSchema.parse(action.result),
        achievements: action.achievements ?? null,
      };

    case 'PROGRESS_UPDATED':
      return {
        ...state,
        progress: action.progress,
        progressNotice: action.notice,
      };

    case 'SHOW_ERROR':
      return {
        ...state,
        screen: 'error',
        presentation: null,
        result: null,
        achievements: null,
        error: {
          title: action.title,
          detail: action.detail,
        },
      };

    case 'RETURN_TO_TITLE':
      assertScreen(action.type, state.screen, [
        'course-select',
        'loading',
        'playing',
        'paused',
        'results',
        'error',
      ]);
      return {
        ...createInitialState(),
        progress: state.progress,
        progressNotice: state.progressNotice,
      };
  }
}

export function createAppStore(): AppStore {
  let state = createInitialState();
  const listeners = new Set<() => void>();

  return {
    getState: () => {
      return state;
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (action) => {
      const nextState = reduceAppState(state, action);
      state = nextState;

      for (const listener of listeners) {
        listener();
      }
    },
  };
}
