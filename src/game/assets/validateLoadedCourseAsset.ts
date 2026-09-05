import {
  Box3,
  BufferGeometry,
  Material,
  Matrix4,
  Mesh,
  Quaternion,
  SkinnedMesh,
  Vector3,
  type Group,
  type Object3D,
} from 'three';
import { z } from 'zod';
import type { CourseDefinition } from '../course/courseDefinition';
import {
  colliderContract,
  sameVector,
  staticSolidExtrasSchema,
  validateSolidSurface,
} from './staticSolidContract.mjs';

const sceneProfile = z.strictObject({
  profile: z.literal('reef-rush-original-v1'),
  asset: z.string(),
  up: z.literal('+Y'),
  forward: z.literal('+Z'),
  metersPerUnit: z.literal(1),
  seed: z.literal(9042026),
});
const decoration = z.strictObject({
  version: z.literal(1),
  role: z.literal('decoration'),
  collides: z.literal(false),
});

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid course asset: ${message}`);
}

function isCourseMesh(
  node: Object3D,
): node is Mesh<BufferGeometry, Material | Material[]> {
  return node instanceof Mesh;
}

export function validateLoadedAssetIdentity(root: Group, path: string): void {
  const profile = sceneProfile.parse(root.userData.reefRush);
  requireThat(profile.asset === path, 'scene asset identity mismatch');
}

export function validateLoadedCourseAsset(
  root: Group,
  course: CourseDefinition,
  path: string,
  kind: 'visual' | 'collision',
): void {
  validateLoadedAssetIdentity(root, path);
  const expected = new Map(
    course.objects
      .filter((object) => object.type === 'box' || object.type === 'sphere')
      .map((solid) => [solid.id, colliderContract(solid)]),
  );
  const seen = new Set<string>();
  const names = new Set<string>();
  const point = new Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse((node) => {
    if (node === root) return;
    requireThat(
      isCourseMesh(node) && node.parent === root,
      'unsupported course node',
    );
    requireThat(!names.has(node.name), `duplicate node ${node.name}`);
    names.add(node.name);
    requireThat(node.visible && root.visible, `hidden node ${node.name}`);
    requireThat(
      !(node instanceof SkinnedMesh) &&
        Object.keys(node.geometry.morphAttributes).length === 0,
      'deformed course mesh',
    );
    const parsed = staticSolidExtrasSchema.safeParse(node.userData.reefRush);
    if (!parsed.success) {
      requireThat(kind === 'visual', `unsupported colliding node ${node.name}`);
      decoration.parse(node.userData.reefRush);
      requireThat(node.name.startsWith('decor-'), 'unnamed decoration');
      return;
    }
    const actual = parsed.data;
    const solid = expected.get(actual.id);
    requireThat(
      solid && node.name === actual.id && !seen.has(actual.id),
      `solid identity ${node.name}`,
    );
    requireThat(
      actual.category === solid.category &&
        JSON.stringify(actual.primitive) === JSON.stringify(solid.primitive) &&
        sameVector(actual.transform.position, solid.transform.position) &&
        sameVector(actual.transform.scale, solid.transform.scale) &&
        (sameVector(actual.transform.rotation, solid.transform.rotation) ||
          sameVector(
            actual.transform.rotation,
            solid.transform.rotation.map((v) => -v),
          )),
      `solid metadata ${node.name}`,
    );
    const matrix = new Matrix4().compose(
      new Vector3(...solid.transform.position),
      new Quaternion(...solid.transform.rotation),
      new Vector3(...solid.transform.scale),
    );
    requireThat(
      sameVector(node.matrixWorld.elements, matrix.elements),
      `world transform ${node.name}`,
    );
    const geometry = node.geometry;
    const positions = geometry.getAttribute('position');
    const index = geometry.index;
    requireThat(
      positions &&
        positions.itemSize === 3 &&
        positions.count > 0 &&
        positions.count <= 100_000 &&
        index &&
        index.count > 0 &&
        index.count <= 300_000 &&
        index.count % 3 === 0 &&
        geometry.drawRange.start === 0 &&
        (geometry.drawRange.count === Infinity ||
          geometry.drawRange.count === index.count),
      `geometry profile ${node.name}`,
    );
    const bounds = new Box3();
    const values: number[] = [];
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i);
      requireThat(
        point.toArray().every(Number.isFinite),
        `nonfinite geometry ${node.name}`,
      );
      values.push(point.x, point.y, point.z);
      bounds.expandByPoint(point);
    }
    const indices: number[] = [];
    for (let i = 0; i < index.count; i++) {
      const value = index.getX(i);
      requireThat(
        Number.isInteger(value) && value >= 0 && value < positions.count,
        `index ${node.name}`,
      );
      indices.push(value);
    }
    validateSolidSurface(
      {
        bounds,
        triangles: index.count / 3,
        surfaces: [
          {
            position: { values },
            indices: { values: indices, count: index.count },
          },
        ],
      },
      actual,
    );
    seen.add(actual.id);
  });
  requireThat(seen.size === expected.size, 'missing static solids');
}
