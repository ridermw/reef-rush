import { z } from 'zod';
import { COURSE_IDS, type CourseId } from '../../content/courses/courseIds';
import { elapsedMsSchema, medalSchema, type Medal } from '../race/medals';
import { finishedRaceResultSchema, pearlCountSchema } from '../race/raceTypes';

const courseBestSchema = z
  .strictObject({
    bestElapsedMs: elapsedMsSchema,
    bestMedal: medalSchema.nullable(),
    bestPearlCount: pearlCountSchema,
  })
  .readonly();
export type CourseBest = z.infer<typeof courseBestSchema>;

const courseIdSchema = z.enum(COURSE_IDS);
const coursesSchema = z
  .unknown()
  .refine(
    (input) =>
      typeof input === 'object' &&
      input !== null &&
      !Array.isArray(input) &&
      Reflect.ownKeys(input).every(
        (key) => courseIdSchema.safeParse(key).success,
      ),
    'Expected a record keyed only by known course IDs.',
  )
  // Check original keys first: Zod records intentionally omit __proto__.
  .pipe(z.partialRecord(courseIdSchema, courseBestSchema))
  .readonly();
export const progressSchema = z
  .strictObject({
    version: z.literal(1),
    courses: coursesSchema,
  })
  .readonly();
export type Progress = z.infer<typeof progressSchema>;
const medalRank: Readonly<Record<Medal, number>> = {
  gold: 3,
  silver: 2,
  bronze: 1,
};

export function emptyProgress(): Progress {
  return parseProgress({ version: 1, courses: {} });
}

export function parseProgress(input: unknown): Progress {
  return progressSchema.parse(input);
}

export function updateProgress(
  progress: unknown,
  finishedResult: unknown,
): Progress {
  const current = parseProgress(progress);
  const result = finishedRaceResultSchema.parse(finishedResult);
  const previous = current.courses[result.courseId];
  const previousMedal = previous?.bestMedal ?? null;
  const bestMedal =
    result.medal !== null &&
    (previousMedal === null ||
      medalRank[result.medal] > medalRank[previousMedal])
      ? result.medal
      : previousMedal;
  return parseProgress({
    version: 1,
    courses: {
      ...current.courses,
      [result.courseId]: {
        bestElapsedMs: Math.min(
          previous?.bestElapsedMs ?? result.elapsedMs,
          result.elapsedMs,
        ),
        bestMedal,
        bestPearlCount: Math.max(
          previous?.bestPearlCount ?? 0,
          result.pearlCount,
        ),
      },
    },
  });
}

export function unlockedCourseIds(progress: unknown): readonly CourseId[] {
  const current = parseProgress(progress);
  const unlocked: CourseId[] = [];
  for (const id of COURSE_IDS) {
    unlocked.push(id);
    if (!current.courses[id]?.bestMedal) break;
  }
  return Object.freeze(unlocked);
}
