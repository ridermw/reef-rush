import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const commit = '0123456789abcdef0123456789abcdef01234567';
const utility = new URL('../../tools/write-build-info.mjs', import.meta.url);
const load = () => import(utility.href);
async function output(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reef-build-info-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('hashes exact HTML bytes and writes only deterministic artifact identity', async (t) => {
  const { writeBuildInfo } = await load();
  const dir = await output(t);
  const html = Buffer.from([60, 33, 62, 13, 10, 0, 255]);
  await writeFile(join(dir, 'index.html'), html);
  const expected = {
    version: 1,
    commit,
    indexSha256: createHash('sha256').update(html).digest('hex'),
  };
  assert.deepEqual(await writeBuildInfo(commit, dir), expected);
  const first = await readFile(join(dir, 'build-info.json'));
  assert.equal(first.toString(), `${JSON.stringify(expected)}\n`);
  await writeBuildInfo(commit, dir);
  assert.deepEqual(await readFile(join(dir, 'build-info.json')), first);
});

for (const value of [
  undefined,
  '',
  'a'.repeat(39),
  'a'.repeat(41),
  'A'.repeat(40),
  'g'.repeat(40),
]) {
  test(`rejects invalid commit ${JSON.stringify(value)} before reading output`, async () => {
    const { writeBuildInfo } = await load();
    await assert.rejects(
      writeBuildInfo(value, 'absent'),
      /40 lowercase hexadecimal/,
    );
  });
}

test('requires an explicit output directory', async () => {
  const { writeBuildInfo } = await load();
  for (const dir of [undefined, '', ' '])
    await assert.rejects(writeBuildInfo(commit, dir), /output directory/);
});

test('propagates missing HTML', async (t) => {
  const { writeBuildInfo } = await load();
  await assert.rejects(writeBuildInfo(commit, await output(t)), {
    code: 'ENOENT',
  });
});

test('propagates HTML read failure', async (t) => {
  const { writeBuildInfo } = await load();
  const dir = await output(t);
  await mkdir(join(dir, 'index.html'));
  await assert.rejects(writeBuildInfo(commit, dir), /EISDIR|EPERM|EACCES/);
});

test('propagates metadata write failure', async (t) => {
  const { writeBuildInfo } = await load();
  const dir = await output(t);
  await writeFile(join(dir, 'index.html'), '<html>');
  await mkdir(join(dir, 'build-info.json'));
  await assert.rejects(writeBuildInfo(commit, dir), /EISDIR|EPERM|EACCES/);
});

test('import does not execute the CLI', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(utility.href)})`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
});

test('CLI requires exactly explicit commit and output arguments', async (t) => {
  await load();
  const dir = await output(t);
  await writeFile(join(dir, 'index.html'), '<html>');
  for (const args of [[], [commit], [commit, dir, 'extra'], ['bad', dir]]) {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(utility), ...args],
      { encoding: 'utf8' },
    );
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Usage:|40 lowercase hexadecimal/);
  }
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(utility), commit, dir],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    JSON.parse(await readFile(join(dir, 'build-info.json'), 'utf8')).commit,
    commit,
  );
});
