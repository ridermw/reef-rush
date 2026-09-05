// @vitest-environment node
import { Group } from 'three';
import { afterEach, expect, it } from 'vitest';
import sunlit from '../../src/content/courses/sunlitShoals';
import kelpworks from '../../src/content/courses/kelpworks';
import blacksmoker from '../../src/content/courses/blacksmokerRun';
import type { CourseDefinition } from '../../src/game/course/courseDefinition';
import {
  createAssetCache,
  type AssetLease,
} from '../../src/game/assets/AssetCache';
import {
  collisionAsset,
  blackCollisionAsset,
  blackVisualAsset,
  kelpCollisionAsset,
  kelpVisualAsset,
  localAssetLoader,
  originalMetadata,
  visualAsset,
} from '../fixtures/originalAssets';
import { isSceneMesh } from '../fixtures/sceneMeshes';

const leases: AssetLease[] = [];
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
});

async function setup(path = collisionAsset, course: CourseDefinition = sunlit) {
  const cache = createAssetCache({ loader: localAssetLoader });
  const lease = await cache.acquire(path);
  leases.push(lease);
  const { validateLoadedCourseAsset } =
    await import('../../src/game/assets/validateLoadedCourseAsset');
  return {
    root: lease.root,
    validate: () =>
      validateLoadedCourseAsset(
        lease.root,
        course,
        path,
        path === collisionAsset ||
          path === kelpCollisionAsset ||
          path === blackCollisionAsset
          ? 'collision'
          : 'visual',
      ),
  };
}

function mesh(root: Group, name = 'sand-bed') {
  const value = root.getObjectByName(name);
  if (!isSceneMesh(value)) throw new Error(`Missing fixture mesh: ${name}`);
  return value;
}

it.each([
  { path: collisionAsset, course: sunlit },
  { path: visualAsset, course: sunlit },
  { path: kelpCollisionAsset, course: kelpworks },
  { path: kelpVisualAsset, course: kelpworks },
  { path: blackCollisionAsset, course: blacksmoker },
  { path: blackVisualAsset, course: blacksmoker },
])(
  'accepts actual GLTFLoader committed $path bytes',
  async ({ path, course }) => {
    const { validate } = await setup(path, course);
    expect(validate).not.toThrow();
  },
);

it.each([
  { path: collisionAsset, course: kelpworks },
  { path: visualAsset, course: kelpworks },
  { path: kelpCollisionAsset, course: sunlit },
  { path: kelpVisualAsset, course: sunlit },
  { path: blackCollisionAsset, course: sunlit },
  { path: blackVisualAsset, course: sunlit },
  { path: blackCollisionAsset, course: kelpworks },
  { path: blackVisualAsset, course: kelpworks },
  { path: collisionAsset, course: blacksmoker },
  { path: visualAsset, course: blacksmoker },
  { path: kelpCollisionAsset, course: blacksmoker },
  { path: kelpVisualAsset, course: blacksmoker },
])(
  'rejects actual $path bytes paired with the wrong course',
  async ({ path, course }) => {
    const { validate } = await setup(path, course);
    expect(validate).toThrow(/solid/);
  },
);

it.each([
  {
    kind: 'identity',
    error: /^Invalid course asset: scene asset identity mismatch$/,
  },
  { kind: 'missing', error: /^Invalid course asset: missing static solids$/ },
  {
    kind: 'extra',
    error: /^Invalid course asset: solid identity smoker-extra$/,
  },
  {
    kind: 'decoration',
    error:
      /^Invalid course asset: unsupported colliding node decor-smoker-forbidden$/,
  },
  { kind: 'surface', error: /^solid .*surface/ },
  {
    kind: 'transform',
    error: /^Invalid course asset: world transform smoker-seabed$/,
  },
])(
  'rejects Blacksmoker collision $kind after actual GLTFLoader parsing',
  async ({ kind, error }) => {
    const { root, validate } = await setup(blackCollisionAsset, blacksmoker);
    expect(validate).not.toThrow();
    const solid = mesh(root, 'smoker-seabed');
    if (kind === 'identity') originalMetadata(root).asset = kelpCollisionAsset;
    if (kind === 'missing') mesh(root, 'smoker-cinder-vent').removeFromParent();
    if (kind === 'extra') {
      const extra = solid.clone();
      extra.name = 'smoker-extra';
      originalMetadata(extra).id = extra.name;
      root.add(extra);
    }
    if (kind === 'decoration') {
      const decor = solid.clone();
      decor.name = 'decor-smoker-forbidden';
      decor.userData.reefRush = {
        version: 1,
        role: 'decoration',
        collides: false,
      };
      root.add(decor);
    }
    if (kind === 'surface')
      mesh(root, 'smoker-west-root')
        .geometry.getAttribute('position')
        .setXYZ(10, 0, 0, 0);
    if (kind === 'transform') solid.position.x++;
    expect(validate).toThrow(error);
  },
);

it.each([
  'identity',
  'missing',
  'extra',
  'decoration',
  'surface',
  'transform',
] as const)(
  'rejects Kelp collision %s after actual GLTFLoader parsing',
  async (kind) => {
    const { root, validate } = await setup(kelpCollisionAsset, kelpworks);
    const solid = mesh(root, 'kelp-seabed');
    if (kind === 'identity') originalMetadata(root).asset = collisionAsset;
    if (kind === 'missing') solid.removeFromParent();
    if (kind === 'extra') {
      const extra = solid.clone();
      extra.name = 'kelp-extra';
      root.add(extra);
    }
    if (kind === 'decoration') {
      const decor = solid.clone();
      decor.name = 'decor-kelp-forbidden';
      decor.userData.reefRush = {
        version: 1,
        role: 'decoration',
        collides: false,
      };
      root.add(decor);
    }
    if (kind === 'surface')
      mesh(root, 'kelp-west-roots')
        .geometry.getAttribute('position')
        .setXYZ(10, 0, 0, 0);
    if (kind === 'transform') solid.position.x++;
    expect(validate).toThrow();
  },
);

it.each([
  [
    'profile',
    (root: Group) => {
      originalMetadata(root).profile = 'other';
    },
  ],
  [
    'asset identity',
    (root: Group) => {
      originalMetadata(root).asset = visualAsset;
    },
  ],
  [
    'units',
    (root: Group) => {
      originalMetadata(root).metersPerUnit = 100;
    },
  ],
  [
    'missing solid',
    (root: Group) => {
      mesh(root).removeFromParent();
    },
  ],
  [
    'duplicate solid',
    (root: Group) => {
      root.add(mesh(root).clone());
    },
  ],
  [
    'extra solid',
    (root: Group) => {
      const extra = mesh(root).clone();
      extra.name = 'extra';
      root.add(extra);
    },
  ],
  [
    'version',
    (root: Group) => {
      originalMetadata(mesh(root)).version = 2;
    },
  ],
  [
    'id',
    (root: Group) => {
      originalMetadata(mesh(root)).id = 'wrong';
    },
  ],
  [
    'category',
    (root: Group) => {
      originalMetadata(mesh(root)).category = 'hazard';
    },
  ],
  [
    'type',
    (root: Group) => {
      originalMetadata(mesh(root)).primitive = { type: 'sphere', radius: 22 };
    },
  ],
  [
    'dimension',
    (root: Group) => {
      originalMetadata(mesh(root)).primitive = {
        type: 'box',
        halfExtents: [21, 2, 60],
      };
    },
  ],
  [
    'metadata transform',
    (root: Group) => {
      originalMetadata(mesh(root)).transform = {
        position: [2, -10, 45],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      };
    },
  ],
  [
    'actual position',
    (root: Group) => {
      mesh(root).position.x = 2;
    },
  ],
  [
    'actual rotation',
    (root: Group) => {
      mesh(root).rotation.y = 0.2;
    },
  ],
  [
    'actual scale',
    (root: Group) => {
      mesh(root).scale.x = 2;
    },
  ],
  [
    'ancestor transform',
    (root: Group) => {
      root.position.x = 2;
    },
  ],
  [
    'nonfinite actual transform',
    (root: Group) => {
      mesh(root).position.x = NaN;
    },
  ],
  [
    'unsupported colliding group',
    (root: Group) => {
      const group = new Group();
      group.userData.reefRush = originalMetadata(mesh(root));
      root.add(group);
    },
  ],
  [
    'unmarked mesh',
    (root: Group) => {
      const extra = mesh(root).clone();
      extra.userData = {};
      root.add(extra);
    },
  ],
  [
    'decoration in collision',
    (root: Group) => {
      mesh(root).userData.reefRush = {
        version: 1,
        role: 'decoration',
        collides: false,
      };
    },
  ],
  [
    'actual bounds',
    (root: Group) => {
      mesh(root).geometry.scale(0.9, 1, 1);
    },
  ],
  [
    'sphere surface with unchanged bounds',
    (root: Group) => {
      const p = mesh(root, 'coral-mound-east').geometry.getAttribute(
        'position',
      );
      p.setXYZ(10, 0, 0, 0);
    },
  ],
  [
    'missing triangle',
    (root: Group) => {
      const geometry = mesh(root).geometry;
      geometry.setIndex(Array.from(geometry.index!.array).slice(3));
    },
  ],
  [
    'inward triangle',
    (root: Group) => {
      const index = mesh(root).geometry.index!;
      const a = index.getX(0);
      index.setX(0, index.getX(1));
      index.setX(1, a);
    },
  ],
  [
    'hidden solid',
    (root: Group) => {
      mesh(root).visible = false;
    },
  ],
] as const)('rejects %s instead of trusting extras', async (_name, mutate) => {
  const { root, validate } = await setup();
  mutate(root);
  expect(validate).toThrow();
});

it('accepts equivalent quaternion sign but not a visual identity mismatch', async () => {
  const { root, validate } = await setup();
  mesh(root).quaternion.set(0, 0, 0, -1);
  expect(validate).not.toThrow();
  const visual = await setup(visualAsset);
  originalMetadata(mesh(visual.root)).id = 'another-course';
  expect(visual.validate).toThrow();
});
