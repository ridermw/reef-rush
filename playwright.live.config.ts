import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import {
  CANONICAL_URL,
  requireCommit,
} from './tests/fixtures/livePublication.ts';

requireCommit(process.env.REEF_RUSH_EXPECTED_COMMIT);
const baseURL = process.env.REEF_RUSH_LIVE_BASE_URL ?? CANONICAL_URL;
if (baseURL !== CANONICAL_URL)
  throw new Error(
    `Live verification requires the canonical base ${CANONICAL_URL}`,
  );
const artifactsRoot = process.env.REEF_RUSH_BROWSER_ARTIFACTS;
if (artifactsRoot !== undefined && artifactsRoot.trim() === '')
  throw new Error('REEF_RUSH_BROWSER_ARTIFACTS must not be blank');
const outputRoot = resolve(
  artifactsRoot ?? join(tmpdir(), `reef-rush-live-${process.pid}`),
);
process.env.REEF_RUSH_BROWSER_ARTIFACTS = outputRoot;

export default defineConfig({
  testDir: join('tests', 'browser'),
  outputDir: join(outputRoot, 'results'),
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  globalTimeout: 720_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: join(outputRoot, 'results.json') }],
    ['html', { outputFolder: join(outputRoot, 'report'), open: 'never' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    baseURL,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
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
        baseURL,
      },
    },
  ],
});
