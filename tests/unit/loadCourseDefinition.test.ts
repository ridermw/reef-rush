import { describe, expect, it, vi } from 'vitest';
import { COURSE_NAMES, COURSES } from '../../src/content/courses/courseIds';
import { loadCourseDefinition } from '../../src/game/course/loadCourseDefinition';
import { courseFixture } from '../fixtures/courseDefinition';

describe('explicit lazy course loading', () => {
  it('loads the original gltf Sunlit definition', async () => {
    const course = await loadCourseDefinition('sunlit-shoals');
    expect(course.courseId).toBe('sunlit-shoals');
    expect(course.name).toBe(COURSE_NAMES['sunlit-shoals']);
    expect(course.visuals).toMatchObject({
      kind: 'gltf',
      visualAsset: 'courses/sunlit-shoals.visual.glb',
      collisionAsset: 'courses/sunlit-shoals.collision.glb',
    });
    expect(course.medalTimesMs).toEqual({
      gold: 12_000,
      silver: 18_000,
      bronze: 30_000,
    });
    expect(course.checkpoints.length).toBeGreaterThanOrEqual(3);
    expect(course.pearls?.length).toBeGreaterThan(0);
    expect(course.objects.map((object) => object.type)).toEqual(
      expect.arrayContaining(['box', 'sphere', 'current', 'rotating-gate']),
    );
  });

  it('loads original gltf Kelpworks without enabling course selection', async () => {
    await expect(loadCourseDefinition('kelpworks')).resolves.toMatchObject({
      courseId: 'kelpworks',
      name: COURSE_NAMES.kelpworks,
      visuals: {
        kind: 'gltf',
        visualAsset: 'courses/kelpworks.visual.glb',
        collisionAsset: 'courses/kelpworks.collision.glb',
        waterColor: '#17665b',
        seabedColor: '#586d45',
      },
      medalTimesMs: { gold: 24_000, silver: 36_000, bronze: 55_000 },
    });
    expect(COURSES.find((course) => course.id === 'kelpworks')?.available).toBe(
      false,
    );
  });

  it.each(['blacksmoker-run'])(
    'rejects unbuilt %s without a fallback',
    async (id) => {
      await expect(loadCourseDefinition(id)).rejects.toThrow(
        `Course "${id}" is not implemented`,
      );
    },
  );

  it.each(['unknown', '../sunlit-shoals', '', 'toString', '__proto__'])(
    'rejects unknown ID %j before loading',
    async (id) => {
      const loader = vi.fn(() => Promise.resolve({ default: courseFixture() }));
      await expect(
        loadCourseDefinition(id, { 'sunlit-shoals': loader }),
      ).rejects.toThrow('Unknown course ID');
      expect(loader).not.toHaveBeenCalled();
    },
  );

  it('selects only the requested importer', async () => {
    const unused = vi.fn(() => Promise.resolve({ default: courseFixture() }));
    const course = await loadCourseDefinition('sunlit-shoals', {
      'sunlit-shoals': () => Promise.resolve({ default: courseFixture() }),
      kelpworks: unused,
    });
    expect(course.courseId).toBe('sunlit-shoals');
    expect(unused).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { default: null },
    { default: { ...courseFixture(), version: 2 } },
    {
      default: { ...courseFixture(), spawn: { position: [0, NaN, 0], yaw: 0 } },
    },
  ])('rejects malformed module payload %#', async (payload) => {
    await expect(
      loadCourseDefinition('sunlit-shoals', {
        'sunlit-shoals': () => Promise.resolve(payload),
      }),
    ).rejects.toThrow('Invalid course definition for "sunlit-shoals"');
  });

  it('rejects a parsed course ID that does not match the request', async () => {
    await expect(
      loadCourseDefinition('sunlit-shoals', {
        'sunlit-shoals': () =>
          Promise.resolve({
            default: { ...courseFixture(), courseId: 'kelpworks' },
          }),
      }),
    ).rejects.toThrow(
      'Course ID mismatch: requested "sunlit-shoals", received "kelpworks"',
    );
  });

  it('preserves an import failure as the cause of a clear load error', async () => {
    const cause = new Error('Import unavailable');
    const promise = loadCourseDefinition('sunlit-shoals', {
      'sunlit-shoals': () => Promise.reject(cause),
    });
    await expect(promise).rejects.toThrow(
      'Failed to import course "sunlit-shoals"',
    );
    await expect(promise).rejects.toMatchObject({ cause });
  });

  it('reparses cached module data for every load and prevents shared mutation', async () => {
    const source = { ...courseFixture(), name: 'First name' };
    const loader = () => Promise.resolve({ default: source });
    const first = await loadCourseDefinition('sunlit-shoals', {
      'sunlit-shoals': loader,
    });
    source.name = 'Second name';
    const second = await loadCourseDefinition('sunlit-shoals', {
      'sunlit-shoals': loader,
    });
    expect(first.name).toBe('First name');
    expect(second.name).toBe('Second name');
    expect(first).not.toBe(second);
    expect(first.spawn.position).not.toBe(second.spawn.position);
    expect(Object.isFrozen(first.objects[0])).toBe(true);
    expect(Object.isFrozen(first.spawn.position)).toBe(true);
  });
});
