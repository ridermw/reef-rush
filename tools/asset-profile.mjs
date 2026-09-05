import { access, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { z } from 'zod';
import {
  colliderContract,
  staticSolidExtrasSchema as solidExtras,
  validateSolidSurface,
} from '../src/game/assets/staticSolidContract.mjs';
export { colliderContract };

export const ASSET_PATHS = Object.freeze([
  'fish/sunfin.glb',
  'props/reef-kit.glb',
  'courses/sunlit-shoals.visual.glb',
  'courses/sunlit-shoals.collision.glb',
]);
const FILE_BYTES = 2 * 1024 * 1024;
const SET_BYTES = 5 * 1024 * 1024;
const DECODED_COMPONENTS = 1_000_000;
const ACCESSOR_WIDTHS = { SCALAR: 1, VEC3: 3, VEC4: 4 };
const finite = z.number().finite();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = z.string().min(1).max(100);
const vector = z.tuple([finite, finite, finite]);
const quaternion = z.tuple([finite, finite, finite, finite]);
const positiveVector = z.tuple([
  finite.positive(),
  finite.positive(),
  finite.positive(),
]);
const nodeExtras = z.strictObject({
  reefRush: z.union([
    solidExtras,
    z.strictObject({
      version: z.literal(1),
      role: z.enum(['decoration', 'fish-part']),
      collides: z.literal(false),
    }),
  ]),
});
const sceneExtras = z.strictObject({
  reefRush: z.strictObject({
    profile: z.literal('reef-rush-original-v1'),
    asset: z.enum(ASSET_PATHS),
    up: z.literal('+Y'),
    forward: z.literal('+Z'),
    metersPerUnit: z.literal(1),
    seed: z.literal(9042026),
  }),
});

// A deliberately bounded export profile: one flat scene, tightly packed indexed
// triangles, float positions/normals, lit colors and optional quaternion animation.
// Strict objects reject URIs, textures, extensions/decoders, sparse/interleaved
// accessors, hierarchies, matrices, skins, morphs, cameras and lights at any level.
const documentSchema = z.strictObject({
  asset: z.strictObject({ version: z.literal('2.0'), generator: name }),
  scene: z.literal(0),
  scenes: z
    .array(
      z.strictObject({ name, nodes: z.array(integer), extras: sceneExtras }),
    )
    .length(1),
  nodes: z
    .array(
      z.strictObject({
        name,
        mesh: integer,
        translation: vector.optional(),
        rotation: quaternion.optional(),
        scale: positiveVector.optional(),
        extras: nodeExtras,
      }),
    )
    .min(1)
    .max(4096),
  meshes: z
    .array(
      z.strictObject({
        name,
        primitives: z
          .array(
            z.strictObject({
              attributes: z.strictObject({
                POSITION: integer,
                NORMAL: integer,
              }),
              indices: integer,
              material: integer,
              mode: z.literal(4).optional(),
            }),
          )
          .min(1)
          .max(8),
      }),
    )
    .min(1)
    .max(512),
  materials: z
    .array(
      z.strictObject({
        name,
        doubleSided: z.boolean().optional(),
        pbrMetallicRoughness: z.strictObject({
          baseColorFactor: z.tuple([
            finite.min(0).max(1),
            finite.min(0).max(1),
            finite.min(0).max(1),
            z.literal(1),
          ]),
          metallicFactor: finite.min(0).max(1),
          roughnessFactor: finite.min(0).max(1),
        }),
      }),
    )
    .min(1)
    .max(64),
  buffers: z.array(z.strictObject({ byteLength: integer })).length(1),
  bufferViews: z
    .array(
      z.strictObject({
        buffer: z.literal(0),
        byteOffset: integer.optional(),
        byteLength: integer,
        target: z.union([z.literal(34962), z.literal(34963)]).optional(),
      }),
    )
    .min(1)
    .max(4096),
  accessors: z
    .array(
      z.strictObject({
        bufferView: integer,
        byteOffset: integer.optional(),
        componentType: z.union([
          z.literal(5123),
          z.literal(5125),
          z.literal(5126),
        ]),
        count: integer.positive(),
        type: z.enum(['SCALAR', 'VEC3', 'VEC4']),
        min: z.array(finite).optional(),
        max: z.array(finite).optional(),
      }),
    )
    .min(1)
    .max(4096),
  animations: z
    .array(
      z.strictObject({
        name,
        extras: sceneExtras.optional(),
        channels: z
          .array(
            z.strictObject({
              sampler: integer,
              target: z.strictObject({
                node: integer,
                path: z.literal('rotation'),
              }),
            }),
          )
          .min(1)
          .max(8),
        samplers: z
          .array(
            z.strictObject({
              input: integer,
              output: integer,
              interpolation: z.literal('LINEAR'),
            }),
          )
          .min(1)
          .max(8),
      }),
    )
    .max(1)
    .optional(),
});

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
const close = (a, b) => Math.abs(a - b) <= 1e-5;
const sameVector = (a, b) =>
  a.length === b.length && a.every((value, i) => close(value, b[i]));
const unitQuaternion = (q) => close(Math.hypot(...q), 1);

function decodeGlb(bytes) {
  requireThat(
    bytes.length >= 28 && bytes.readUInt32LE(0) === 0x46546c67,
    'GLB header magic/size',
  );
  requireThat(
    bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length,
    'GLB version/total length',
  );
  let cursor = 12;
  const chunks = [];
  for (const type of [0x4e4f534a, 0x004e4942]) {
    requireThat(cursor + 8 <= bytes.length, 'GLB truncated chunk header');
    const length = bytes.readUInt32LE(cursor);
    requireThat(
      length % 4 === 0 && length > 0 && cursor + 8 + length <= bytes.length,
      'GLB chunk length/alignment',
    );
    requireThat(
      bytes.readUInt32LE(cursor + 4) === type,
      'GLB unsupported chunk type/order',
    );
    chunks.push(bytes.subarray(cursor + 8, cursor + 8 + length));
    cursor += 8 + length;
  }
  requireThat(cursor === bytes.length, 'GLB extra chunks/trailing bytes');
  const parsed = documentSchema.safeParse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(chunks[0])),
  );
  requireThat(
    parsed.success,
    `Unsupported original asset profile: ${parsed.error?.message}`,
  );
  const document = parsed.data;
  const binary = chunks[1];
  const size = document.buffers[0].byteLength;
  requireThat(
    size <= binary.length && binary.length - size <= 3,
    'GLB embedded buffer length',
  );
  requireThat(
    binary.subarray(size).every((byte) => byte === 0),
    'GLB nonzero BIN padding',
  );
  return { document, binary };
}

function readAccessors(document, binary) {
  const components = document.accessors.reduce(
    (total, accessor) =>
      total + accessor.count * ACCESSOR_WIDTHS[accessor.type],
    0,
  );
  requireThat(
    components <= DECODED_COMPONENTS,
    'GLB decoded component budget exceeded',
  );
  document.bufferViews.forEach((view, i) => {
    requireThat(
      (view.byteOffset ?? 0) + view.byteLength <=
        document.buffers[0].byteLength,
      `bufferView ${i} range`,
    );
  });
  return document.accessors.map((accessor, i) => {
    const view = document.bufferViews[accessor.bufferView];
    requireThat(view, `accessor ${i} bufferView index`);
    const width = ACCESSOR_WIDTHS[accessor.type];
    const componentBytes = accessor.componentType === 5123 ? 2 : 4;
    const offset = accessor.byteOffset ?? 0;
    const start = (view.byteOffset ?? 0) + offset;
    requireThat(
      start % componentBytes === 0 && offset % componentBytes === 0,
      `accessor ${i} alignment`,
    );
    requireThat(
      offset + accessor.count * width * componentBytes <= view.byteLength,
      `accessor ${i} range`,
    );
    const read =
      accessor.componentType === 5126
        ? 'readFloatLE'
        : accessor.componentType === 5123
          ? 'readUInt16LE'
          : 'readUInt32LE';
    const values = [];
    const min = Array(width).fill(Infinity);
    const max = Array(width).fill(-Infinity);
    for (let n = 0; n < accessor.count * width; n++) {
      const value = binary[read](start + n * componentBytes);
      requireThat(Number.isFinite(value), `accessor ${i} nonfinite value`);
      values.push(value);
      min[n % width] = Math.min(min[n % width], value);
      max[n % width] = Math.max(max[n % width], value);
    }
    requireThat(
      (accessor.min === undefined) === (accessor.max === undefined),
      `accessor ${i} bounds pair`,
    );
    if (accessor.min) {
      requireThat(
        sameVector(min, accessor.min) && sameVector(max, accessor.max),
        `accessor ${i} bounds mismatch`,
      );
    }
    return { ...accessor, values, min, max, width, target: view.target };
  });
}

function readMeshes(document, accessors) {
  return document.meshes.map((mesh) => {
    const bounds = new Box3();
    const surfaces = mesh.primitives.map((primitive) => {
      const position = accessors[primitive.attributes.POSITION];
      const normal = accessors[primitive.attributes.NORMAL];
      const indices = accessors[primitive.indices];
      requireThat(
        position && normal && indices && document.materials[primitive.material],
        'mesh accessor/material index',
      );
      requireThat(
        position.componentType === 5126 &&
          position.type === 'VEC3' &&
          normal.componentType === 5126 &&
          normal.type === 'VEC3' &&
          normal.count === position.count,
        'mesh position/normal profile',
      );
      requireThat(
        document.accessors[primitive.attributes.POSITION].min,
        'mesh position bounds missing',
      );
      requireThat(
        indices.type === 'SCALAR' &&
          [5123, 5125].includes(indices.componentType) &&
          indices.count % 3 === 0,
        'mesh triangle index profile',
      );
      requireThat(
        [position, normal].every(
          (a) => a.target === undefined || a.target === 34962,
        ) &&
          (indices.target === undefined || indices.target === 34963),
        'mesh bufferView target',
      );
      requireThat(
        indices.values.every((index) => index < position.count),
        'mesh vertex index out of range',
      );
      requireThat(
        new Set(indices.values).size === position.count,
        'mesh unreferenced vertex',
      );
      for (let i = 0; i < normal.values.length; i += 3) {
        requireThat(
          close(Math.hypot(...normal.values.slice(i, i + 3)), 1),
          'mesh normal is not unit length',
        );
      }
      bounds.expandByPoint(new Vector3(...position.min));
      bounds.expandByPoint(new Vector3(...position.max));
      return { position, indices };
    });
    return {
      surfaces,
      bounds,
      triangles: surfaces.reduce(
        (sum, surface) => sum + surface.indices.count / 3,
        0,
      ),
      primitives: mesh.primitives.length,
    };
  });
}

function validateAnimations(document, accessors, fish) {
  const animations = document.animations ?? [];
  requireThat(
    fish
      ? animations.length === 1 && animations[0].name === 'swim'
      : animations.length === 0,
    'Only the fish may have one mandatory swim animation',
  );
  for (const animation of animations) {
    const targets = new Set();
    const samplers = new Set();
    let duration;
    for (const channel of animation.channels) {
      const node = document.nodes[channel.target.node];
      requireThat(
        node &&
          ['fin-tail', 'fin-pectoral-left', 'fin-pectoral-right'].includes(
            node.name,
          ),
        'animation target must be a named animated fin',
      );
      requireThat(!targets.has(node.name), 'animation duplicate target');
      targets.add(node.name);
      const sampler = animation.samplers[channel.sampler];
      requireThat(sampler, 'animation sampler index');
      samplers.add(channel.sampler);
      const input = accessors[sampler.input];
      const output = accessors[sampler.output];
      requireThat(
        input &&
          output &&
          input.type === 'SCALAR' &&
          input.componentType === 5126 &&
          output.type === 'VEC4' &&
          output.componentType === 5126,
        'animation accessor profile',
      );
      requireThat(
        document.accessors[sampler.input].min &&
          document.accessors[sampler.input].max,
        'animation input bounds missing',
      );
      requireThat(
        input.count >= 2 && output.count === input.count,
        'animation input/output count mismatch',
      );
      requireThat(
        input.values[0] === 0 &&
          input.values.every(
            (value, i) => i === 0 || value > input.values[i - 1],
          ),
        'animation times must start at zero and strictly increase',
      );
      const end = input.values.at(-1);
      requireThat(
        duration === undefined || close(duration, end),
        'animation durations differ',
      );
      duration = end;
      for (let i = 0; i < output.values.length; i += 4) {
        requireThat(
          unitQuaternion(output.values.slice(i, i + 4)),
          'animation quaternion is not unit length',
        );
      }
      const reference = new Quaternion().fromArray(output.values).normalize();
      const sample = new Quaternion();
      const matchesReference = (offset) =>
        close(
          reference.angleTo(
            sample.fromArray(output.values, offset).normalize(),
          ),
          0,
        );
      requireThat(
        matchesReference(output.values.length - 4),
        'animation loop endpoints differ',
      );
      requireThat(
        output.values.some((_, i) => i % 4 === 0 && !matchesReference(i)),
        'animation fin is motionless',
      );
    }
    requireThat(
      targets.size === 3 && samplers.size === animation.samplers.length,
      'animation missing fin channel/unused sampler',
    );
  }
}

/** Validate only the documented original-v1 profile, not arbitrary glTF. */
export function validateGlb(input, asset, solids = []) {
  requireThat(ASSET_PATHS.includes(asset), 'Unknown original asset path');
  const bytes = Buffer.from(input);
  requireThat(
    bytes.length <= FILE_BYTES,
    `${asset} individual byte budget exceeded`,
  );
  const { document, binary } = decodeGlb(bytes);
  requireThat(
    document.scenes[0].extras.reefRush.asset === asset,
    'Scene asset identity mismatch',
  );
  const roots = document.scenes[0].nodes;
  requireThat(
    roots.length === document.nodes.length &&
      new Set(roots).size === roots.length &&
      roots.every((index) => index < document.nodes.length),
    'scene node membership must be exhaustive and unique',
  );
  const names = document.nodes.map((node) => node.name);
  requireThat(new Set(names).size === names.length, 'Duplicate node name');
  const accessors = readAccessors(document, binary);
  const meshes = readMeshes(document, accessors);
  const fish = asset === ASSET_PATHS[0];
  const course = asset.startsWith('courses/');
  const collision = asset === ASSET_PATHS[3];
  requireThat(document.nodes.length <= 256, 'mesh node budget exceeded');
  let triangles = 0;
  let drawCalls = 0;
  for (const node of document.nodes) {
    requireThat(meshes[node.mesh], 'node mesh index');
    triangles += meshes[node.mesh].triangles;
    drawCalls += meshes[node.mesh].primitives;
  }
  requireThat(triangles <= (fish ? 10000 : 100000), 'triangle budget exceeded');
  const mandatory = fish
    ? [
        'sunfin-body',
        'sunfin-eye-left',
        'sunfin-eye-right',
        'fin-tail',
        'fin-dorsal',
        'fin-anal',
        'fin-pectoral-left',
        'fin-pectoral-right',
      ]
    : course
      ? solids.map((solid) => solid.id)
      : ['limestone', 'coral-peach', 'coral-lavender', 'seagrass-jade'];
  for (const required of mandatory)
    requireThat(
      names.includes(required),
      `Missing mandatory ${course ? 'solid ' : ''}node ${required}`,
    );
  const expected = new Map(
    solids.map((solid) => [solid.id, colliderContract(solid)]),
  );
  requireThat(
    !course || (solids.length === 5 && expected.size === 5),
    'Sunlit requires exactly five authored solids',
  );
  const colliders = [];
  for (const node of document.nodes) {
    const extras = node.extras.reefRush;
    const rotation = node.rotation ?? [0, 0, 0, 1];
    const position = node.translation ?? [0, 0, 0];
    const scale = node.scale ?? [1, 1, 1];
    requireThat(
      unitQuaternion(rotation),
      'node rotation is not a unit quaternion',
    );
    const mesh = meshes[node.mesh];
    if (extras.role === 'static-solid') {
      requireThat(
        course &&
          node.name === extras.id &&
          isDeepStrictEqual(extras, expected.get(extras.id)) &&
          !colliders.some((collider) => collider.id === extras.id),
        `solid ${node.name} metadata/source mismatch`,
      );
      requireThat(
        sameVector(position, extras.transform.position) &&
          sameVector(rotation, extras.transform.rotation) &&
          sameVector(scale, extras.transform.scale),
        `solid ${node.name} node transform mismatch`,
      );
      validateSolidSurface(mesh, extras);
      colliders.push(extras);
    } else {
      requireThat(
        !collision && extras.role === (fish ? 'fish-part' : 'decoration'),
        'Unexpected noncolliding node role',
      );
      if (course) {
        const matrix = new Matrix4().compose(
          new Vector3(...position),
          new Quaternion(...rotation),
          new Vector3(...scale),
        );
        const bounds = mesh.bounds.clone().applyMatrix4(matrix);
        requireThat(
          node.name.startsWith('decor-') &&
            (bounds.max.x < -9 || bounds.min.x > 9 || bounds.max.y <= -7.5),
          'Decoration must stay outside the route/spawn ribbon',
        );
      }
    }
  }
  requireThat(
    !course || colliders.length === expected.size,
    'Missing static solid contract',
  );
  validateAnimations(document, accessors, fish);
  return {
    asset,
    bytes: bytes.length,
    triangles,
    meshNodes: document.nodes.length,
    meshes: meshes.length,
    materials: document.materials.length,
    drawCalls,
    colliders,
  };
}

export async function validateAssetSet(assetRoot, sourceFile) {
  const source = JSON.parse(await readFile(sourceFile, 'utf8'));
  requireThat(
    source.version === 1 &&
      source.seed === 9042026 &&
      Array.isArray(source.solids),
    'Invalid original source version/seed/solids',
  );
  const sizes = await Promise.all(
    ASSET_PATHS.map(async (asset) => {
      const size = (await stat(resolve(assetRoot, asset))).size;
      requireThat(
        size <= FILE_BYTES,
        `${asset} individual byte budget exceeded`,
      );
      return size;
    }),
  );
  requireThat(
    sizes.reduce((sum, size) => sum + size, 0) <= SET_BYTES,
    'Combined byte budget exceeded',
  );
  return Promise.all(
    ASSET_PATHS.map(async (asset) =>
      validateGlb(
        await readFile(resolve(assetRoot, asset)),
        asset,
        source.solids,
      ),
    ),
  );
}

export async function validateProject(
  projectRoot,
  assetRoot = resolve(projectRoot, 'public', 'assets'),
) {
  await Promise.all(
    ['LICENSE', 'ASSET-LICENSE.md'].map((file) =>
      access(resolve(projectRoot, file)),
    ),
  );
  return validateAssetSet(
    assetRoot,
    resolve(projectRoot, 'assets', 'source', 'sunlit-assets.json'),
  );
}
