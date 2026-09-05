import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173/reef-rush/';
const productionURL = 'http://127.0.0.1:4174/reef-rush/';
const outputRoot = join(tmpdir(), `reef-rush-playwright-${process.pid}`);
const productionDist = join(outputRoot, 'production-dist');

export default defineConfig({
  testDir: join('tests', 'browser'),
  outputDir: join(outputRoot, 'results'),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
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
