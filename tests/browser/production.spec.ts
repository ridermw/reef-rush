import { expect, test } from '@playwright/test';
import { expectDraw, selectSunlit, wallInterval } from './acceptance-helpers';

test.use({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 0.5 });

test('normal production has no diagnostics and lazy real gameplay works under the Pages base', async ({
  page,
}) => {
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
  const noHook = () => page.evaluate(() => !('__REEF_RUSH_TEST__' in window));
  await page.goto('./');
  await page.bringToFront();
  expect(await noHook()).toBe(true);
  const heavy = () =>
    [...scripts].filter((url) =>
      /\/(?:three|rapier|SceneRuntime|sunlitShoals|loadCourseDefinition)-/.test(
        url,
      ),
    );
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
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(time).not.toHaveText(paused);
  await page.getByRole('button', { name: 'Pause run' }).click();
  await page.getByRole('button', { name: 'Return to title' }).click();
  await expect(canvas).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dive in' })).toBeVisible();
  await wallInterval(page);
  expect(await noHook()).toBe(true);
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
});
