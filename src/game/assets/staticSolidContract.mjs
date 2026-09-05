import { Vector3 } from 'three';
import { z } from 'zod';

const finite = z.number().finite();
const vector = z.tuple([finite, finite, finite]);
const positiveVector = z.tuple([
  finite.positive(),
  finite.positive(),
  finite.positive(),
]);
export const staticSolidExtrasSchema = z.strictObject({
  version: z.literal(1),
  role: z.literal('static-solid'),
  id: z.string().min(1).max(100),
  category: z.enum(['environment', 'hazard']),
  primitive: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('box'), halfExtents: positiveVector }),
    z.strictObject({ type: z.literal('sphere'), radius: finite.positive() }),
  ]),
  transform: z.strictObject({
    position: vector,
    rotation: z.tuple([finite, finite, finite, finite]),
    scale: positiveVector,
  }),
});

export const close = (a, b) => Math.abs(a - b) <= 1e-5;
export const sameVector = (a, b) =>
  a.length === b.length && a.every((value, i) => close(value, b[i]));

export function colliderContract(solid) {
  return staticSolidExtrasSchema.parse({
    version: 1,
    role: 'static-solid',
    id: solid.id,
    category: solid.collision,
    primitive:
      solid.type === 'box'
        ? { type: 'box', halfExtents: solid.halfExtents }
        : { type: solid.type, radius: solid.radius },
    transform: {
      position: solid.position,
      rotation: solid.rotation ?? [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
  });
}

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

/** Shared by offline byte validation and runtime loaded-geometry validation. */
export function validateSolidSurface(mesh, contract) {
  const shape = contract.primitive;
  const half =
    shape.type === 'box'
      ? shape.halfExtents
      : [shape.radius, shape.radius, shape.radius];
  requireThat(
    sameVector(
      mesh.bounds.min.toArray(),
      half.map((v) => -v),
    ) && sameVector(mesh.bounds.max.toArray(), half),
    `solid ${contract.id} geometry bounds`,
  );
  const edges = new Map();
  const faces = new Set();
  for (const { position, indices } of mesh.surfaces) {
    for (let i = 0; i < position.values.length; i += 3) {
      const p = position.values.slice(i, i + 3);
      const onSurface =
        shape.type === 'sphere'
          ? close(Math.hypot(...p), shape.radius)
          : p.every((value, axis) => close(Math.abs(value), half[axis]));
      requireThat(
        onSurface,
        `solid ${contract.id} surface disagrees with primitive`,
      );
    }
    for (let i = 0; i < indices.count; i += 3) {
      const points = indices.values
        .slice(i, i + 3)
        .map((index) => position.values.slice(index * 3, index * 3 + 3));
      const keys = points.map((point) =>
        point.map((value) => value.toFixed(5)).join(','),
      );
      const faceKey = [...keys].sort().join('|');
      requireThat(
        new Set(keys).size === 3 && !faces.has(faceKey),
        `solid ${contract.id} degenerate/duplicate surface triangle`,
      );
      faces.add(faceKey);
      const [a, b, c] = points.map((point) => new Vector3(...point));
      const normal = b.sub(a).cross(c.sub(a));
      requireThat(
        normal.dot(a) > 0,
        `solid ${contract.id} surface triangle is degenerate or inward`,
      );
      if (shape.type === 'box') {
        requireThat(
          [0, 1, 2].some((axis) =>
            points.every((point) => close(point[axis], points[0][axis])),
          ),
          `solid ${contract.id} surface triangle crosses box interior`,
        );
      }
      for (let edge = 0; edge < 3; edge++) {
        const from = keys[edge];
        const to = keys[(edge + 1) % 3];
        const key = [from, to].sort().join('|');
        const usage = edges.get(key) ?? { count: 0, direction: 0 };
        usage.count++;
        usage.direction += from < to ? 1 : -1;
        edges.set(key, usage);
      }
    }
  }
  requireThat(
    [...edges.values()].every(
      ({ count, direction }) => count === 2 && direction === 0,
    ),
    `solid ${contract.id} surface is not consistently closed`,
  );
  if (shape.type === 'box')
    requireThat(
      mesh.triangles === 12,
      `solid ${contract.id} box surface triangulation`,
    );
}
