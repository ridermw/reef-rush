import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const readProjectFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const workflow = (
  await readProjectFile('.github/workflows/windows-baseline.yml')
).replaceAll('\r\n', '\n');
const manifest = JSON.parse(await readProjectFile('package.json'));
const config = await readProjectFile('playwright.config.ts');
const runtime = (await readProjectFile('.nvmrc')).trim();
const steps = workflow.split(/^      - name: /m).slice(1);
const step = (name) => {
  const matches = steps.filter((value) => value.startsWith(`${name}\n`));
  assert.equal(matches.length, 1, `Expected exactly one "${name}" step`);
  return matches[0];
};
const artifactRoot =
  '${{ runner.temp }}\\reef-rush-browser-${{ github.run_id }}-${{ github.run_attempt }}';

// These are declaration checks for this workflow, not a general YAML parser.
test('automatic main pushes exclude only the checkpoint; PR and manual gates are unfiltered', () => {
  assert.match(
    workflow,
    /^on:\n  push:\n    branches: \[main\]\n    paths-ignore:\n      - docs\/handoffs\/2026-09-04-reef-rush\.md\n  pull_request:\n  workflow_dispatch:\n/m,
  );
  assert.equal((workflow.match(/paths-ignore:/g) ?? []).length, 1);
});

test('one Windows job remains read-only and does not expose credentials or deployment', () => {
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.match(workflow, /^jobs:\n  baseline:\n    runs-on: windows-2022\n/m);
  assert.equal((workflow.match(/^    runs-on:/gm) ?? []).length, 1);
  assert.equal((workflow.match(/^permissions:/gm) ?? []).length, 1);
  assert.doesNotMatch(
    workflow,
    /pull_request_target|secrets[.[]|:\s*write\b|deploy-pages|upload-pages-artifact|continue-on-error|^[ \t]+permissions:/m,
  );
  assert.match(
    step('Check out the requested revision'),
    /persist-credentials: false/,
  );
});

test('all action uses have the reviewed immutable Node24 release pins', () => {
  const uses = [...workflow.matchAll(/^\s+uses: ([^\s]+) # ([^\n]+)$/gm)].map(
    ([, action, release]) => [action, release],
  );
  assert.deepEqual(uses, [
    ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'v7.0.1'],
    ['actions/setup-node@820762786026740c76f36085b0efc47a31fe5020', 'v7.0.0'],
    [
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'v7.0.1',
    ],
    [
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'v7.0.1',
    ],
  ]);
  assert.equal((workflow.match(/^\s+uses:/gm) ?? []).length, uses.length);
});

test('the project runtime comes from nvmrc without automatic package cache or weaker restore', () => {
  assert.equal(runtime, '24.20.0');
  assert.equal(manifest.engines.node, runtime);
  const setup = step('Select the pinned Node runtime');
  assert.match(setup, /node-version-file: \.nvmrc/);
  assert.match(setup, /package-manager-cache: false/);
  assert.doesNotMatch(setup, /^\s+cache:/m);
  const restore = step('Restore public locked dependencies');
  assert.match(
    restore,
    /NPM_CONFIG_CACHE: \$\{\{ runner\.temp \}\}\\reef-rush-npm-cache/,
  );
  assert.match(
    restore,
    /^\s+run: npm run test:bootstrap && npm ci --no-audit --no-fund$/m,
  );
  assert.doesNotMatch(workflow, /strict-ssl|engine-strict|NODE_TLS|--force/);
});

test('bootstrap includes the dependency-free CI contract before dependencies are restored', () => {
  assert.equal(
    manifest.scripts['test:bootstrap'],
    'node --test tests/bootstrap/lockfile.test.mjs tests/bootstrap/ci.test.mjs',
  );
});

test('npm content cache export remains manual-only with two-day retention', () => {
  const cache = step('Export only the npm content cache');
  assert.match(cache, /^\s+if: github\.event_name == 'workflow_dispatch'$/m);
  assert.match(
    cache,
    /^\s+path: \$\{\{ runner\.temp \}\}\\reef-rush-npm-cache\\_cacache$/m,
  );
  assert.match(cache, /if-no-files-found: error/);
  assert.match(cache, /retention-days: 2/);
});

test('validation, installed-package Chromium, all browser projects and normal restoration stay ordered', () => {
  assert.deepEqual(
    steps.map((value) => value.split('\n')[0]),
    [
      'Check out the requested revision',
      'Select the pinned Node runtime',
      'Restore public locked dependencies',
      'Export only the npm content cache',
      'Run the required baseline',
      'Install the pinned Chromium browser',
      'Run the complete browser suite',
      'Restore and check normal production output',
      'Retain browser evidence',
    ],
  );
  assert.match(step('Run the required baseline'), /run: npm run validate\n/);
  assert.match(
    step('Install the pinned Chromium browser'),
    /run: npm exec -- playwright install chromium\n/,
  );
  assert.match(
    step('Run the complete browser suite'),
    /run: npm run test:browser\n/,
  );
  assert.doesNotMatch(
    workflow,
    /--project|--grep|--retries|--workers|--no-sandbox|--disable-gpu/,
  );
});

test('all phase bounds fit the measured 45-minute budget with collection headroom', () => {
  assert.match(workflow, /^    timeout-minutes: 45$/m);
  const bounds = steps.map((value) => {
    const match = /^\s+timeout-minutes: (\d+)$/m.exec(value);
    assert.ok(match, `Missing hard bound for ${value.split('\n')[0]}`);
    return Number(match[1]);
  });
  assert.deepEqual(bounds, [1, 1, 2, 1, 3, 2, 29, 1, 2]);
  assert.equal(
    bounds.slice(0, 6).reduce((sum, value) => sum + value, 0),
    10,
  );
  assert.equal(bounds.reduce((sum, value) => sum + value, 0) + 1 + 2, 45);
  assert.match(config, /globalTimeout:.*1_680_000.*0/);
});

test('the shared browser root is run/attempt isolated and inherited from the job environment', () => {
  assert.ok(
    workflow.includes(`      REEF_RUSH_BROWSER_ARTIFACTS: ${artifactRoot}\n`),
  );
  assert.match(config, /process\.env\.REEF_RUSH_BROWSER_ARTIFACTS/);
});

test('normal output is rebuilt without hooks and an empty emitted JS set fails separately', () => {
  const normal = step('Restore and check normal production output');
  assert.match(normal, /VITE_TEST_HOOKS: 'false'/);
  assert.match(normal, /shell: pwsh/);
  assert.match(normal, /npm run build\n\s+if \(\$LASTEXITCODE -ne 0\)/);
  assert.match(
    normal,
    /\$files = @\(Get-ChildItem -Path dist -Recurse -File -Filter '\*\.js'\)/,
  );
  assert.match(
    normal,
    /if \(\$files\.Count -eq 0\) \{\s+throw 'No emitted JavaScript found\.'\s+\}/,
  );
  assert.doesNotMatch(normal, /^\s+if:|always\(\)|\.map['"]/m);
});

test('normal output rejects actual hook matches rather than truthy arrays of false values', () => {
  const normal = step('Restore and check normal production output');
  assert.match(
    normal,
    /\$matches = @\(\$files \| Select-String -SimpleMatch '__REEF_RUSH_TEST__' -List\)/,
  );
  assert.match(
    normal,
    /if \(\$matches\.Count -gt 0\) \{\s+throw 'Acceptance hooks found in normal production output\.'\s+\}/,
  );
  assert.doesNotMatch(normal, /Select-String[^\n]*-Quiet/);
});

test('always-upload retains only available browser evidence for seven days', () => {
  const evidence = step('Retain browser evidence');
  assert.match(evidence, /^\s+if: always\(\)$/m);
  assert.match(evidence, /retention-days: 7/);
  assert.match(evidence, /if-no-files-found: warn/);
  assert.match(evidence, /include-hidden-files: true/);
  assert.doesNotMatch(
    step('Export only the npm content cache'),
    /include-hidden-files:/,
  );
  assert.match(
    evidence,
    /^\s+path: \|\n            \$\{\{ env\.REEF_RUSH_BROWSER_ARTIFACTS \}\}\\results\n            \$\{\{ env\.REEF_RUSH_BROWSER_ARTIFACTS \}\}\\results\.json\n            \$\{\{ env\.REEF_RUSH_BROWSER_ARTIFACTS \}\}\\report\n/m,
  );
  assert.doesNotMatch(evidence, /production-dist|npm-cache|_logs/);
  assert.doesNotMatch(workflow, /New-Item|Set-Content|Out-File/);
});
