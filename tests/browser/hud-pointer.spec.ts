import { expect, test, type Page } from '@playwright/test';

async function waitForSteps(page: Page) {
  const start = await page.evaluate(
    () => window.__REEF_RUSH_TEST__?.getSnapshot().frame.steps ?? 0,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__REEF_RUSH_TEST__?.getSnapshot().frame.steps ?? 0,
      ),
    )
    .toBeGreaterThanOrEqual(start + 8);
}

async function yaw(page: Page) {
  return page.evaluate(() => {
    const player = window.__REEF_RUSH_TEST__?.getSnapshot().player;
    if (!player) throw new Error('The running player snapshot is missing.');
    return player.yaw;
  });
}

test('desktop HUD leaves the central fish and route view uncovered', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  await page.bringToFront();
  await page.getByRole('button', { name: 'Dive in' }).click();
  await page.getByRole('button', { name: 'Load Sunlit Shoals' }).click();
  const canvas = page.locator('#game-root canvas');
  const hud = page.getByRole('region', { name: 'Run heads-up display' });
  await expect(canvas).toBeVisible();
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () => {
        const surface = await canvas.boundingBox();
        const panel = await hud.boundingBox();
        if (!surface || !panel) throw new Error('Missing gameplay layout.');
        return (panel.y + panel.height - surface.y) / surface.height;
      })
      .toBeLessThanOrEqual(0.25);
    const surface = await canvas.boundingBox();
    if (!surface) throw new Error('Missing canvas bounds.');
    expect(
      await canvas.evaluate(
        (element, point) =>
          document.elementFromPoint(point.x, point.y) === element,
        {
          x: surface.x + surface.width / 2,
          y: surface.y + surface.height / 2,
        },
      ),
    ).toBe(true);
    const screenshot = testInfo.outputPath(
      `course-clearance-${viewport.width}x${viewport.height}.png`,
    );
    await page.screenshot({ path: screenshot });
    console.info(`Course visibility evidence: ${screenshot}`);
  }
});

for (const storage of ['empty', 'invalid'] as const) {
  test(`HUD panels block mouse steering while open water remains interactive with ${storage} storage`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (storage === 'invalid') {
      await page.addInitScript(() => {
        localStorage.setItem('reef-rush.progress', 'invalid save preserved');
      });
    }
    await page.goto('./');
    await page.bringToFront();
    await page.getByRole('button', { name: 'Dive in' }).click();
    await page.getByRole('button', { name: 'Load Sunlit Shoals' }).click();
    const canvas = page.locator('#game-root canvas');
    await expect(canvas).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => window.__REEF_RUSH_TEST__?.getSnapshot().screen),
      )
      .toBe('playing');

    const panels = page.locator(
      '.hud-header, .hud-card, .dash-meter, .progress-notice',
    );
    if (storage === 'invalid') {
      await expect(page.getByRole('status')).toContainText(
        'invalid existing save preserved',
      );
    }
    for (const panel of await panels.all()) {
      expect(
        await panel.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return Boolean(
            document
              .elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              )
              ?.closest('.hud-shell, .progress-notice'),
          );
        }),
      ).toBe(true);
    }
    expect(
      await page
        .getByRole('button', { name: 'Pause run' })
        .evaluate((button) => {
          const rect = button.getBoundingClientRect();
          return (
            document
              .elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              )
              ?.closest('button') === button
          );
        }),
    ).toBe(true);

    const box = await canvas.boundingBox();
    if (!box) throw new Error('The visible canvas has no bounds.');
    const water = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(
      await canvas.evaluate(
        (element, point) =>
          document.elementFromPoint(point.x, point.y) === element,
        water,
      ),
    ).toBe(true);
    await page.mouse.move(water.x, water.y);
    await waitForSteps(page);
    const beforeWater = await yaw(page);
    await page.mouse.move(water.x + 100, water.y, { steps: 4 });
    await waitForSteps(page);
    expect(Math.abs((await yaw(page)) - beforeWater)).toBeGreaterThan(0.0001);

    const beforeHud = await yaw(page);
    for (const panel of await panels.all()) {
      const rect = await panel.boundingBox();
      if (!rect) throw new Error('The visible HUD panel has no bounds.');
      await page.mouse.move(rect.x + 8, rect.y + rect.height / 2);
      await page.mouse.move(rect.x + rect.width - 8, rect.y + rect.height / 2, {
        steps: 4,
      });
    }
    await waitForSteps(page);
    expect(await yaw(page)).toBe(beforeHud);
    expect(errors).toEqual([]);
    if (storage === 'invalid') {
      expect(
        await page.evaluate(() => localStorage.getItem('reef-rush.progress')),
      ).toBe('invalid save preserved');
    }
  });
}
