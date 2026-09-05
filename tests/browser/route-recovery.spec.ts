import { expect, test } from '@playwright/test';
import {
  driveSunlit,
  expectIdle,
  loadSunlit,
  snapshot,
} from './acceptance-helpers';

test.use({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 0.5 });

test('the keyboard driver recovers a genuinely missed pearl before finishing', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto('./');
  await page.bringToFront();
  await loadSunlit(page);
  await page.keyboard.down('s');
  await page.keyboard.down('Shift');
  await page.waitForFunction(() => {
    const fish = window.__REEF_RUSH_TEST__?.getSnapshot().player;
    return fish && Math.hypot(...fish.velocity) < 0.05;
  });
  await page.keyboard.down('d');
  await page.waitForFunction(
    () => (window.__REEF_RUSH_TEST__?.getSnapshot().player?.yaw ?? 0) <= -0.16,
  );
  await page.keyboard.up('d');
  await page.keyboard.up('Shift');
  await page.keyboard.up('s');
  await page.keyboard.down('w');
  await page.waitForFunction(
    () =>
      (window.__REEF_RUSH_TEST__?.getSnapshot().player?.position[2] ?? 0) >= 19,
  );
  await page.keyboard.up('w');
  const missed = await snapshot(page);
  expect(missed.race?.pearlCount).toBe(0);
  expect(missed.player?.position[2]).toBeGreaterThan(18);
  console.info(
    `Native input missed the first pearl: ${JSON.stringify(missed.player?.position)}`,
  );
  await driveSunlit(page);
  await page.getByRole('button', { name: 'Return to title' }).click();
  await expectIdle(page);
});
