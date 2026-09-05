import type { CourseId } from '../../content/courses/courseIds';
import type { FinishedRaceResult } from '../race/raceTypes';
import {
  parseProgress,
  updateProgress,
  unlockedCourseIds,
  type CourseBest,
  type Progress,
} from './progress';

export interface FinishAchievements {
  readonly firstCompletion: boolean;
  readonly newTimeRecord: boolean;
  readonly previousBest: CourseBest | null;
  readonly bestAtFinish: CourseBest;
  readonly newlyUnlocked: readonly CourseId[];
}

export function finishAchievements(
  progress: Progress,
  result: FinishedRaceResult,
): FinishAchievements {
  const before = parseProgress(progress);
  const after = updateProgress(before, result);
  const previousBest = before.courses[result.courseId] ?? null;
  const bestAtFinish = after.courses[result.courseId];
  if (!bestAtFinish) throw new Error('Finished course has no progress record.');
  const unlockedBefore = unlockedCourseIds(before);
  return Object.freeze({
    firstCompletion: previousBest === null,
    newTimeRecord:
      previousBest !== null && result.elapsedMs < previousBest.bestElapsedMs,
    previousBest,
    bestAtFinish,
    newlyUnlocked: Object.freeze(
      unlockedCourseIds(after).filter((id) => !unlockedBefore.includes(id)),
    ),
  });
}
