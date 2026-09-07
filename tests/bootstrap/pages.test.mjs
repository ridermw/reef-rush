import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = async () =>
  (
    await readFile(
      new URL('../../.github/workflows/pages.yml', import.meta.url),
      'utf8',
    )
  ).replaceAll('\r\n', '\n');
const trusted =
  "github.repository == 'ridermw/reef-rush' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')";
function job(workflow, name) {
  const value = workflow.split(`  ${name}:\n`)[1];
  assert.ok(value, `Missing ${name} job`);
  return value.split(/^  \w+:\n/m)[0];
}
function step(body, name) {
  const value = body.split(`      - name: ${name}\n`)[1];
  assert.ok(value, `Missing ${name} step`);
  return value.split('      - name: ')[0];
}

test('POC triggers cover every branch push except checkpoint-only changes and serialize the entire main run', async () => {
  const workflow = await read();
  assert.match(
    workflow,
    /^on:\n  push:\n    paths-ignore:\n      - docs\/handoffs\/2026-09-04-reef-rush\.md\n  pull_request:\n  workflow_dispatch:\n/m,
  );
  assert.equal((workflow.match(/paths-ignore:/g) ?? []).length, 1);
  assert.match(
    workflow,
    /^concurrency:\n  group: reef-rush-pages-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false\n/m,
  );
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(
    workflow,
    /pull_request_target|continue-on-error|ignoreHTTPSErrors|NODE_TLS|strict-ssl|engine-strict|--force|secrets[.[]/,
  );
});

test('feature pushes validate without promoting artifacts, deploying or requesting the live site', async () => {
  const workflow = await read();
  const build = job(workflow, 'build');
  assert.doesNotMatch(build.split('    steps:')[0], /^\s+if:/m);
  assert.doesNotMatch(step(build, 'Run production scenarios'), /^\s+if:/m);
  for (const body of [
    step(build, 'Upload the tested Pages artifact'),
    job(workflow, 'deploy'),
    job(workflow, 'live'),
  ]) {
    const condition = /^\s+if: (.+)$/m.exec(body)?.[1];
    assert.equal(condition, trusted);
    for (const [repository, ref, event_name, allowed] of [
      [
        'ridermw/reef-rush',
        'refs/heads/feat/production-browser-ci',
        'push',
        false,
      ],
      [
        'ridermw/reef-rush',
        'refs/heads/feat/production-browser-ci',
        'workflow_dispatch',
        false,
      ],
      ['ridermw/reef-rush', 'refs/heads/main', 'pull_request', false],
      ['other/reef-rush', 'refs/heads/main', 'push', false],
      ['ridermw/reef-rush', 'refs/heads/main', 'push', true],
      ['ridermw/reef-rush', 'refs/heads/main', 'workflow_dispatch', true],
    ])
      assert.equal(
        runInNewContext(
          condition,
          { github: { repository, ref, event_name } },
          { timeout: 100 },
        ),
        allowed,
        `${repository} ${ref} ${event_name}`,
      );
  }
});

test('every action is immutable and uses only approved pins', async () => {
  const workflow = await read();
  const pins = {
    checkout: '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'setup-node': '820762786026740c76f36085b0efc47a31fe5020',
    'upload-artifact': '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    'upload-pages-artifact': 'fc324d3547104276b827a68afc52ff2a11cc49c9',
    'deploy-pages': '368f82528645a54fb793d4d04e342629a3f51346',
  };
  const actions = [
    ...workflow.matchAll(/^\s+uses: actions\/([^@\s]+)@([^\s]+)/gm),
  ];
  assert.equal(actions.length, 8);
  assert.equal((workflow.match(/^\s+uses:/gm) ?? []).length, actions.length);
  for (const [, name, sha] of actions) assert.equal(sha, pins[name]);
});

test('only trusted main can promote the tested normal directory without rebuilding', async () => {
  const build = job(await read(), 'build');
  assert.doesNotMatch(build.split('    steps:')[0], /runner\.temp|if:/);
  assert.match(
    build,
    /run: npm run test:browser -- --project=production --project=mobile\n/,
  );
  assert.match(build, /run: npm run assets:validate\n/);
  assert.match(build, /npm run test:bootstrap && npm run test:release/);
  assert.match(
    build,
    /npm run test -- tests\/unit\/livePublication\.test\.ts tests\/unit\/playwrightLiveConfig\.test\.ts tests\/unit\/playwrightConfig\.test\.ts/,
  );
  assert.match(build, /npm run typecheck/);
  assert.doesNotMatch(
    build,
    /npm run validate|npm run build|vite build|SMCT|sunlitPulse|--grep|--retries/,
  );
  const normal = step(build, 'Identify the tested normal bundle');
  assert.match(
    normal,
    /\$dist = Join-Path \$env:REEF_RUSH_BROWSER_ARTIFACTS 'production-dist'/,
  );
  assert.match(
    normal,
    /Get-ChildItem -Path \$dist -Recurse -File -Filter '\*\.js' -ErrorAction Stop/,
  );
  assert.match(normal, /if \(\$files\.Count -eq 0\) \{ throw /);
  assert.match(normal, /Select-String -SimpleMatch '__REEF_RUSH_TEST__' -List/);
  assert.match(normal, /if \(\$matches\.Count -gt 0\) \{ throw /);
  assert.match(normal, /REEF_RUSH_SOURCE_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.match(
    normal,
    /node tools\\write-build-info\.mjs \$env:REEF_RUSH_SOURCE_COMMIT \$dist/,
  );
  assert.match(normal, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/);
  const upload = step(build, 'Upload the tested Pages artifact');
  assert.ok(upload.includes(`if: ${trusted}\n`));
  assert.match(
    upload,
    /path: \$\{\{ env\.REEF_RUSH_BROWSER_ARTIFACTS \}\}\\production-dist\n/,
  );
  assert.ok(
    build.indexOf('Run production scenarios') <
      build.indexOf('Identify the tested normal bundle'),
  );
  assert.ok(
    build.indexOf('Identify the tested normal bundle') <
      build.indexOf('Upload the tested Pages artifact'),
  );
});

test('privileged deploy contains only the Pages action and preserves the existing environment', async () => {
  const deploy = job(await read(), 'deploy');
  assert.match(deploy, /^    needs: build\n/m);
  assert.ok(deploy.includes(`    if: ${trusted}\n`));
  assert.match(
    deploy,
    /^    permissions:\n      pages: write\n      id-token: write\n/m,
  );
  assert.match(
    deploy,
    /^    environment:\n      name: github-pages\n      url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}\n/m,
  );
  assert.equal((deploy.match(/uses:/g) ?? []).length, 1);
  assert.match(deploy, /uses: actions\/deploy-pages@/);
  assert.doesNotMatch(
    deploy,
    /run:|checkout|setup-node|npm|contents:|environment: main/,
  );
});

test('read-only live verification depends on deploy and uses the workflow SHA and isolated config', async () => {
  const live = job(await read(), 'live');
  assert.match(live, /^    needs: deploy\n/m);
  assert.ok(live.includes(`    if: ${trusted}\n`));
  assert.match(live, /^    permissions:\n      contents: read\n/m);
  assert.match(live, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(live, /persist-credentials: false/);
  assert.match(live, /REEF_RUSH_EXPECTED_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.match(
    live,
    /run: npm run test:browser -- --config=playwright\.live\.config\.ts\n/,
  );
  assert.doesNotMatch(
    live,
    /pages:|id-token:|deploy-pages|upload-pages-artifact|webServer|npm run build/,
  );
});

test('restore, browser pins and evidence remain unprivileged with step-scoped temporary roots', async () => {
  const workflow = await read();
  for (const name of ['build', 'live']) {
    const body = job(workflow, name);
    assert.doesNotMatch(body.split('    steps:')[0], /runner\.temp/);
    assert.match(body, /node-version-file: \.nvmrc\n/);
    assert.match(body, /package-manager-cache: false/);
    assert.match(body, /NPM_CONFIG_REGISTRY: https:\/\/registry\.npmjs\.org/);
    assert.match(body, /run: npm ci --no-audit --no-fund\n/);
    assert.match(body, /run: npm exec -- playwright install chromium webkit\n/);
    const evidence = step(body, 'Retain browser evidence');
    assert.match(evidence, /if: always\(\)/);
    assert.match(evidence, /include-hidden-files: true/);
    assert.match(evidence, /retention-days: 7/);
    for (const path of ['results', 'results.json', 'report'])
      assert.ok(
        evidence.includes(`\${{ env.REEF_RUSH_BROWSER_ARTIFACTS }}\\${path}\n`),
      );
    assert.doesNotMatch(evidence, /production-dist|npm-cache/);
    const roots = [...body.matchAll(/REEF_RUSH_BROWSER_ARTIFACTS: (.+)/g)].map(
      (match) => match[1],
    );
    assert.ok(roots.length >= 2);
    assert.equal(new Set(roots).size, 1);
    assert.ok(roots[0].startsWith('${{ runner.temp }}\\'));
    assert.ok(roots[0].includes(`reef-rush-poc-${name}-`));
  }
});
