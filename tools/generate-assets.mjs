import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { courseSourcePaths, validateAssetSet } from './asset-profile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: {
    blender: { type: 'string', default: process.env.BLENDER ?? 'blender' },
    'output-root': {
      type: 'string',
      default: resolve(root, 'public', 'assets'),
    },
  },
});
const outputRoot = resolve(values['output-root']);
const result = spawnSync(
  values.blender,
  [
    '--background',
    '--factory-startup',
    '--python-exit-code',
    '1',
    '--python',
    resolve(root, 'assets', 'source', 'build_assets.py'),
    '--',
    '--output-root',
    outputRoot,
  ],
  { stdio: 'inherit', shell: false },
);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(`Blender failed: ${result.signal ?? result.status}`);
const reports = await validateAssetSet(outputRoot, courseSourcePaths(root));
console.log(
  `Generated and validated ${reports.length} original assets in ${outputRoot}`,
);
