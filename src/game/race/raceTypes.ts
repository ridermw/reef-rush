import { z } from 'zod';
import { COURSE_IDS, type CourseId } from '../../content/courses/courseIds';
import { MAX_COURSE_PEARLS } from '../course/courseDefinition';
import { elapsedMsSchema, medalSchema } from './medals';

export const pearlCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_COURSE_PEARLS);
export const finishedRaceResultSchema = z
  .strictObject({
    courseId: z.enum(COURSE_IDS),
    elapsedMs: elapsedMsSchema,
    medal: medalSchema.nullable(),
    pearlCount: pearlCountSchema,
    totalPearls: pearlCountSchema,
  })
  .refine(
    ({ pearlCount, totalPearls }) => pearlCount <= totalPearls,
    'Collected pearl count cannot exceed total pearls.',
  )
  .readonly();
export type FinishedRaceResult = z.infer<typeof finishedRaceResultSchema>;

export interface RaceState {
  readonly status: 'ready' | 'running' | 'paused' | 'finished';
  readonly courseId: CourseId;
  readonly elapsedMs: number;
  readonly checkpointIndex: number;
  readonly checkpointCount: number;
  readonly pearlCount: number;
  readonly totalPearls: number;
  readonly result: FinishedRaceResult | null;
}

interface EventTiming {
  readonly fraction: number;
  readonly elapsedMs: number;
}

export type RaceEvent = EventTiming &
  (
    | {
        readonly type: 'checkpoint';
        readonly checkpointId: string;
        readonly checkpointIndex: number;
      }
    | { readonly type: 'pearl'; readonly pearlId: string }
    | { readonly type: 'finish'; readonly result: FinishedRaceResult }
  );

export interface RaceStep {
  readonly state: RaceState;
  readonly events: readonly RaceEvent[];
}
