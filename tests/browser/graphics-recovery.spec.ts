import { expect, test, type Page } from '@playwright/test';
import {
  driveSunlit,
  expectDraw,
  expectIdle,
  frames,
  keyboardSurface,
  loadSunlit,
  progressKey,
  screen,
  selectSunlit,
  snapshot,
  steps,
  wallInterval,
} from './acceptance-helpers';

test.use({
  channel: 'chromium',
  viewport: { width: 960, height: 720 },
  deviceScaleFactor: 0.5,
});

async function nativeGraphics(page: Page) {
  const canvas = await page.locator('#game-root canvas').elementHandle();
  if (!canvas) throw new Error('The owned canvas is missing.');
  const extension = await canvas.evaluateHandle(
    (element: HTMLCanvasElement) => {
      const gl = element.getContext('webgl2');
      const extension = gl?.getExtension('WEBGL_lose_context');
      if (!extension)
        throw new Error('Native WEBGL_lose_context is unavailable.');
      return extension;
    },
  );
  return {
    canvas,
    lose: async () => {
      await extension.evaluate((extension) => extension.loseContext());
      await expect
        .poll(async () => (await snapshot(page)).graphicsLost)
        .toBe(true);
    },
    restore: async () => {
      await extension.evaluate((extension) => extension.restoreContext());
      await expect
        .poll(async () => (await snapshot(page)).graphicsLost)
        .toBe(false);
    },
    release: async () => {
      await extension.dispose();
      await canvas.dispose();
    },
  };
}

test('unsupported native WebGL gives guidance and explicit retry without abandoned owners', async ({
  playwright,
  baseURL,
}, testInfo) => {
  const browser = await playwright.chromium.launch({
    channel: 'chromium',
    headless: true,
    args: ['--disable-webgl'],
  });
  try {
    const page = await browser.newPage({ baseURL });
    await page.goto('./');
    await selectSunlit(page);
    await screen(page, 'error');
    await expect(
      page.getByText(/WebGL 2.*current desktop browser.*hardware acceleration/),
    ).toBeVisible();
    await expect(page.getByText(/Error creating WebGL context/)).toBeVisible();
    await expectIdle(page);
    const first = await snapshot(page);
    await page.getByRole('button', { name: 'Retry course' }).click();
    await screen(page, 'error');
    await expectIdle(page);
    const retry = await snapshot(page);
    await page.screenshot({
      path: testInfo.outputPath('unsupported-webgl.png'),
    });
    await page.getByRole('button', { name: 'Return to title' }).click();
    await screen(page, 'title');
    await expectIdle(page);
    await testInfo.attach('unsupported-native-owners', {
      body: JSON.stringify(
        { first, retry, title: await snapshot(page) },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    console.info(
      'Native --disable-webgl: renderer creation failed, retry remained explicit, canvas/RAF/scene/pending owners=0.',
    );
  } finally {
    await browser.close();
  }
});

test('native graphics loss retains the paused run, restores drawing and supports explicit fresh retry', async ({
  page,
}, testInfo) => {
  const saved = JSON.stringify({
    version: 1,
    courses: {
      'sunlit-shoals': {
        bestElapsedMs: 50000,
        bestMedal: 'bronze',
        bestPearlCount: 2,
      },
    },
  });
  await page.addInitScript(
    ({ key, saved }) => localStorage.setItem(key, saved),
    { key: progressKey, saved },
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await loadSunlit(page);
  const graphics = await nativeGraphics(page);
  const evidence = [];
  try {
    await page.keyboard.down('w');
    await steps(page, 120);
    for (let cycle = 0; cycle < 2; cycle++) {
      const before = await snapshot(page);
      await graphics.lose();
      await screen(page, 'paused');
      const lost = await snapshot(page);
      expect(lost.audio.activeEffects).toBe(0);
      expect(lost.audio.activeAmbience).toBe(0);
      expect(lost.resources).toEqual({ ...before.resources, rafChains: 0 });
      expect(lost.collectedPearlIds).toEqual(before.collectedPearlIds);
      await wallInterval(page, 900);
      await page.keyboard.press('Escape');
      const during = await snapshot(page);
      expect(during.frame).toEqual(lost.frame);
      expect(during.race).toEqual(lost.race);
      expect(during.player).toEqual(lost.player);
      await expect(
        page.getByRole('button', { name: 'Resume', exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole('button', { name: 'Resume run', exact: true }),
      ).toBeDisabled();
      if (cycle === 0) {
        await page
          .getByRole('button', { name: 'Settings', exact: true })
          .click();
        await page.getByRole('checkbox', { name: 'Mouse steering' }).uncheck();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect((await snapshot(page)).screen).toBe('paused');
      }
      await graphics.restore();
      const restored = await frames(page);
      expect(restored.screen).toBe('paused');
      expect(restored.race).toEqual(lost.race);
      expect(restored.player).toEqual(lost.player);
      expect(restored.collectedPearlIds).toEqual(lost.collectedPearlIds);
      expect(restored.frame.steps).toBe(lost.frame.steps);
      expect(restored.resources).toEqual(before.resources);
      expect(
        await page
          .locator('#game-root canvas')
          .evaluate(
            (current, original) => current === original,
            graphics.canvas,
          ),
      ).toBe(true);
      const draw = await expectDraw(page);
      await page.screenshot({
        path: testInfo.outputPath(`restored-paused-${cycle + 1}.png`),
      });
      await page.keyboard.up('w');
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await keyboardSurface(page);
      await page.keyboard.down('w');
      const resumed = await steps(page, 8);
      expect(resumed.player?.position).not.toEqual(lost.player?.position);
      expect(resumed.race!.elapsedMs - lost.race!.elapsedMs).toBeCloseTo(
        ((resumed.frame.steps - lost.frame.steps) * 1000) / 60,
        5,
      );
      await page.keyboard.up('w');
      await page
        .getByRole('button', { name: 'Pause run', exact: true })
        .click();
      evidence.push({
        cycle: cycle + 1,
        before,
        lost,
        during,
        restored,
        resumed,
        draw,
      });
      console.info(
        `Native graphics cycle ${cycle + 1}: ${JSON.stringify({
          before: before.race?.elapsedMs,
          lost: lost.race?.elapsedMs,
          during: during.race?.elapsedMs,
          restored: restored.race?.elapsedMs,
          resumed: resumed.race?.elapsedMs,
          stepsDuringLoss: during.frame.steps - lost.frame.steps,
          resources: restored.resources,
          draw,
        })}`,
      );
    }
    await graphics.lose();
    const oldRun = await snapshot(page);
    await page.getByRole('button', { name: 'Retry course' }).click();
    await screen(page, 'playing');
    const retry = await snapshot(page);
    expect(
      await page
        .locator('#game-root canvas')
        .evaluate((current, original) => current === original, graphics.canvas),
    ).toBe(false);
    expect(retry.race!.elapsedMs).toBeLessThan(oldRun.race!.elapsedMs);
    expect(retry.frame.steps).toBeLessThan(oldRun.frame.steps);
    expect(retry.collectedPearlIds).toEqual([]);
    expect(retry.preferences.mouseSteering).toBe(false);
    expect(retry.resources).toEqual({ ...oldRun.resources, rafChains: 1 });
    expect(
      await page.evaluate((key) => localStorage.getItem(key), progressKey),
    ).toBe(saved);
    await page.getByRole('button', { name: 'Pause run' }).click();
    const replacement = await nativeGraphics(page);
    try {
      await replacement.lose();
      await page.getByRole('button', { name: 'Return to title' }).click();
      await expectIdle(page);
    } finally {
      await replacement.release();
    }
    await testInfo.attach('native-graphics-lifecycle', {
      body: JSON.stringify(
        { evidence, oldRun, retry, title: await snapshot(page), errors },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    expect(errors).toEqual([]);
  } finally {
    await page.keyboard.up('w');
    await graphics.release();
  }
});

test('native results loss and restoration retain the earned result and withheld save through title', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(150_000);
  await page.goto('./');
  const owner = await context.newPage();
  await owner.goto('./');
  await owner.evaluate(
    (key) =>
      new Promise<void>((resolve, reject) => {
        void navigator.locks
          .request(key, () => {
            resolve();
            return new Promise<void>(() => {});
          })
          .catch(reject);
      }),
    progressKey,
  );
  try {
    await page.bringToFront();
    await loadSunlit(page);
    const result = await driveSunlit(page);
    const before = await snapshot(page);
    const graphics = await nativeGraphics(page);
    try {
      await graphics.lose();
      const lost = await snapshot(page);
      await wallInterval(page);
      expect((await snapshot(page)).race).toEqual(before.race);
      expect((await snapshot(page)).frame).toEqual(lost.frame);
      expect(lost.screen).toBe('results');
      await expect(page.getByText(/Graphics interrupted/)).toBeVisible();
      await expect(page.getByText(/save pending/)).toBeVisible();
      await graphics.restore();
      const restored = await frames(page);
      expect(restored.race).toEqual(before.race);
      expect(restored.collectedPearlIds).toEqual(before.collectedPearlIds);
      expect(restored.resources).toEqual(before.resources);
      const draw = await expectDraw(page);
      await page.getByRole('button', { name: 'Return to title' }).click();
      await expectIdle(page);
      await owner.close();
      await expect
        .poll(() =>
          page.evaluate((key) => localStorage.getItem(key), progressKey),
        )
        .not.toBeNull();
      const saved = await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!) as unknown,
        progressKey,
      );
      expect(saved).toEqual({
        version: 1,
        courses: {
          'sunlit-shoals': {
            bestElapsedMs: result.elapsedMs,
            bestMedal: result.medal,
            bestPearlCount: result.pearlCount,
          },
        },
      });
      await testInfo.attach('native-results-save', {
        body: JSON.stringify(
          { before, lost, restored, draw, saved, title: await snapshot(page) },
          null,
          2,
        ),
        contentType: 'application/json',
      });
      console.info(
        `Native results restoration: ${JSON.stringify({ elapsedMs: result.elapsedMs, ids: restored.collectedPearlIds, draw, saved })}`,
      );
    } finally {
      await graphics.release();
    }
  } finally {
    if (!owner.isClosed()) await owner.close();
  }
});
