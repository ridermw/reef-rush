// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PlaywrightTestConfig } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rootVariable = 'REEF_RUSH_BROWSER_ARTIFACTS';
const loadConfig = async () => {
  // Keep the imported config in its own TypeScript project.
  const configPath = '../../playwright.config';
  const module = (await import(configPath)) as {
    default: PlaywrightTestConfig;
  };
  return module.default;
};

// Plain Node imports only inspect declarations; they never invoke Playwright.
function inspectChildConfig(env: NodeJS.ProcessEnv = process.env) {
  const configURL = pathToFileURL(resolve('playwright.config.ts')).href;
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const { default: config } = await import(${JSON.stringify(configURL)});
console.log(config.outputDir);
console.log(process.env.${rootVariable} ?? '<unset>');
console.log(process.pid);`,
    ],
    { env, encoding: 'utf8' },
  )
    .trim()
    .split(/\r?\n/);
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('CI', undefined);
  vi.stubEnv(rootVariable, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('browser artifact ownership', () => {
  it('resolves an explicit relative root and propagates its absolute value', async () => {
    vi.stubEnv(rootVariable, join('artifacts', 'browser run'));
    const config = await loadConfig();
    const root = resolve('artifacts', 'browser run');

    expect(config.outputDir).toBe(join(root, 'results'));
    expect(process.env[rootVariable]).toBe(root);
    expect(config.webServer).toEqual([
      expect.any(Object),
      expect.objectContaining({
        command: `npm exec -- vite build --outDir "${join(root, 'production-dist')}" && npm run preview -- --outDir "${join(root, 'production-dist')}" --host 127.0.0.1 --port 4174 --strictPort`,
      }),
    ]);
  });

  it('preserves an absolute override across launcher and child configuration imports', async () => {
    const root = join(tmpdir(), 'reef-rush-explicit-artifacts');
    vi.stubEnv(rootVariable, root);
    const config = await loadConfig();
    const [childOutput, childRoot, childPid] = inspectChildConfig();

    expect(config.outputDir).toBe(join(root, 'results'));
    expect(childOutput).toBe(config.outputDir);
    expect(childRoot).toBe(root);
    expect(Number(childPid)).not.toBe(process.pid);
  });

  it.each(['', ' ', '\t\r\n'])(
    'rejects a defined blank root (%j)',
    async (root) => {
      vi.stubEnv(rootVariable, root);
      await expect(loadConfig()).rejects.toThrow(
        'REEF_RUSH_BROWSER_ARTIFACTS must not be blank',
      );
    },
  );

  it('creates the local temporary PID root once and passes it to children', async () => {
    const config = await loadConfig();
    const root = join(tmpdir(), `reef-rush-playwright-${process.pid}`);
    expect(config.outputDir).toBe(join(root, 'results'));
    expect(process.env[rootVariable]).toBe(root);

    const [childOutput, childRoot] = inspectChildConfig();
    expect(childOutput).toBe(config.outputDir);
    expect(childRoot).toBe(root);
    vi.resetModules();
    expect((await loadConfig()).outputDir).toBe(config.outputDir);
  });

  it('isolates fresh local invocations without changing the caller environment', () => {
    const env = { ...process.env };
    delete env[rootVariable];
    const [firstOutput, firstRoot, firstPid] = inspectChildConfig(env);
    const [secondOutput, secondRoot, secondPid] = inspectChildConfig(env);

    expect(firstRoot).toBe(join(tmpdir(), `reef-rush-playwright-${firstPid}`));
    expect(secondRoot).toBe(
      join(tmpdir(), `reef-rush-playwright-${secondPid}`),
    );
    expect(firstOutput).toBe(join(firstRoot, 'results'));
    expect(secondOutput).toBe(join(secondRoot, 'results'));
    expect(firstRoot).not.toBe(secondRoot);
    expect(process.env[rootVariable]).toBeUndefined();
  });
});

describe('browser CI configuration', () => {
  it('keeps list-only reporting and no global deadline outside CI', async () => {
    const config = await loadConfig();
    expect(config.reporter).toBe('list');
    expect(config.globalTimeout).toBe(0);
    expect(config.forbidOnly).toBe(false);
  });

  it('keeps an empty CI variable local', async () => {
    vi.stubEnv('CI', '');
    const config = await loadConfig();
    expect(config.globalTimeout).toBe(0);
    expect(config.reporter).toBe('list');
    expect(config.forbidOnly).toBe(false);
  });

  it('gives CI a 28-minute graceful deadline and forbids focused tests', async () => {
    vi.stubEnv('CI', 'true');
    const config = await loadConfig();
    expect(config.globalTimeout).toBe(1_680_000);
    expect(config.forbidOnly).toBe(true);
  });

  it('writes CI JSON and nonopening HTML reports alongside results in the shared root', async () => {
    const root = join(tmpdir(), 'reef-rush-ci-artifacts');
    vi.stubEnv('CI', 'true');
    vi.stubEnv(rootVariable, root);
    const config = await loadConfig();
    expect(config.reporter).toEqual([
      ['list'],
      ['json', { outputFile: join(root, 'results.json') }],
      ['html', { outputFolder: join(root, 'report'), open: 'never' }],
    ]);
  });

  it.each([undefined, 'true'])(
    'preserves both projects and all browser execution constraints (CI=%j)',
    async (ci) => {
      vi.stubEnv('CI', ci);
      const config = await loadConfig();
      const productionDist = join(
        tmpdir(),
        `reef-rush-playwright-${process.pid}`,
        'production-dist',
      );
      expect(config.testDir).toBe(join('tests', 'browser'));
      expect(config.fullyParallel).toBe(false);
      expect(config.workers).toBe(1);
      expect(config.retries).toBe(0);
      expect(config.timeout).toBe(60_000);
      expect(config.expect).toEqual({ timeout: 15_000 });
      expect(config.use).toMatchObject({
        headless: true,
        baseURL: 'http://127.0.0.1:4173/reef-rush/',
        viewport: { width: 1280, height: 900 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
      });
      expect(config.use?.launchOptions).toBeUndefined();
      expect(config.projects).toEqual([
        { name: 'acceptance', testIgnore: '**/production.spec.ts' },
        {
          name: 'production',
          testMatch: '**/production.spec.ts',
          use: { baseURL: 'http://127.0.0.1:4174/reef-rush/' },
        },
      ]);
      expect(config.webServer).toEqual([
        {
          command:
            'npm run build:test && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
          url: 'http://127.0.0.1:4173/reef-rush/',
          reuseExistingServer: false,
          timeout: 120_000,
        },
        {
          command: `npm exec -- vite build --outDir "${productionDist}" && npm run preview -- --outDir "${productionDist}" --host 127.0.0.1 --port 4174 --strictPort`,
          env: { VITE_TEST_HOOKS: 'false' },
          url: 'http://127.0.0.1:4174/reef-rush/',
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ]);
    },
  );
});
