import { createServer } from 'node:net';
import { expect, test as base } from '@playwright/test';
import {
  frames,
  keyboardSurface,
  loadSunlit,
  screen,
  selectSunlit,
  snapshot,
  steps,
  wallInterval,
} from './acceptance-helpers';

// Regular Playwright contexts force all tabs focused. The default CDP context
// with noDefaults retains Chromium's real tab visibility/focus and trusted events.
const test = base.extend({
  context: async ({ playwright }, provideContext) => {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const address = probe.address();
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    if (!address || typeof address === 'string')
      throw new Error('No local debug port.');
    const owner = await playwright.chromium.launch({
      channel: 'chromium',
      headless: true,
      args: [`--remote-debugging-port=${address.port}`],
    });
    try {
      const client = await playwright.chromium.connectOverCDP(
        `http://127.0.0.1:${address.port}`,
        { noDefaults: true },
      );
      try {
        const context = client.contexts()[0];
        if (!context)
          throw new Error('Native Chromium default context is missing.');
        await provideContext(context);
      } finally {
        await client.close();
      }
    } finally {
      await owner.close();
    }
  },
});

test('native hidden-tab focus loss pauses play and focus return alone never resumes', async ({
  page,
  context,
  baseURL,
}) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await page.goto(baseURL!);
  await page.bringToFront();
  await loadSunlit(page);
  await steps(page);
  const other = await context.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        focus: document.hasFocus(),
        visibility: document.visibilityState,
      })),
    )
    .toEqual({ focus: false, visibility: 'hidden' });
  await screen(page, 'paused');
  const paused = await snapshot(page);
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await wallInterval(page);
  expect((await snapshot(page)).race).toEqual(paused.race);
  expect((await snapshot(page)).frame.steps).toBe(paused.frame.steps);
  await page.keyboard.press('Escape');
  await screen(page, 'playing');
  await keyboardSurface(page);
  const resumed = await steps(page);
  expect(resumed.race!.elapsedMs - paused.race!.elapsedMs).toBeCloseTo(
    ((resumed.frame.steps - paused.frame.steps) * 1000) / 60,
    5,
  );
  await other.close();
  console.info(
    'Native Chromium hidden-tab focus loss paused; focus return did not resume; resumed clock excluded hidden wall time.',
  );
});

test('delayed renderer dependency finishes paused after native hidden-tab focus loss', async ({
  page,
  context,
  baseURL,
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
  await page.setViewportSize({ width: 960, height: 720 });
  await page.goto(baseURL!);
  await page.bringToFront();
  await selectSunlit(page);
  try {
    await expect.poll(() => intercepted).toBe(true);
    await screen(page, 'loading');
    const other = await context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          focus: document.hasFocus(),
          visibility: document.visibilityState,
        })),
      )
      .toEqual({ focus: false, visibility: 'hidden' });
    release();
    await screen(page, 'paused');
    expect((await snapshot(page)).frame.steps).toBe(0);
    expect((await snapshot(page)).race?.elapsedMs).toBe(0);
    await page.bringToFront();
    await frames(page);
    expect((await snapshot(page)).frame.steps).toBe(0);
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await screen(page, 'playing');
    await steps(page);
    await other.close();
    console.info(
      'Delayed Three.js load completed in a native hidden tab: paused at zero time/steps; explicit UI resume required.',
    );
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
