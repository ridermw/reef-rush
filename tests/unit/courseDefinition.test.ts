import { describe, expect, it } from 'vitest';
import {
  courseDefinitionSchema,
  parseCourseDefinition,
} from '../../src/game/course/courseDefinition';
import { courseFixture } from '../fixtures/courseDefinition';

const valid = courseFixture();

describe('version 1 course definitions', () => {
  it('parses the declarative geometry, route and generated visuals', () => {
    expect(parseCourseDefinition(valid)).toEqual(valid);
    expect(
      parseCourseDefinition({ ...valid, pearls: undefined }),
    ).toMatchObject({
      courseId: valid.courseId,
    });
  });

  it('isolates parsed data from subsequent authored input mutation', () => {
    const position = [0, -3, 0];
    const source = { ...valid, spawn: { position, yaw: 0 } };
    const parsed = parseCourseDefinition(source);
    position[0] = 9;
    source.spawn.yaw = 1;
    expect(parsed).toEqual(valid);
  });

  it('publishes an immutable definition', () => {
    expect(Object.isFrozen(parseCourseDefinition(valid))).toBe(true);
  });

  it.each([
    ['missing data', {}],
    ['wrong version', { ...valid, version: 2 }],
    ['unknown course ID', { ...valid, courseId: 'other' }],
    ['empty name', { ...valid, name: ' ' }],
    ['unknown field', { ...valid, typo: true }],
    ['nonfinite spawn', { ...valid, spawn: { position: [0, NaN, 0], yaw: 0 } }],
    ['short tuple', { ...valid, spawn: { position: [0, 0], yaw: 0 } }],
    [
      'out of bounds spawn',
      { ...valid, spawn: { position: [10001, 0, 0], yaw: 0 } },
    ],
    ['infinite yaw', { ...valid, spawn: { ...valid.spawn, yaw: Infinity } }],
    ['empty route', { ...valid, checkpoints: [] }],
    [
      'zero checkpoint radius',
      { ...valid, checkpoints: [{ ...valid.checkpoints[0], radius: 0 }] },
    ],
    [
      'zero direction',
      {
        ...valid,
        checkpoints: [{ ...valid.checkpoints[0], direction: [0, 0, 0] }],
      },
    ],
    [
      'non-unit direction',
      {
        ...valid,
        checkpoints: [{ ...valid.checkpoints[0], direction: [0, 0, 2] }],
      },
    ],
    ['empty ID', { ...valid, objects: [{ ...valid.objects[0], id: '' }] }],
    [
      'duplicate object ID',
      { ...valid, objects: [valid.objects[0], valid.objects[0]] },
    ],
    [
      'cross-kind duplicate ID',
      { ...valid, pearls: [{ ...valid.pearls[0], id: 'start' }] },
    ],
    [
      'negative dimension',
      { ...valid, objects: [{ ...valid.objects[0], halfExtents: [-1, 1, 1] }] },
    ],
    [
      'zero dimension',
      { ...valid, objects: [{ ...valid.objects[0], halfExtents: [1, 0, 1] }] },
    ],
    [
      'infinite dimension',
      {
        ...valid,
        objects: [{ ...valid.objects[0], halfExtents: [1, Infinity, 1] }],
      },
    ],
    [
      'zero rotation',
      { ...valid, objects: [{ ...valid.objects[0], rotation: [0, 0, 0, 0] }] },
    ],
    [
      'non-unit rotation',
      { ...valid, objects: [{ ...valid.objects[0], rotation: [0, 0, 0, 2] }] },
    ],
    [
      'nonfinite rotation',
      {
        ...valid,
        objects: [{ ...valid.objects[0], rotation: [NaN, 0, 0, 1] }],
      },
    ],
    [
      'negative sphere radius',
      { ...valid, objects: [{ ...valid.objects[1], radius: -1 }] },
    ],
    [
      'nonfinite flow',
      {
        ...valid,
        objects: [{ ...valid.objects[2], velocity: [0, Infinity, 0] }],
      },
    ],
    [
      'zero gate axis',
      { ...valid, objects: [{ ...valid.objects[3], axis: [0, 0, 0] }] },
    ],
    [
      'nonfinite gate phase',
      { ...valid, objects: [{ ...valid.objects[3], phase: Infinity }] },
    ],
    [
      'excessive gate speed',
      { ...valid, objects: [{ ...valid.objects[3], angularSpeed: 1000 }] },
    ],
    [
      'invalid pearl radius',
      { ...valid, pearls: [{ ...valid.pearls[0], radius: 0 }] },
    ],
    [
      'unsupported visuals',
      { ...valid, visuals: { kind: 'gltf', url: 'course.glb' } },
    ],
    [
      'invalid color',
      { ...valid, objects: [{ ...valid.objects[0], color: 'red' }] },
    ],
  ])('rejects %s', (_, input) => {
    expect(courseDefinitionSchema.safeParse(input).success).toBe(false);
    expect(() => parseCourseDefinition(input)).toThrow();
  });

  it.each(['kelpworks', 'blacksmoker-run'])(
    'accepts known course ID %s as data, not built content',
    (courseId) => {
      expect(parseCourseDefinition({ ...valid, courseId })).toMatchObject({
        courseId,
      });
    },
  );
});
