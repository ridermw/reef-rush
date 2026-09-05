import { describe, expect, it } from 'vitest';
import {
  courseDefinitionSchema,
  parseCourseDefinition,
} from '../../src/game/course/courseDefinition';
import { courseFixture } from '../fixtures/courseDefinition';

const valid = courseFixture();
const gltf = {
  kind: 'gltf',
  visualAsset: 'courses/sunlit-shoals.visual.glb',
  collisionAsset: 'courses/sunlit-shoals.collision.glb',
  waterColor: '#208eaa',
  seabedColor: '#e4d2a2',
};

describe('version 1 course definitions', () => {
  it('accepts a strict immutable gltf variant with distinct cache-relative paths', () => {
    const parsed = parseCourseDefinition({ ...valid, visuals: gltf });
    expect(parsed.visuals).toEqual(gltf);
    expect(Object.isFrozen(parsed.visuals)).toBe(true);
  });

  it.each([
    '',
    '/courses/reef.glb',
    'assets/courses/reef.glb',
    '../reef.glb',
    'courses/../reef.glb',
    'https://example.test/reef.glb',
    'courses\\reef.glb',
    'courses/%2e%2e/reef.glb',
    'courses/reef.glb?x=1',
    'courses/reef.glb#scene',
    'courses//reef.glb',
    'courses/reef.gltf',
    'courses/reef.GLB',
  ])('rejects invalid gltf asset path %s in either field', (path) => {
    for (const field of ['visualAsset', 'collisionAsset']) {
      expect(() =>
        parseCourseDefinition({
          ...valid,
          visuals: { ...gltf, [field]: path },
        }),
      ).toThrow();
    }
  });

  it.each([
    { ...gltf, collisionAsset: gltf.visualAsset },
    { ...gltf, visualAsset: undefined },
    { ...gltf, collisionAsset: undefined },
    { ...gltf, waterColor: undefined },
    { ...gltf, url: 'reef.glb' },
    { ...gltf, kind: 'generated' },
  ])('rejects incomplete, equal or mixed visual variants', (visuals) => {
    expect(() => parseCourseDefinition({ ...valid, visuals })).toThrow();
  });

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
    ['missing medal times', { ...valid, medalTimesMs: undefined }],
    [
      'unordered medal times',
      { ...valid, medalTimesMs: { gold: 100, silver: 100, bronze: 200 } },
    ],
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
