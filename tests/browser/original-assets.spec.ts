import { expect, test } from '@playwright/test';
import {
  expectDraw,
  expectIdle,
  loadSunlit,
  screen,
  selectSunlit,
  steps,
} from './acceptance-helpers';

test.use({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 0.5 });

const collision = '**/assets/courses/sunlit-shoals.collision.glb';
const fish = '**/assets/fish/sunfin.glb';
const expectedAssets = [
  '/reef-rush/assets/courses/sunlit-shoals.collision.glb',
  '/reef-rush/assets/courses/sunlit-shoals.visual.glb',
  '/reef-rush/assets/fish/sunfin.glb',
];

test('original assets load lazily under the Pages base and draw the playable scene', async ({
  page,
}) => {
  const assets = new Set<string>();
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.endsWith('.glb')) {
      expect(response.ok()).toBe(true);
      assets.add(new URL(response.url()).pathname);
    }
  });
  await page.goto('./');
  await page.bringToFront();
  await expect(page.getByRole('button', { name: 'Dive in' })).toBeVisible();
  expect([...assets]).toEqual([]);
  await loadSunlit(page);
  expect([...assets].sort()).toEqual(expectedAssets);
  await expectDraw(page);
  await steps(page);
  await page.getByRole('button', { name: 'Pause run' }).click();
  await page.getByRole('button', { name: 'Return to title' }).click();
  await expectIdle(page);
});

test('failed collision asset loading surfaces an error and can retry in the same document', async ({
  page,
}) => {
  let intercepted = false;
  await page.route(collision, (route) => {
    intercepted = true;
    return route.abort('failed');
  });
  await page.goto('./');
  await page.bringToFront();
  await selectSunlit(page);
  await expect.poll(() => intercepted, { timeout: 3000 }).toBe(true);
  await screen(page, 'error');
  await expect(
    page.getByRole('heading', { name: 'Run unavailable' }),
  ).toBeVisible();
  await expectIdle(page);
  await page.getByRole('button', { name: 'Return to title' }).click();
  await page.unroute(collision);
  await loadSunlit(page);
  await expectDraw(page);
  await page.getByRole('button', { name: 'Pause run' }).click();
  await page.getByRole('button', { name: 'Return to title' }).click();
  await expectIdle(page);
});

test('cancelling a delayed GLB load cleans late assets before the next run', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route(fish, async (route) => {
    intercepted = true;
    await gate;
    await route.continue();
  });
  await page.goto('./');
  await page.bringToFront();
  await selectSunlit(page);
  try {
    await expect.poll(() => intercepted, { timeout: 3000 }).toBe(true);
    await screen(page, 'loading');
    await page.getByRole('button', { name: 'Cancel loading' }).click();
    await screen(page, 'title');
  } finally {
    release();
  }
  await expectIdle(page);
  await page.unrouteAll({ behavior: 'wait' });
  await loadSunlit(page);
  await steps(page);
  await page.getByRole('button', { name: 'Pause run' }).click();
  await page.getByRole('button', { name: 'Return to title' }).click();
  await expectIdle(page);
});
