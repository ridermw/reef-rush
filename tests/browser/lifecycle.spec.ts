import { expect, test } from '@playwright/test';
import {
  expectIdle,
  frames,
  loadSunlit,
  screen,
  selectSunlit,
  snapshot,
  steps,
  timeLabel,
  wallInterval,
} from './acceptance-helpers';

test.use({
  channel: 'chromium',
  viewport: { width: 960, height: 720 },
  deviceScaleFactor: 0.5,
});

test('Escape, focused native buttons, wall pause and repeated teardown preserve lifecycle', async ({
  page,
}) => {
  await page.goto('./');
  await page.bringToFront();
  let baseline: Awaited<ReturnType<typeof snapshot>>['resources']['scene'];
  for (let cycle = 0; cycle < 3; cycle++) {
    await loadSunlit(page);
    const before = await snapshot(page);
    expect(before.resources).toMatchObject({
      canvases: 1,
      rafChains: 1,
      pendingCleanup: 0,
    });
    expect(before.resources.scene?.lifecycle).toBe('active');
    if (cycle === 0) baseline = before.resources.scene;
    else expect(before.resources.scene).toEqual(baseline!);
    await page.keyboard.down('w');
    await steps(page, 8);
    await page.keyboard.up('w');
    expect((await snapshot(page)).player?.position).not.toEqual(
      before.player?.position,
    );

    await page.keyboard.press('Escape');
    await screen(page, 'paused');
    await expect(page.getByText('Run paused', { exact: true })).toBeVisible();
    const paused = await snapshot(page);
    await wallInterval(page, 900);
    const still = await frames(page);
    expect(still.frame.steps).toBe(paused.frame.steps);
    expect(still.race).toEqual(paused.race);
    expect(still.player).toEqual(paused.player);
    await expect(
      page.locator('.hud-card').filter({ hasText: 'Time' }).locator('strong'),
    ).toHaveText(timeLabel(paused.race!.elapsedMs));
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await screen(page, 'playing');
    const resumed = await steps(page, 4);
    expect(resumed.race!.elapsedMs - paused.race!.elapsedMs).toBeCloseTo(
      ((resumed.frame.steps - paused.frame.steps) * 1000) / 60,
      5,
    );

    const pauseButton = page.getByRole('button', {
      name: 'Pause run',
      exact: true,
    });
    await pauseButton.focus();
    await page.keyboard.press('Escape');
    await screen(page, 'paused');
    await page.getByRole('button', { name: 'Resume run', exact: true }).focus();
    await page.keyboard.press('Escape');
    await screen(page, 'playing');
    for (const key of ['Space', 'Enter']) {
      await pauseButton.focus();
      await page.keyboard.press(key);
      await screen(page, 'paused');
      await page.getByRole('button', { name: 'Resume', exact: true }).focus();
      await page.keyboard.press(key);
      await screen(page, 'playing');
    }
    await pauseButton.click();
    await screen(page, 'paused');
    await page.getByRole('button', { name: 'Return to title' }).click();
    await expectIdle(page);
    console.info(
      `Lifecycle cycle ${cycle + 1}: ${JSON.stringify(before.resources.scene)}; active canvas/RAF=1/1, idle=0/0, pendingCleanup=0.`,
    );
  }
});

test('failed module loading shows an error and recovers without abandoned resources', async ({
  page,
}) => {
  const failedRequests: string[] = [];
  page.on('requestfailed', (request) => failedRequests.push(request.url()));
  await page.route(/\/assets\/sunlitShoals-[^/]+\.js$/, (route) =>
    route.abort('failed'),
  );
  await page.goto('./');
  await page.bringToFront();
  await selectSunlit(page);
  await screen(page, 'error');
  await expect(
    page.getByRole('heading', { name: 'Run unavailable' }),
  ).toBeVisible();
  await expectIdle(page);
  expect(failedRequests.some((url) => /sunlitShoals-/.test(url))).toBe(true);
  await page.getByRole('button', { name: 'Return to title' }).click();
  await expect(page.getByRole('button', { name: 'Dive in' })).toBeVisible();
  await page.unrouteAll();
  // Chromium caches a rejected ESM import within this document; a real reload retries it.
  await page.reload();
  await loadSunlit(page);
  await steps(page);
  await page.getByRole('button', { name: 'Pause run' }).click();
  await page.getByRole('button', { name: 'Return to title' }).click();
  await expectIdle(page);
});

test('cancelling a delayed load returns to title and cleans late completion', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route(/\/assets\/three-[^/]+\.js$/, async (route) => {
    intercepted = true;
    await gate;
    await route.continue();
  });
  await page.goto('./');
  await page.bringToFront();
  await selectSunlit(page);
  await expect.poll(() => intercepted).toBe(true);
  await screen(page, 'loading');
  try {
    await page
      .getByRole('button', { name: 'Cancel loading' })
      .click({ timeout: 3000 });
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
