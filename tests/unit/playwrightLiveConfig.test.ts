// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { devices, type PlaywrightTestConfig } from '@playwright/test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const canonical = 'https://ridermw.github.io/reef-rush/';
const commit = 'a'.repeat(40);
async function load(live = true) {
  const path = live
    ? '../../playwright.live.config'
    : '../../playwright.config';
  return ((await import(path)) as { default: PlaywrightTestConfig }).default;
}
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('REEF_RUSH_EXPECTED_COMMIT', commit);
  vi.stubEnv('REEF_RUSH_LIVE_BASE_URL', undefined);
  vi.stubEnv('REEF_RUSH_BROWSER_ARTIFACTS', resolve('live-evidence'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('isolates metadata, desktop and iPhone production scenarios with no local servers', async () => {
  const config = await load();
  expect(config.use).toMatchObject({ baseURL: canonical, headless: true });
  expect(config.use?.ignoreHTTPSErrors).not.toBe(true);
  expect(config.webServer).toBeUndefined();
  expect(config.projects).toEqual([
    {
      name: 'live-metadata',
      testMatch: '**/live-deployment.spec.ts',
      timeout: 420_000,
    },
    {
      name: 'live-production',
      testMatch: '**/production.spec.ts',
      dependencies: ['live-metadata'],
    },
    {
      name: 'live-mobile',
      testMatch: '**/mobile.spec.ts',
      dependencies: ['live-metadata'],
      use: {
        ...devices['iPhone 13'],
        browserName: 'webkit',
        baseURL: canonical,
      },
    },
  ]);
  expect(
    config.projects?.find(({ name }) => name === 'live-mobile')?.use,
  ).toMatchObject({
    browserName: 'webkit',
    viewport: { width: 390, height: 664 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  expect(config.workers).toBe(1);
  expect(config.retries).toBe(0);
  expect(config.forbidOnly).toBe(true);
  expect(config.globalTimeout).toBe(720_000);
  expect(config.outputDir).toBe(join(resolve('live-evidence'), 'results'));
  expect(config.reporter).toEqual([
    ['list'],
    ['json', { outputFile: join(resolve('live-evidence'), 'results.json') }],
    [
      'html',
      { outputFolder: join(resolve('live-evidence'), 'report'), open: 'never' },
    ],
  ]);
});

it.each([undefined, '', 'A'.repeat(40), 'a'.repeat(39)])(
  'rejects live config without a valid expected SHA (%j)',
  async (value) => {
    vi.stubEnv('REEF_RUSH_EXPECTED_COMMIT', value);
    await expect(load()).rejects.toThrow(/40 lowercase hexadecimal/);
  },
);

it.each([
  'http://127.0.0.1:4174/reef-rush/',
  'https://example.com/',
  `${canonical}?v=1`,
  'http://ridermw.github.io/reef-rush/',
])('rejects noncanonical live base %s', async (base) => {
  vi.stubEnv('REEF_RUSH_LIVE_BASE_URL', base);
  await expect(load()).rejects.toThrow(/canonical/);
});

it('rejects blank artifact roots', async () => {
  vi.stubEnv('REEF_RUSH_BROWSER_ARTIFACTS', ' ');
  await expect(load()).rejects.toThrow(/must not be blank/);
});

it('excludes live-only requests from every ordinary local project', async () => {
  const config = await load(false);
  expect(config.testIgnore).toBe('**/live-deployment.spec.ts');
  expect(config.projects).toBeDefined();
  for (const project of config.projects ?? []) {
    const effectiveIgnore = project.testIgnore ?? config.testIgnore;
    expect([effectiveIgnore].flat()).toContain('**/live-deployment.spec.ts');
  }
});

it('wires the unchanged production scenarios to an automatic context fixture', async () => {
  const source = await readFile(
    new URL('../browser/production.spec.ts', import.meta.url),
    'utf8',
  );
  expect(source.split(/\r?\n/)[0]).toBe(
    "import { expect, test, type Locator, type Page } from './productionTest';",
  );
  const fixture = await readFile(
    new URL('../browser/productionTest.ts', import.meta.url),
    'utf8',
  );
  expect(fixture).toMatch(/auto: true/);
  expect(fixture).toMatch(/observeLiveDocuments/);
  expect(fixture).toMatch(/finally/);
  expect(fixture).toMatch(/await .*\.finish\(\)/);
});
