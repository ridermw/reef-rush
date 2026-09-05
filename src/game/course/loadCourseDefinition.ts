import { z } from 'zod';
import { COURSE_IDS, type CourseId } from '../../content/courses/courseIds';
import {
  courseDefinitionSchema,
  type CourseDefinition,
} from './courseDefinition';

export type CourseLoaders = Readonly<
  Partial<Record<CourseId, () => Promise<unknown>>>
>;

const COURSE_LOADERS: CourseLoaders = {
  'sunlit-shoals': () => import('../../content/courses/sunlitShoals'),
  kelpworks: () => import('../../content/courses/kelpworks'),
  'blacksmoker-run': () => import('../../content/courses/blacksmokerRun'),
};
const courseIdSchema = z.enum(COURSE_IDS);
const courseModuleSchema = z.object({ default: courseDefinitionSchema });

export async function loadCourseDefinition(
  courseId: string,
  loaders: CourseLoaders = COURSE_LOADERS,
): Promise<CourseDefinition> {
  const id = courseIdSchema.safeParse(courseId);
  if (!id.success) throw new Error(`Unknown course ID: "${courseId}".`);
  const loader = loaders[id.data];
  if (!loader) throw new Error(`Course "${id.data}" is not implemented.`);

  let payload: unknown;
  try {
    payload = await loader();
  } catch (cause) {
    throw new Error(`Failed to import course "${id.data}".`, { cause });
  }

  const result = courseModuleSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(`Invalid course definition for "${id.data}".`, {
      cause: result.error,
    });
  }
  const definition = result.data.default;
  if (definition.courseId !== id.data) {
    throw new Error(
      `Course ID mismatch: requested "${id.data}", received "${definition.courseId}".`,
    );
  }
  return definition;
}
