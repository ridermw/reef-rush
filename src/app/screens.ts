import type { CourseId } from '../content/courses/courseIds';
import type { FinishedRaceResult } from '../game/race/raceTypes';
import type { Progress } from '../game/progression/progress';
import type { FinishAchievements } from '../game/progression/finishAchievements';
import type { RunFeedback } from '../game/core/runFeedback';

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
  feedback?: RunFeedback | null;
}

export interface AppState {
  screen: AppScreen;
  graphicsLost: boolean;
  selectedCourseId: CourseId | null;
  presentation: AppPresentation | null;
  result: FinishedRaceResult | null;
  achievements: FinishAchievements | null;
  error: { title: string; detail: string } | null;
  progress: Progress | null;
  progressNotice: string | null;
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
