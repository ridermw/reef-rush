// @vitest-environment node
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Box3, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sunlit from '../../src/content/courses/sunlitShoals';
import {
  colliderContract,
  validateGlb,
  validateProject,
} from '../../tools/asset-profile.mjs';

const paths = [
  'fish/sunfin.glb',
  'props/reef-kit.glb',
  'courses/sunlit-shoals.visual.glb',
  'courses/sunlit-shoals.collision.glb',
] as const;
const assetRoot = resolve('public', 'assets');
const solids = sunlit.objects.filter(
  (object) => object.type === 'box' || object.type === 'sphere',
);

async function loadAsset(path: string) {
  const file = resolve(assetRoot, path);
  expect(existsSync(file), `Missing original output: ${path}`).toBe(true);
  const bytes = await readFile(file);
  return new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    '',
  );
}

function expectVector(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) =>
    expect(value).toBeCloseTo(expected[index], 5),
  );
}

describe('original asset source and output contract', () => {
  it('keeps portable source solids identical to live Sunlit, not a stale second course', async () => {
    expect(existsSync('assets/source/sunlit-assets.json')).toBe(true);
    const source = JSON.parse(
      await readFile('assets/source/sunlit-assets.json', 'utf8'),
    ) as { solids: unknown; seed: number };
    expect(source.solids).toEqual(solids);
    expect(source.seed).toBe(9042026);
  });

  it('provides a portable generation command', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['assets:generate']).toBe(
      'node tools/generate-assets.mjs',
    );
    expect(existsSync('tools/generate-assets.mjs')).toBe(true);
  });

  it.each(paths)('loads self-contained lit artwork: %s', async (path) => {
    const { scene } = await loadAsset(path);
    expect(scene.userData.reefRush).toMatchObject({
      profile: 'reef-rush-original-v1',
      asset: path,
      up: '+Y',
      forward: '+Z',
      metersPerUnit: 1,
    });
    let meshes = 0;
    scene.traverse((node) => {
      expect(node.type).not.toMatch(/Camera|Light/);
      if (!(node instanceof Mesh)) return;
      meshes++;
      const materials = Array.isArray(node.material)
        ? node.material
        : [node.material];
      materials.forEach((material) => {
        expect(material).toBeInstanceOf(MeshStandardMaterial);
        expect((material as MeshStandardMaterial).map).toBeNull();
      });
    });
    expect(meshes).toBeGreaterThan(0);
  });
});

// A mutation fixture shape, deliberately allowing fields the production profile
// rejects. Mutations are serialized back into real GLBs, not mocked parser calls.
interface Fixture {
  buffers: { byteLength: number; uri?: string }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number }[];
  accessors: {
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }[];
  nodes: {
    name: string;
    mesh: number;
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    extras: { reefRush: Record<string, unknown> };
  }[];
  meshes: {
    primitives: {
      attributes: { POSITION: number; NORMAL: number };
      indices: number;
      material: number;
    }[];
  }[];
  scenes: { nodes: number[] }[];
  animations: {
    name: string;
    channels: { sampler: number; target: { node: number; path: string } }[];
    samplers: { input: number; output: number; interpolation: string }[];
  }[];
}

function unpack(bytes: Buffer): { document: Fixture; binary: Buffer } {
  const jsonLength = bytes.readUInt32LE(12);
  return {
    document: JSON.parse(
      bytes.subarray(20, 20 + jsonLength).toString(),
    ) as Fixture,
    binary: Buffer.from(bytes.subarray(28 + jsonLength)),
  };
}

function pack(document: Fixture, binary: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(document));
  const paddedJson = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(paddedJson);
  const bin = Buffer.alloc(Math.ceil(binary.length / 4) * 4);
  binary.copy(bin);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + paddedJson.length + bin.length, 8);
  header.writeUInt32LE(paddedJson.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, paddedJson, binHeader, bin]);
}

function offset(document: Fixture, accessorIndex: number) {
  const accessor = document.accessors[accessorIndex];
  return (
    (document.bufferViews[accessor.bufferView].byteOffset ?? 0) +
    (accessor.byteOffset ?? 0)
  );
}

const ownedDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    ownedDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function fixtureDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'reef-rush-9a-'));
  ownedDirectories.push(root);
  await Promise.all(
    paths.map(async (path) => {
      await mkdir(dirname(resolve(root, path)), { recursive: true });
      await copyFile(resolve(assetRoot, path), resolve(root, path));
    }),
  );
  return root;
}

function validateCommand(root: string) {
  const result = spawnSync(
    process.execPath,
    ['tools/validate-assets.mjs', '--asset-root', root],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
    },
  );
  if (result.error) throw result.error;
  return result;
}

type Mutation = {
  name: string;
  asset?: (typeof paths)[number];
  error: RegExp;
  edit: (document: Fixture, binary: Buffer) => void;
};

const mutations: Mutation[] = [
  {
    name: 'external buffer',
    error: /profile/i,
    edit: (d) => {
      d.buffers[0].uri = 'https://invalid.example/mesh.bin';
    },
  },
  {
    name: 'external image',
    error: /profile/i,
    edit: (d) => {
      Object.assign(d, { images: [{ uri: 'texture.png' }] });
    },
  },
  {
    name: 'decoder extension',
    error: /profile/i,
    edit: (d) => {
      Object.assign(d, { extensionsRequired: ['KHR_draco_mesh_compression'] });
    },
  },
  {
    name: 'sparse accessor',
    error: /profile/i,
    edit: (d) => {
      Object.assign(d.accessors[0], { sparse: { count: 1 } });
    },
  },
  {
    name: 'node matrix',
    error: /profile/i,
    edit: (d) => {
      Object.assign(d.nodes[0], { matrix: new Array<number>(16).fill(0) });
    },
  },
  {
    name: 'hierarchy/cycle',
    error: /profile/i,
    edit: (d) => {
      Object.assign(d.nodes[0], { children: [0] });
    },
  },
  {
    name: 'nonfinite geometry',
    error: /finite/i,
    edit: (d, b) => {
      b.writeFloatLE(Infinity, offset(d, 0));
    },
  },
  {
    name: 'NaN normal',
    error: /finite/i,
    edit: (d, b) => {
      b.writeFloatLE(NaN, offset(d, 1));
    },
  },
  {
    name: 'accessor range overflow',
    error: /accessor.*range/i,
    edit: (d) => {
      d.accessors[0].byteOffset =
        d.bufferViews[d.accessors[0].bufferView].byteLength;
    },
  },
  {
    name: 'accessor misalignment',
    error: /align/i,
    edit: (d) => {
      d.accessors[0].byteOffset = 1;
    },
  },
  {
    name: 'buffer view range overflow',
    error: /bufferView.*range/i,
    edit: (d) => {
      d.bufferViews[0].byteOffset = 999999;
    },
  },
  {
    name: 'invalid vertex index',
    error: /index/i,
    edit: (d, b) => {
      b.writeUInt16LE(65535, offset(d, d.meshes[0].primitives[0].indices));
    },
  },
  {
    name: 'false accessor bounds',
    error: /bounds/i,
    edit: (d) => {
      d.accessors[0].max![0] += 1;
    },
  },
  {
    name: 'missing fin name',
    error: /mandatory.*fin-tail/i,
    edit: (d) => {
      d.nodes.find((n) => n.name === 'fin-tail')!.name = 'tail';
    },
  },
  {
    name: 'missing swim',
    error: /swim/i,
    edit: (d) => {
      d.animations = [];
    },
  },
  {
    name: 'invalid animation target',
    error: /animation.*target/i,
    edit: (d) => {
      d.animations[0].channels[0].target.node = 999;
    },
  },
  {
    name: 'invalid animation sampler',
    error: /animation.*sampler/i,
    edit: (d) => {
      d.animations[0].channels[0].sampler = 999;
    },
  },
  {
    name: 'nonmonotonic animation times',
    error: /animation.*time/i,
    edit: (d, b) => {
      const a = d.animations[0].samplers[0].input;
      b.writeFloatLE(b.readFloatLE(offset(d, a)), offset(d, a) + 4);
    },
  },
  {
    name: 'animation input without declared bounds',
    error: /animation.*bounds/i,
    edit: (d) => {
      const input = d.accessors[d.animations[0].samplers[0].input];
      delete input.min;
      delete input.max;
    },
  },
  {
    name: 'quaternion sign flips without actual animation',
    error: /animation.*motionless/i,
    edit: (d, b) => {
      for (const sampler of d.animations[0].samplers) {
        const output = d.accessors[sampler.output];
        delete output.min;
        delete output.max;
        for (let key = 0; key < output.count; key++) {
          const start = offset(d, sampler.output) + key * 16;
          for (let axis = 0; axis < 3; axis++)
            b.writeFloatLE(0, start + axis * 4);
          b.writeFloatLE(
            key % 2 === 0 || key === output.count - 1 ? 1 : -1,
            start + 12,
          );
        }
      }
    },
  },
  {
    name: 'animation count mismatch',
    error: /animation.*count/i,
    edit: (d) => {
      d.accessors[d.animations[0].samplers[0].output].count--;
    },
  },
  {
    name: 'nonunit animation rotation',
    error: /animation.*quaternion/i,
    edit: (d, b) => {
      b.writeFloatLE(3, offset(d, d.animations[0].samplers[0].output));
    },
  },
  {
    name: 'nonlooping swim',
    error: /animation.*loop/i,
    edit: (d, b) => {
      const a = d.animations[0].samplers[0].output;
      const end = offset(d, a) + (d.accessors[a].count - 1) * 16;
      b.writeFloatLE(Math.sin(0.2), end);
      b.writeFloatLE(Math.cos(0.2), end + 12);
    },
  },
  {
    name: 'orphaned node',
    error: /scene.*node/i,
    edit: (d) => {
      d.scenes[0].nodes.pop();
    },
  },
  {
    name: 'duplicate scene node',
    error: /scene.*node/i,
    edit: (d) => {
      d.scenes[0].nodes.push(0);
    },
  },
  {
    name: 'colliding decoration',
    asset: paths[1],
    error: /profile/i,
    edit: (d) => {
      d.nodes[0].extras.reefRush.collides = true;
    },
  },
  {
    name: 'missing proxy',
    asset: paths[3],
    error: /solid/i,
    edit: (d) => {
      d.nodes.pop();
      d.scenes[0].nodes.pop();
    },
  },
  {
    name: 'duplicate proxy ID',
    asset: paths[3],
    error: /solid/i,
    edit: (d) => {
      d.nodes[1].extras.reefRush.id = 'sand-bed';
    },
  },
  {
    name: 'proxy category mismatch',
    asset: paths[3],
    error: /solid/i,
    edit: (d) => {
      d.nodes[0].extras.reefRush.category = 'hazard';
    },
  },
  {
    name: 'proxy dimensions mismatch',
    asset: paths[3],
    error: /solid/i,
    edit: (d) => {
      d.nodes[0].extras.reefRush.primitive = {
        type: 'box',
        halfExtents: [22, 3, 60],
      };
    },
  },
  {
    name: 'proxy metadata transform mismatch',
    asset: paths[3],
    error: /solid/i,
    edit: (d) => {
      d.nodes[0].extras.reefRush.transform = {
        position: [1, -10, 45],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      };
    },
  },
  {
    name: 'proxy node translation mismatch',
    asset: paths[3],
    error: /solid.*transform/i,
    edit: (d) => {
      d.nodes[0].translation![0] = 1;
    },
  },
  {
    name: 'proxy node scale mismatch',
    asset: paths[3],
    error: /solid.*transform/i,
    edit: (d) => {
      d.nodes[0].scale = [2, 1, 1];
    },
  },
  {
    name: 'proxy node rotation mismatch',
    asset: paths[3],
    error: /solid.*transform/i,
    edit: (d) => {
      d.nodes[0].rotation = [0, 1, 0, 0];
    },
  },
  {
    name: 'proxy sphere geometry mismatch despite unchanged bounds',
    asset: paths[3],
    error: /solid.*surface/i,
    edit: (d, b) => {
      const a = d.meshes[2].primitives[0].attributes.POSITION;
      const start = offset(d, a) + 12;
      for (let i = 0; i < 3; i++)
        b.writeFloatLE(b.readFloatLE(start + i * 4) * 0.9, start + i * 4);
    },
  },
  {
    name: 'sphere vertex permutation with inward triangles',
    asset: paths[3],
    error: /solid.*surface/i,
    edit: (d, b) => {
      const start = offset(d, d.meshes[2].primitives[0].attributes.POSITION);
      for (let axis = 0; axis < 3; axis++) {
        const a = start + 1 * 12 + axis * 4;
        const c = start + 133 * 12 + axis * 4;
        const value = b.readFloatLE(a);
        b.writeFloatLE(b.readFloatLE(c), a);
        b.writeFloatLE(value, c);
      }
    },
  },
  {
    name: 'reversed box surface triangle',
    asset: paths[3],
    error: /solid.*surface/i,
    edit: (d, b) => {
      const index = d.meshes[0].primitives[0].indices;
      const start = offset(d, index);
      const width = d.accessors[index].componentType === 5123 ? 2 : 4;
      const read = width === 2 ? 'readUInt16LE' : 'readUInt32LE';
      const write = width === 2 ? 'writeUInt16LE' : 'writeUInt32LE';
      const value = b[read](start);
      b[write](b[read](start + width), start);
      b[write](value, start + width);
    },
  },
  {
    name: 'course node budget',
    asset: paths[2],
    error: /mesh node budget/i,
    edit: (d) => {
      while (d.nodes.length <= 256) {
        const node = structuredClone(
          d.nodes.find((n) => n.name.startsWith('decor-'))!,
        );
        node.name = `decor-budget-${d.nodes.length}`;
        d.scenes[0].nodes.push(d.nodes.length);
        d.nodes.push(node);
      }
    },
  },
  ...([paths[0], paths[2]] as const).map((asset): Mutation => ({
    name: `${asset} triangle budget`,
    asset,
    error: /triangle budget/i,
    edit: (d) => {
      const node = d.nodes.reduce((best, n) => {
        const count = (m: number) =>
          d.meshes[m].primitives.reduce(
            (total, p) => total + d.accessors[p.indices].count,
            0,
          );
        return count(n.mesh) > count(best.mesh) ? n : best;
      });
      const target = asset === paths[0] ? 10001 : 100001;
      let triangles = 0;
      while (triangles < target) {
        const copy = structuredClone(node);
        copy.name = `budget-${d.nodes.length}`;
        d.scenes[0].nodes.push(d.nodes.length);
        d.nodes.push(copy);
        triangles += d.meshes[node.mesh].primitives.reduce(
          (t, p) => t + d.accessors[p.indices].count / 3,
          0,
        );
      }
    },
  })),
];

describe('bounded original GLB validator rejection', () => {
  it('enforces a decoded component budget before reading aliased accessors', async () => {
    const { document, binary } = unpack(
      await readFile(resolve(assetRoot, paths[0])),
    );
    const position =
      document.accessors[document.meshes[0].primitives[0].attributes.POSITION];
    while (document.accessors.length < 4096) {
      document.accessors.push(structuredClone(position));
    }
    const bytes = pack(document, binary);
    expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
    const decoding = vi
      .spyOn(Buffer.prototype, 'readFloatLE')
      .mockImplementation(() => {
        throw new Error('Accessor decoding must not start');
      });
    try {
      expect(() => validateGlb(bytes, paths[0], solids)).toThrow(
        /decoded component budget/i,
      );
      expect(decoding).not.toHaveBeenCalled();
    } finally {
      decoding.mockRestore();
    }
  });

  it('accepts the complete original set', () => {
    const result = validateCommand(assetRoot);
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a missing required output', async () => {
    const root = await fixtureDirectory();
    await rm(resolve(root, paths[0]));
    const result = validateCommand(root);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toMatch(/sunfin\.glb/);
  });

  it.each(mutations)(
    'rejects $name',
    async ({ asset = paths[0], edit, error }) => {
      const root = await fixtureDirectory();
      const file = resolve(root, asset);
      const { document, binary } = unpack(await readFile(file));
      edit(document, binary);
      await writeFile(file, pack(document, binary));
      const result = validateCommand(root);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toMatch(error);
    },
  );

  it.each([
    'magic',
    'version',
    'total length',
    'chunk length',
    'chunk alignment',
    'chunk type',
    'truncation',
  ])('rejects broken GLB %s', async (kind) => {
    const root = await fixtureDirectory();
    const file = resolve(root, paths[0]);
    let bytes = await readFile(file);
    if (kind === 'magic') bytes.writeUInt32LE(0, 0);
    if (kind === 'version') bytes.writeUInt32LE(1, 4);
    if (kind === 'total length') bytes.writeUInt32LE(bytes.length + 4, 8);
    if (kind === 'chunk length') bytes.writeUInt32LE(bytes.length + 4, 12);
    if (kind === 'chunk alignment')
      bytes.writeUInt32LE(bytes.readUInt32LE(12) - 1, 12);
    if (kind === 'chunk type') bytes.writeUInt32LE(0, 16);
    if (kind === 'truncation') bytes = bytes.subarray(0, -4);
    await writeFile(file, bytes);
    const result = validateCommand(root);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toMatch(/GLB/i);
  });

  it.each(['individual', 'combined'])(
    'enforces %s byte budgets',
    async (kind) => {
      const root = await fixtureDirectory();
      for (const path of kind === 'individual' ? [paths[0]] : paths) {
        const file = resolve(root, path);
        const { document, binary } = unpack(await readFile(file));
        const padded = Buffer.alloc(
          kind === 'individual' ? 2 * 1024 * 1024 : 1400 * 1024,
        );
        binary.copy(padded);
        document.buffers[0].byteLength = padded.length;
        await writeFile(file, pack(document, padded));
      }
      const result = validateCommand(root);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toMatch(/byte budget/i);
    },
  );
});

describe('original fish and course geometry', () => {
  it('accepts loop endpoints representing the same orientation with opposite quaternion signs', async () => {
    const { document, binary } = unpack(
      await readFile(resolve(assetRoot, paths[0])),
    );
    for (const sampler of document.animations[0].samplers) {
      const output = document.accessors[sampler.output];
      delete output.min;
      delete output.max;
      const start = offset(document, sampler.output);
      const end = start + (output.count - 1) * 16;
      for (let axis = 0; axis < 4; axis++) {
        binary.writeFloatLE(
          -binary.readFloatLE(start + axis * 4),
          end + axis * 4,
        );
      }
    }
    expect(() =>
      validateGlb(pack(document, binary), paths[0], solids),
    ).not.toThrow();
  });

  it('keeps fish small, slender, +Z facing, with independently animated fins', async () => {
    const { scene, animations } = await loadAsset(paths[0]);
    const body = scene.getObjectByName('sunfin-body');
    expect(body).toBeDefined();
    const size = new Box3().setFromObject(body!).getSize(new Vector3());
    expect(size.z).toBeGreaterThan(size.x * 3);
    expect(size.z).toBeGreaterThan(size.y * 2);
    const fishSize = new Box3().setFromObject(scene).getSize(new Vector3());
    expect(fishSize.z).toBeLessThan(3);
    for (const side of ['left', 'right']) {
      const eye = scene.getObjectByName(`sunfin-eye-${side}`);
      expect(eye).toBeDefined();
      expect(eye!.getWorldPosition(new Vector3()).z).toBeGreaterThan(0.4);
    }
    for (const name of [
      'fin-tail',
      'fin-dorsal',
      'fin-pectoral-left',
      'fin-pectoral-right',
      'fin-anal',
    ]) {
      expect(scene.getObjectByName(name)).toBeDefined();
    }
    expect(scene.getObjectByName('fin-tail')!.position.z).toBeLessThan(-0.6);
    const swim = animations.find((clip) => clip.name === 'swim');
    expect(swim).toBeDefined();
    expect(swim!.duration).toBeGreaterThan(0);
    expect(swim!.tracks.length).toBeGreaterThanOrEqual(3);
    swim!.tracks.forEach((track) => {
      expect(track.times[0]).toBe(0);
      expect(track.name).toMatch(/^fin-.*\.quaternion$/);
      const width = track.getValueSize();
      expectVector(
        Array.from(track.values.slice(0, width)),
        Array.from(track.values.slice(-width)),
      );
      expect(new Set(track.values).size).toBeGreaterThan(2);
    });
  });

  it.each(paths.slice(2))(
    'matches all live authored static solids: %s',
    async (path) => {
      const { scene } = await loadAsset(path);
      const found: string[] = [];
      scene.traverse((node) => {
        const extras: unknown = node.userData.reefRush;
        if (!extras || !(node instanceof Mesh)) return;
        const object = solids.find((solid) => solid.id === node.name);
        if (!object) {
          expect(extras).toMatchObject({
            version: 1,
            role: 'decoration',
            collides: false,
          });
          expect(path).not.toBe(paths[3]);
          return;
        }
        found.push(object.id);
        const rotation = object.type === 'box' ? object.rotation : [0, 0, 0, 1];
        expect(extras).toEqual({
          version: 1,
          role: 'static-solid',
          id: object.id,
          category: object.collision,
          primitive:
            object.type === 'box'
              ? { type: 'box', halfExtents: object.halfExtents }
              : { type: 'sphere', radius: object.radius },
          transform: { position: object.position, rotation, scale: [1, 1, 1] },
        });
        expectVector(node.position.toArray(), object.position);
        expectVector(node.quaternion.toArray(), rotation);
        expectVector(node.scale.toArray(), [1, 1, 1]);
        const half =
          object.type === 'box'
            ? object.halfExtents
            : [object.radius, object.radius, object.radius];
        const bounds = new Box3().setFromObject(node);
        expectVector(
          bounds.min.toArray(),
          object.position.map((v, i) => v - half[i]),
        );
        expectVector(
          bounds.max.toArray(),
          object.position.map((v, i) => v + half[i]),
        );
      });
      expect(found.sort()).toEqual(solids.map((object) => object.id).sort());
      for (const name of [
        'warm-current',
        'sway-beam',
        ...sunlit.checkpoints.map((checkpoint) => checkpoint.id),
        ...sunlit.pearls.map((pearl) => pearl.id),
      ]) {
        expect(scene.getObjectByName(name)).toBeUndefined();
      }
    },
  );

  it('places only explicitly noncolliding decoration outside the route and spawn corridor', async () => {
    const { scene } = await loadAsset(paths[2]);
    let decorations = 0;
    scene.traverse((node) => {
      if (
        !(node instanceof Mesh) ||
        solids.some((solid) => solid.id === node.name)
      )
        return;
      expect(node.userData.reefRush).toEqual({
        version: 1,
        role: 'decoration',
        collides: false,
      });
      decorations++;
      const bounds = new Box3().setFromObject(node);
      // Entire authored route, checkpoint radii and spawn fit inside this open ribbon.
      expect(
        bounds.max.x < -9 || bounds.min.x > 9 || bounds.max.y <= -7.5,
      ).toBe(true);
    });
    expect(decorations).toBeGreaterThan(10);
  });

  it('contains the reusable original reef prop families', async () => {
    const { scene } = await loadAsset(paths[1]);
    for (const name of [
      'limestone',
      'coral-peach',
      'coral-lavender',
      'seagrass-jade',
    ]) {
      expect(scene.getObjectByName(name)).toBeDefined();
    }
  });
});

describe('reusable contract API and tooling errors', () => {
  it.each(paths.slice(2))(
    'validates against the live typed course: %s',
    async (asset) => {
      const report = validateGlb(
        await readFile(resolve(assetRoot, asset)),
        asset,
        solids,
      );
      expect(report.colliders).toEqual(solids.map(colliderContract));
      expect(report.meshNodes).toBeLessThanOrEqual(256);
      expect(report.triangles).toBeLessThanOrEqual(100000);
    },
  );

  it('rejects source drift relative to the live typed course', async () => {
    const bytes = await readFile(resolve(assetRoot, paths[3]));
    const drifted = solids.map((solid) =>
      solid.id === 'west-ledge'
        ? { ...solid, position: [-12, -6, 24] as const }
        : solid,
    );
    expect(() => validateGlb(bytes, paths[3], drifted)).toThrow(
      /solid.*metadata/,
    );
  });

  it('rejects duplicate expected source solids rather than silently deduplicating', async () => {
    const bytes = await readFile(resolve(assetRoot, paths[3]));
    expect(() => validateGlb(bytes, paths[3], [...solids, solids[0]])).toThrow(
      /five authored solids/,
    );
  });

  it.each(['LICENSE', 'ASSET-LICENSE.md'])(
    'retains the required %s check',
    async (missing) => {
      const root = await fixtureDirectory();
      const present = missing === 'LICENSE' ? 'ASSET-LICENSE.md' : 'LICENSE';
      await copyFile(resolve(present), resolve(root, present));
      await expect(validateProject(root, assetRoot)).rejects.toThrow(missing);
    },
  );

  it('surfaces unavailable Blender errors without pretending generation succeeded', async () => {
    const root = await fixtureDirectory();
    const result = spawnSync(
      process.execPath,
      [
        'tools/generate-assets.mjs',
        '--blender',
        resolve(root, 'missing-blender'),
        '--output-root',
        resolve(root, 'generated'),
      ],
      { cwd: resolve('.'), encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ENOENT/);
    expect(existsSync(resolve(root, 'generated'))).toBe(false);
  });
});
