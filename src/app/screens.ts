import type { CourseId } from '../content/courses/courseIds';

export type AppScreen =
  | 'title'
  | 'course-select'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'results'
  | 'error';

export interface AppPresentation {
  elapsedMs: number;
  dashRatio: number;
  checkpointIndex: number;
  checkpointCount: number;
  pearlCount: number;
}

export interface AppState {
  screen: AppScreen;
  selectedCourseId: CourseId | null;
  presentation: AppPresentation | null;
  result: { elapsedMs: number } | null;
  error: { title: string; detail: string } | null;
}

const GAME_ROOT_SCREENS = [
  'loading',
  'playing',
  'paused',
  'results',
] as const satisfies readonly AppScreen[];

export function screenUsesGameRoot(screen: AppScreen): boolean {
  return GAME_ROOT_SCREENS.some((gameRootScreen) => gameRootScreen === screen);
}
