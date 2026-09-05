import { expect, test, type Locator, type Page } from '@playwright/test';
import { parseProgress } from '../../src/game/progression/progress';
import {
  expectDraw,
  keyboardSurface,
  progressKey,
  selectSunlit,
  wallInterval,
} from './acceptance-helpers';
import { openDiagnostics, reading, readings } from './diagnostics-helpers';

test.use({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 0.5 });

function observeProduction(page: Page) {
  const errors: string[] = [];
  const failures: string[] = [];
  const scripts = new Set<string>();
  const assets = new Set<string>();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) => failures.push(request.url()));
  page.on('response', (response) => {
    if (response.status() >= 400)
      failures.push(`${response.status()} ${response.url()}`);
    if (response.request().resourceType() === 'script')
      scripts.add(response.url());
    if (new URL(response.url()).pathname.endsWith('.glb'))
      assets.add(new URL(response.url()).pathname);
  });
  return {
    errors,
    failures,
    scripts,
    assets,
    noHook: () => page.evaluate(() => !('__REEF_RUSH_TEST__' in window)),
    storedProgress: () =>
      page.evaluate((key) => localStorage.getItem(key), progressKey),
    heavy: () =>
      [...scripts].filter((url) =>
        /\/(?:three|rapier|SceneRuntime|sunlitShoals|kelpworks|blacksmokerRun|loadCourseDefinition)-/.test(
          url,
        ),
      ),
  };
}

async function chooseQuality(page: Page, quality: 'medium' | 'low') {
  const canvas = page.locator('#game-root canvas');
  const dimensions = () =>
    canvas.evaluate((element: HTMLCanvasElement) => ({
      width: element.width,
      height: element.height,
      cssWidth: element.clientWidth,
      cssHeight: element.clientHeight,
      dpr: window.devicePixelRatio,
    }));
  const before = await dimensions();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings
    .getByRole('combobox', { name: 'Render quality' })
    .selectOption(quality);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(page.getByText('Run paused', { exact: true })).toBeVisible();
  const after = await dimensions();
  const ratio = Math.min(2, before.dpr) * (quality === 'medium' ? 0.75 : 0.5);
  expect(after).toEqual({
    width: Math.floor(before.cssWidth * ratio),
    height: Math.floor(before.cssHeight * ratio),
    cssWidth: before.cssWidth,
    cssHeight: before.cssHeight,
    dpr: before.dpr,
  });
  const storedSettings = await page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem('reef-rush.settings') ?? 'null',
      ) as unknown,
  );
  expect(storedSettings).toMatchObject({ version: 2, renderQuality: quality });
  return { before, after, storedSettings, draw: await expectDraw(page) };
}

async function expectActiveOwners(
  dialog: Locator,
  scene: Record<string, number>,
) {
  for (const [label, value] of Object.entries({
    ...scene,
    'Active scene owners': 1,
    'Attached canvases': 1,
    'RAF chains': 1,
    'Pending release owners': 0,
    'Construction owners': 0,
  }))
    await expect(reading(dialog, label)).toHaveText(String(value));
}

async function readIdleOwners(page: Page) {
  const dialog = await openDiagnostics(page);
  const labels = [
    'Bodies',
    'Colliders',
    'Geometries',
    'Materials',
    'Active scene owners',
    'Attached canvases',
    'RAF chains',
    'Pending release owners',
    'Construction owners',
  ];
  await expect
    .poll(async () => {
      await dialog.getByRole('button', { name: 'Refresh snapshot' }).click();
      const values = await readings(dialog);
      return Object.fromEntries(labels.map((label) => [label, values[label]]));
    })
    .toEqual(Object.fromEntries(labels.map((label) => [label, '0'])));
  const idle = await readings(dialog);
  await dialog.getByRole('button', { name: 'Close diagnostics' }).click();
  return idle;
}

test('normal production has no acceptance global and lazy real gameplay works under the Pages base', async ({
  page,
}, testInfo) => {
  const { errors, failures, scripts, assets, noHook, storedProgress, heavy } =
    observeProduction(page);
  await page.goto('./');
  await page.bringToFront();
  expect(await noHook()).toBe(true);
  const progressBefore = await storedProgress();
  expect(heavy()).toEqual([]);
  expect([...assets]).toEqual([]);
  await selectSunlit(page);
  const canvas = page.locator('#game-root canvas');
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause run' })).toBeVisible();
  expect(await noHook()).toBe(true);
  expect([...assets].sort()).toEqual([
    '/reef-rush/assets/courses/sunlit-shoals.collision.glb',
    '/reef-rush/assets/courses/sunlit-shoals.visual.glb',
    '/reef-rush/assets/fish/sunfin.glb',
  ]);
  const loaded = heavy();
  for (const name of [
    'three',
    'rapier',
    'SceneRuntime',
    'sunlitShoals',
    'loadCourseDefinition',
  ]) {
    expect(
      loaded.some((url) => url.includes(`/${name}-`)),
      name,
    ).toBe(true);
  }
  expect(
    [...scripts].every((url) =>
      new URL(url).pathname.startsWith('/reef-rush/'),
    ),
  ).toBe(true);
  console.info(
    `Normal production lazy chunks: ${loaded.map((url) => new URL(url).pathname).join(', ')}`,
  );
  console.info(
    `Normal production WebGL framebuffer: ${JSON.stringify(await expectDraw(page))}`,
  );
  await page.locator('.hud-header').hover();
  await canvas.focus();
  const time = page
    .locator('.hud-card')
    .filter({ hasText: 'Time' })
    .locator('strong');
  const before = await time.innerText();
  const reserve = page.locator('.dash-meter strong');
  await expect(reserve).toHaveText('100%');
  await page.keyboard.down('w');
  await page.keyboard.press('Space');
  await expect(reserve).not.toHaveText('100%');
  await expect(time).not.toHaveText(before);
  await expect(
    page
      .locator('.hud-card')
      .filter({ hasText: 'Checkpoints' })
      .locator('strong'),
  ).toHaveText('1 / 4');
  await page.keyboard.up('w');
  await page.keyboard.press('Escape');
  await expect(page.getByText('Run paused', { exact: true })).toBeVisible();
  const paused = await time.innerText();
  await wallInterval(page);
  await expect(time).toHaveText(paused);
  const quality = await chooseQuality(page, 'medium');
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  const diagnostics = page.getByRole('dialog', {
    name: 'Diagnostics',
    exact: true,
  });
  await expect(diagnostics).toBeVisible();
  await expect(
    diagnostics.getByText('Recent running samples', { exact: true }),
  ).toBeVisible();
  await expect(reading(diagnostics, 'Selected quality')).toHaveText('medium');
  await expect(reading(diagnostics, 'Running samples')).toHaveText('0 / 120');
  await expectActiveOwners(diagnostics, {
    Bodies: 1,
    Colliders: 7,
    Geometries: 29,
    Materials: 27,
  });
  await diagnostics.getByRole('button', { name: 'Refresh snapshot' }).click();
  const active = await readings(diagnostics);
  expect(await noHook()).toBe(true);
  await expect(time).toHaveText(paused);
  await diagnostics.getByRole('button', { name: 'Close diagnostics' }).click();
  await expect(diagnostics).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Diagnostics', exact: true }),
  ).toBeFocused();
  await expect(page.getByText('Run paused', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(time).not.toHaveText(paused);
  await page.getByRole('button', { name: 'Pause run' }).click();
  await page.getByRole('button', { name: 'Return to title' }).click();
  await expect(canvas).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dive in' })).toBeVisible();
  const idle = await readIdleOwners(page);
  await wallInterval(page);
  expect(await storedProgress()).toBe(progressBefore);
  expect(await noHook()).toBe(true);
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
  await testInfo.attach('normal-production-sunlit-shoals', {
    body: JSON.stringify({ quality, active, idle, progressUnchanged: true }),
    contentType: 'application/json',
  });
});

test.describe('normal production with isolated qualification fixtures', () => {
  test.use({ deviceScaleFactor: 1 });

  const qualificationRaw = JSON.stringify(
    parseProgress({
      version: 1,
      courses: {
        'sunlit-shoals': {
          bestElapsedMs: 25_000,
          bestMedal: 'bronze',
          bestPearlCount: 4,
        },
        kelpworks: {
          bestElapsedMs: 35_000,
          bestMedal: 'silver',
          bestPearlCount: 5,
        },
      },
    }),
  );

  for (const course of [
    {
      id: 'kelpworks',
      name: 'Kelpworks',
      chunk: 'kelpworks',
      owners: { Bodies: 2, Colliders: 10, Geometries: 31, Materials: 32 },
    },
    {
      id: 'blacksmoker-run',
      name: 'Blacksmoker Run',
      chunk: 'blacksmokerRun',
      owners: { Bodies: 3, Colliders: 13, Geometries: 35, Materials: 38 },
    },
  ]) {
    test(`${course.name} loads original assets, draws and preserves native controls without an acceptance global`, async ({
      page,
    }, testInfo) => {
      testInfo.annotations.push({
        type: 'qualification fixture',
        description:
          'Seeded only to select this production course; not earned progression or medal evidence.',
      });
      const {
        errors,
        failures,
        scripts,
        assets,
        noHook,
        storedProgress,
        heavy,
      } = observeProduction(page);
      await page.addInitScript(
        ({ key, raw }) => localStorage.setItem(key, raw),
        { key: progressKey, raw: qualificationRaw },
      );

      await page.goto('./');
      await page.bringToFront();
      expect(await noHook()).toBe(true);
      expect(heavy()).toEqual([]);
      expect([...assets]).toEqual([]);
      await page.getByRole('button', { name: 'Dive in' }).click();
      await page
        .getByRole('button', { name: `Load ${course.name}`, exact: true })
        .click();
      const canvas = page.locator('#game-root canvas');
      await expect(canvas).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Pause run' }),
      ).toBeVisible();
      expect(await noHook()).toBe(true);
      expect([...assets].sort()).toEqual([
        `/reef-rush/assets/courses/${course.id}.collision.glb`,
        `/reef-rush/assets/courses/${course.id}.visual.glb`,
        '/reef-rush/assets/fish/sunfin.glb',
      ]);
      const loaded = heavy();
      for (const chunk of [
        'three',
        'rapier',
        'SceneRuntime',
        'loadCourseDefinition',
        course.chunk,
      ])
        expect(
          loaded.some((path) => path.includes(`/${chunk}-`)),
          chunk,
        ).toBe(true);
      expect(
        [...scripts].every((url) =>
          new URL(url).pathname.startsWith('/reef-rush/'),
        ),
      ).toBe(true);
      const initialDraw = await expectDraw(page);
      await keyboardSurface(page);
      const time = page
        .locator('.hud-card')
        .filter({ hasText: 'Time' })
        .locator('strong');
      const before = await time.innerText();
      const reserve = page.locator('.dash-meter strong');
      await expect(reserve).toHaveText('100%');
      await page.keyboard.down('w');
      try {
        await page.keyboard.press('Space');
        await expect(reserve).not.toHaveText('100%');
        await expect(time).not.toHaveText(before);
      } finally {
        await page.keyboard.up('w');
      }
      await page.keyboard.press('Escape');
      await expect(page.getByText('Run paused', { exact: true })).toBeVisible();
      const paused = await time.innerText();
      await wallInterval(page);
      await expect(time).toHaveText(paused);
      const {
        before: high,
        after: low,
        storedSettings,
        draw: lowDraw,
      } = await chooseQuality(page, 'low');
      const dialog = await openDiagnostics(page);
      await expect(reading(dialog, 'Selected quality')).toHaveText('low');
      await expect(reading(dialog, 'Running samples')).toHaveText('0 / 120');
      await expectActiveOwners(dialog, course.owners);
      await dialog.getByRole('button', { name: 'Refresh snapshot' }).click();
      const active = await readings(dialog);
      await expect(time).toHaveText(paused);
      expect(await noHook()).toBe(true);
      await dialog.getByRole('button', { name: 'Close diagnostics' }).click();
      await expect(
        page.getByRole('button', { name: 'Diagnostics', exact: true }),
      ).toBeFocused();
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await expect(time).not.toHaveText(paused);
      await page.getByRole('button', { name: 'Pause run' }).click();
      await page.getByRole('button', { name: 'Return to title' }).click();
      await expect(canvas).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Dive in' })).toBeVisible();
      const idle = await readIdleOwners(page);
      await wallInterval(page);
      expect(await storedProgress()).toBe(qualificationRaw);
      expect(await noHook()).toBe(true);
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
      await testInfo.attach(`normal-production-${course.id}`, {
        body: JSON.stringify({
          fixture: 'Isolated qualification only, not earned progression.',
          course: course.id,
          assets: [...assets].sort(),
          chunks: loaded,
          initialDraw,
          lowDraw,
          high,
          low,
          storedSettings,
          active,
          idle,
        }),
        contentType: 'application/json',
      });
    });
  }
});
