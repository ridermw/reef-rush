import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function writeBuildInfo(commit, outputDirectory) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error(
      'Source commit must be exactly 40 lowercase hexadecimal characters',
    );
  if (typeof outputDirectory !== 'string' || outputDirectory.trim() === '')
    throw new Error('An explicit output directory is required');
  const html = await readFile(join(outputDirectory, 'index.html'));
  const info = {
    version: 1,
    commit,
    indexSha256: createHash('sha256').update(html).digest('hex'),
  };
  await writeFile(
    join(outputDirectory, 'build-info.json'),
    `${JSON.stringify(info)}\n`,
  );
  return info;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.length !== 4)
    throw new Error(
      'Usage: node tools/write-build-info.mjs <commit> <output-directory>',
    );
  await writeBuildInfo(process.argv[2], process.argv[3]);
}
