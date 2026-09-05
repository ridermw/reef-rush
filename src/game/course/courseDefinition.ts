import { z } from 'zod';
import { COURSE_IDS } from '../../content/courses/courseIds';
import { medalTimesMsSchema } from '../race/medals';

const finite = z.number().finite();
export const MAX_COURSE_PEARLS = 4_096;
const coordinate = finite.min(-10_000).max(10_000);
const dimension = finite.min(0.01).max(1_000);
const angle = finite.min(-Math.PI).max(Math.PI);
const id = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);

export const vector3Schema = z.tuple([finite, finite, finite]).readonly();
const positionSchema = z.tuple([coordinate, coordinate, coordinate]).readonly();
const dimensionsSchema = z.tuple([dimension, dimension, dimension]).readonly();
const unitVectorSchema = vector3Schema.refine(
  (value) => Math.abs(Math.hypot(...value) - 1) <= 1e-6,
  'Expected a unit direction vector.',
);
const rotationSchema = z
  .tuple([finite, finite, finite, finite])
  .refine(
    (value) => Math.abs(Math.hypot(...value) - 1) <= 1e-6,
    'Expected a unit quaternion [x, y, z, w].',
  )
  .readonly();

const objectFields = { id, position: positionSchema, color };
const solidFields = {
  ...objectFields,
  collision: z.enum(['environment', 'hazard']),
};
const boxSchema = z.strictObject({
  ...solidFields,
  type: z.literal('box'),
  halfExtents: dimensionsSchema,
  rotation: rotationSchema,
});
const sphereSchema = z.strictObject({
  ...solidFields,
  type: z.literal('sphere'),
  radius: dimension,
});
const currentSchema = z.strictObject({
  ...objectFields,
  type: z.literal('current'),
  halfExtents: dimensionsSchema,
  velocity: z
    .tuple([
      finite.min(-100).max(100),
      finite.min(-100).max(100),
      finite.min(-100).max(100),
    ])
    .readonly(),
});
const gateSchema = z.strictObject({
  ...objectFields,
  type: z.literal('rotating-gate'),
  halfExtents: dimensionsSchema,
  // Rotation about a world-space unit axis, starting at phase radians.
  axis: unitVectorSchema,
  phase: angle,
  angularSpeed: finite.min(-4 * Math.PI).max(4 * Math.PI),
});

export const currentVolumeSchema = currentSchema.readonly();
export const rotatingGateSchema = gateSchema.readonly();
export const courseObjectSchema = z
  .discriminatedUnion('type', [
    boxSchema,
    sphereSchema,
    currentSchema,
    gateSchema,
  ])
  .readonly();

const checkpointSchema = z
  .strictObject({
    id,
    position: positionSchema,
    radius: dimension.max(100),
    direction: unitVectorSchema,
  })
  .readonly();
const pearlSchema = z
  .strictObject({ id, position: positionSchema, radius: dimension.max(100) })
  .readonly();

export const courseDefinitionSchema = z
  .strictObject({
    version: z.literal(1),
    courseId: z.enum(COURSE_IDS),
    name: text.max(80),
    summary: text.max(300),
    medalTimesMs: medalTimesMsSchema,
    visuals: z
      .strictObject({
        kind: z.literal('generated'),
        waterColor: color,
        seabedColor: color,
      })
      .readonly(),
    spawn: z.strictObject({ position: positionSchema, yaw: angle }).readonly(),
    // Array order is traversal order, with the last checkpoint as the finish.
    checkpoints: z.array(checkpointSchema).min(1).max(256).readonly(),
    pearls: z.array(pearlSchema).max(MAX_COURSE_PEARLS).readonly().optional(),
    objects: z.array(courseObjectSchema).max(4_096).readonly(),
  })
  .superRefine((course, context) => {
    const ids = new Set<string>();
    for (const collection of ['checkpoints', 'pearls', 'objects'] as const) {
      course[collection]?.forEach((object, index) => {
        if (ids.has(object.id)) {
          context.addIssue({
            code: 'custom',
            path: [collection, index, 'id'],
            message: `Duplicate course object ID: ${object.id}`,
          });
        }
        ids.add(object.id);
      });
    }
  })
  .readonly();

export type Vector3 = z.infer<typeof vector3Schema>;
export type CourseObject = z.infer<typeof courseObjectSchema>;
export type CurrentVolumeDefinition = z.infer<typeof currentVolumeSchema>;
export type RotatingGateDefinition = z.infer<typeof rotatingGateSchema>;
export type CourseDefinition = z.infer<typeof courseDefinitionSchema>;

export function parseCourseDefinition(input: unknown): CourseDefinition {
  return courseDefinitionSchema.parse(input);
}
