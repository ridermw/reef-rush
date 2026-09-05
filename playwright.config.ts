import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173/reef-rush/';
const productionURL = 'http://127.0.0.1:4174/reef-rush/';
const artifactsRoot = process.env.REEF_RUSH_BROWSER_ARTIFACTS;
if (artifactsRoot !== undefined && artifactsRoot.trim() === '') {
  throw new Error('REEF_RUSH_BROWSER_ARTIFACTS must not be blank');
}
const outputRoot = resolve(
  artifactsRoot ?? join(tmpdir(), `reef-rush-playwright-${process.pid}`),
);
// Workers inherit the launcher's root instead of creating their own PID roots.
process.env.REEF_RUSH_BROWSER_ARTIFACTS = outputRoot;
const productionDist = join(outputRoot, 'production-dist');
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: join('tests', 'browser'),
  outputDir: join(outputRoot, 'results'),
  fullyParallel: false,
  forbidOnly: isCI,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  globalTimeout: isCI ? 1_680_000 : 0,
  expect: { timeout: 15_000 },
  reporter: isCI
    ? [
        ['list'],
        ['json', { outputFile: join(outputRoot, 'results.json') }],
        ['html', { outputFolder: join(outputRoot, 'report'), open: 'never' }],
      ]
    : 'list',
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    baseURL,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'acceptance', testIgnore: '**/production.spec.ts' },
    {
      name: 'production',
      testMatch: '**/production.spec.ts',
      use: { baseURL: productionURL },
    },
  ],
  webServer: [
    {
      command:
        'npm run build:test && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Only the first build runs tsc; Vite writes this normal build separately.
      command: `npm exec -- vite build --outDir "${productionDist}" && npm run preview -- --outDir "${productionDist}" --host 127.0.0.1 --port 4174 --strictPort`,
      env: { VITE_TEST_HOOKS: 'false' },
      url: productionURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
