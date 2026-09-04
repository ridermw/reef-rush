import { access } from 'node:fs/promises';

const required = ['LICENSE', 'ASSET-LICENSE.md'];

await Promise.all(required.map((path) => access(path)));
console.log(`Validated ${required.length} required project files.`);
