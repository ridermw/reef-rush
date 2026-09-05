import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from './asset-profile.mjs';

const { values } = parseArgs({ options: { 'asset-root': { type: 'string' } } });
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const reports = await validateProject(
  projectRoot,
  values['asset-root'] ? resolve(values['asset-root']) : undefined,
);
console.table(
  reports.map(({ colliders, ...report }) => ({
    ...report,
    solids: colliders.length,
  })),
);
console.log(
  `Validated LICENSE, ASSET-LICENSE.md and ${reports.length} original GLBs (${reports.reduce((sum, report) => sum + report.bytes, 0)} bytes).`,
);
