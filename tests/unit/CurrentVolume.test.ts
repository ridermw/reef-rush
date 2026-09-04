import { describe, expect, it } from 'vitest';
import { CurrentVolume } from '../../src/game/obstacles/CurrentVolume';
import { courseFixture } from '../fixtures/courseDefinition';

const definition = {
  ...courseFixture().objects[2],
  position: [10, -5, 3],
  halfExtents: [2, 3, 4],
  velocity: [1, -2, 3],
};

const fractionalDefinition = {
  ...definition,
  position: [1, -1, 1],
  halfExtents: [0.01, 0.01, 0.01],
};

describe('axis-aligned current volumes', () => {
  it.each([
    [10, -5, 3],
    [8, -5, 3],
    [12, -5, 3],
    [10, -8, 3],
    [10, -2, 3],
    [10, -5, -1],
    [10, -5, 7],
    [8, -8, -1],
    [12, -2, 7],
  ] as const)(
    'includes the center, faces and corners (%s, %s, %s)',
    (x, y, z) => {
      expect(new CurrentVolume(definition).sampleCurrent([x, y, z])).toEqual([
        1, -2, 3,
      ]);
    },
  );

  it.each([
    [7.999, -5, 3],
    [12.001, -5, 3],
    [10, -8.001, 3],
    [10, -1.999, 3],
    [10, -5, -1.001],
    [10, -5, 7.001],
  ] as const)('returns zero outside any face (%s, %s, %s)', (x, y, z) => {
    expect(new CurrentVolume(definition).sampleCurrent([x, y, z])).toEqual([
      0, 0, 0,
    ]);
  });

  it.each([
    [-1, 0, 0],
    [1, 0, 0],
    [0, -1, 0],
    [0, 1, 0],
    [0, 0, -1],
    [0, 0, 1],
    [-1, -1, -1],
    [-1, -1, 1],
    [-1, 1, -1],
    [-1, 1, 1],
    [1, -1, -1],
    [1, -1, 1],
    [1, 1, -1],
    [1, 1, 1],
  ] as const)(
    'includes fractional faces and corners at offset (%s, %s, %s)',
    (x, y, z) => {
      const volume = new CurrentVolume(fractionalDefinition);
      expect(
        volume.sampleCurrent([1 + x * 0.01, -1 + y * 0.01, 1 + z * 0.01]),
      ).toEqual([1, -2, 3]);
    },
  );

  it.each([
    [1 - 0.01 - Number.EPSILON, -1, 1],
    [1 + 0.01 + Number.EPSILON, -1, 1],
    [1, -1 - 0.01 - Number.EPSILON, 1],
    [1, -1 + 0.01 + Number.EPSILON, 1],
    [1, -1, 1 - 0.01 - Number.EPSILON],
    [1, -1, 1 + 0.01 + Number.EPSILON],
  ] as const)(
    'excludes points just beyond fractional faces (%s, %s, %s)',
    (x, y, z) => {
      expect(
        new CurrentVolume(fractionalDefinition).sampleCurrent([x, y, z]),
      ).toEqual([0, 0, 0]);
    },
  );

  it('does not let input or output mutation change sampled flow', () => {
    const velocity = [1, 2, 3];
    const volume = new CurrentVolume({ ...definition, velocity });
    velocity[0] = 50;
    const result = volume.sampleCurrent([10, -5, 3]);
    result[1] = 80;
    expect(volume.sampleCurrent([10, -5, 3])).toEqual([1, 2, 3]);
  });

  it.each([
    { halfExtents: [0, 1, 1] },
    { halfExtents: [1, -1, 1] },
    { position: [NaN, 0, 0] },
    { velocity: [0, Infinity, 0] },
    { halfExtents: [1, Infinity, 1] },
    { velocity: [101, 0, 0] },
  ])('validates direct construction %j', (override) => {
    expect(() => new CurrentVolume({ ...definition, ...override })).toThrow();
  });

  it.each([-1, NaN, Infinity, -Infinity])('rejects invalid delta %s', (dt) => {
    expect(() => new CurrentVolume(definition).update(dt)).toThrow(
      'dt must be finite and nonnegative',
    );
  });

  it('supports zero delta and rejects nonfinite sample positions', () => {
    const volume = new CurrentVolume(definition);
    expect(() => volume.update(0)).not.toThrow();
    expect(() => volume.sampleCurrent([0, NaN, 0])).toThrow();
  });

  it('disposes idempotently and rejects subsequent work', () => {
    const volume = new CurrentVolume(definition);
    volume.dispose();
    expect(() => volume.dispose()).not.toThrow();
    expect(() => volume.update(0)).toThrow('disposed');
    expect(() => volume.sampleCurrent([10, -5, 3])).toThrow('disposed');
  });
});
