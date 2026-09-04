import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const lockfile = JSON.parse(
  await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'),
);

for (const [alias, packageName, version] of [
  ['string-width-cjs', 'string-width', '4.2.3'],
  ['strip-ansi-cjs', 'strip-ansi', '6.0.1'],
  ['wrap-ansi-cjs', 'wrap-ansi', '7.0.0'],
]) {
  test(`${alias} resolves the original package's public tarball`, () => {
    const entry = lockfile.packages[`node_modules/${alias}`];

    assert.equal(entry.name, packageName);
    assert.equal(entry.version, version);
    assert.equal(
      entry.resolved,
      `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`,
    );
    assert.match(entry.integrity, /^sha512-/);
  });
}
