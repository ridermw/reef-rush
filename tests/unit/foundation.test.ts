import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('brands the production entry point as Reef Rush', async () => {
  const html = await readFile(resolve(process.cwd(), 'index.html'), 'utf8');
  expect(html).toContain('<title>Reef Rush</title>');
});
