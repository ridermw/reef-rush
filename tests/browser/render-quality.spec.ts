import { expect, test, type ElementHandle, type Page } from '@playwright/test';
import {
  expectDraw,
  expectIdle,
  frames,
  loadSunlit,
  progressKey,
  screen,
  snapshot,
  wallInterval,
} from './acceptance-helpers';

const settingsKey = 'reef-rush.settings';
const legacy = {
  version: 1,
  masterVolume: 0.25,
  sfxEnabled: false,
  musicEnabled: false,
  mouseSteering: false,
  mouseSensitivity: 1.5,
  invertMouseY: true,
  reducedMotion: false,
};
const legacyRaw = ` ${JSON.stringify(legacy)}\n`;
const progressRaw = ' {"version":1,"courses":{}} ';

test.use({ channel: 'chromium', viewport: { width: 961, height: 721 } });

async function seed(page: Page) {
  await page.addInitScript(
    ({ settingsKey, legacyRaw, progressKey, progressRaw }) => {
      if (sessionStorage.getItem('render-quality-fixture')) return;
      localStorage.setItem(settingsKey, legacyRaw);
      localStorage.setItem(progressKey, progressRaw);
      sessionStorage.setItem('render-quality-fixture', 'seeded');
    },
    { settingsKey, legacyRaw, progressKey, progressRaw },
  );
}

async function dimensions(
  page: Page,
  original?: ElementHandle<SVGElement | HTMLElement>,
) {
  return page.locator('#game-root canvas').evaluate(
    (canvas: HTMLCanvasElement, { original, progressKey }) => {
      const rect = canvas.getBoundingClientRect();
      const gl = canvas.getContext('webgl2');
      if (!gl) throw new Error('Native WebGL2 context missing.');
      const shell = document.querySelector('.app-shell');
      if (!shell) throw new Error('Shell missing.');
      return {
        dpr: window.devicePixelRatio,
        css: { width: rect.width, height: rect.height, x: rect.x, y: rect.y },
        client: { width: canvas.clientWidth, height: canvas.clientHeight },
        canvas: { width: canvas.width, height: canvas.height },
        buffer: {
          width: gl.drawingBufferWidth,
          height: gl.drawingBufferHeight,
        },
        shell: {
          width: shell.clientWidth,
          height: shell.clientHeight,
          fontSize: getComputedStyle(shell).fontSize,
        },
        sameCanvas: original ? canvas === original : null,
        progress: localStorage.getItem(progressKey),
      };
    },
    { original, progressKey },
  );
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const quality = dialog.getByRole('combobox', { name: 'Render quality' });
  await expect(quality).toBeVisible({ timeout: 5000 });
  return { dialog, quality };
}

for (const dpr of [1, 2]) {
  test.describe(`render resolution at DPR ${dpr}`, () => {
    test.use({
      deviceScaleFactor: dpr,
    });

    test('native presets retain the paused run, shell, progress and persisted choice', async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await seed(page);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('./');
      expect(
        await page.evaluate((key) => localStorage.getItem(key), settingsKey),
      ).toBe(legacyRaw);
      await loadSunlit(page);
      await page.getByRole('button', { name: 'Pause run' }).click();
      await screen(page, 'paused');
      const paused = await snapshot(page);
      expect(paused.preferences).toEqual({
        ...legacy,
        version: 2,
        renderQuality: 'high',
        reducedMotion: true,
      });
      expect(paused.resources.scene).toMatchObject({
        bodies: 1,
        colliders: 7,
        geometries: 29,
        materials: 27,
      });
      const original = await page.locator('#game-root canvas').elementHandle();
      if (!original) throw new Error('Owned canvas missing.');
      try {
        const { dialog, quality } = await openSettings(page);
        await expect(quality).toHaveValue('high');
        await expect(quality).toHaveAccessibleDescription(
          /game resolution.*shell text.*simulation/i,
        );
        const reduced = dialog.getByRole('checkbox', {
          name: 'Reduced effects',
        });
        await expect(reduced).not.toBeChecked();
        const high = await dimensions(page);
        expect(high.dpr).toBe(dpr);
        const measurements = [];
        for (const [preset, scale] of [
          ['high', 1],
          ['medium', 0.75],
          ['low', 0.5],
        ] as const) {
          await quality.selectOption(preset);
          const current = await frames(page);
          const measured = await dimensions(page, original);
          const expected = {
            width: Math.floor(high.client.width * Math.min(2, dpr) * scale),
            height: Math.floor(high.client.height * Math.min(2, dpr) * scale),
          };
          expect(measured.canvas).toEqual(expected);
          expect(measured.buffer).toEqual(expected);
          expect(measured.css).toEqual(high.css);
          expect(measured.client).toEqual(high.client);
          expect(measured.shell).toEqual(high.shell);
          const pixels = measured.buffer.width * measured.buffer.height;
          const proportion = pixels / (high.buffer.width * high.buffer.height);
          expect(proportion).toBeCloseTo(scale * scale, 2);
          expect(current.player).toEqual(paused.player);
          expect(current.race).toEqual(paused.race);
          expect(current.frame.steps).toBe(paused.frame.steps);
          expect(current.resources).toEqual(paused.resources);
          expect(current.preferences.reducedMotion).toBe(true);
          expect(measured.sameCanvas).toBe(true);
          expect(measured.progress).toBe(progressRaw);
          const draw = await expectDraw(page);
          measurements.push({
            preset,
            measured,
            pixels,
            proportion,
            draw,
            current,
          });
        }
        // Native select keys must stay inside the modal rather than steering or resuming.
        await quality.focus();
        await page.keyboard.press('Home');
        await expect(quality).toHaveValue('high');
        await page.keyboard.press('ArrowDown');
        await expect(quality).toHaveValue('medium');
        await page.keyboard.press('End');
        await expect(quality).toHaveValue('low');
        await page.keyboard.press('w');
        await page.keyboard.press('Tab');
        expect(
          await dialog.evaluate((node) =>
            node.contains(document.activeElement),
          ),
        ).toBe(true);
        await page.keyboard.press('Shift+Tab');
        await expect(quality).toBeFocused();
        await reduced.check();
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        expect((await snapshot(page)).preferences.reducedMotion).toBe(true);
        await reduced.uncheck();
        expect((await snapshot(page)).preferences.reducedMotion).toBe(false);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect
          .poll(async () => (await snapshot(page)).preferences.reducedMotion)
          .toBe(true);
        await quality.focus();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await screen(page, 'paused');
        await expect(
          page.getByRole('button', { name: 'Settings', exact: true }),
        ).toBeFocused();
        const final = await snapshot(page);
        expect(final.player).toEqual(paused.player);
        expect(final.race).toEqual(paused.race);
        expect(final.resources).toEqual(paused.resources);
        const saved = await page.evaluate(
          (key): unknown => JSON.parse(localStorage.getItem(key)!),
          settingsKey,
        );
        const expectedSaved = { ...legacy, version: 2, renderQuality: 'low' };
        expect(saved).toEqual(expectedSaved);
        await page.reload();
        const reloadedControls = await openSettings(page);
        await expect(reloadedControls.quality).toHaveValue('low');
        await page.keyboard.press('Escape');
        await loadSunlit(page);
        await page.getByRole('button', { name: 'Pause run' }).click();
        const reloaded = await dimensions(page);
        expect(reloaded.buffer).toEqual(measurements[2].measured.buffer);
        expect((await snapshot(page)).preferences).toEqual({
          ...expectedSaved,
          reducedMotion: true,
        });
        expect(
          await page.evaluate((key) => localStorage.getItem(key), progressKey),
        ).toBe(progressRaw);
        await page.getByRole('button', { name: 'Return to title' }).click();
        await expectIdle(page);
        await testInfo.attach(`render-quality-dpr-${dpr}`, {
          body: JSON.stringify(
            { dpr, paused, measurements, final, saved, reloaded, errors },
            null,
            2,
          ),
          contentType: 'application/json',
        });
        console.info(
          `Render quality DPR ${dpr}: ${JSON.stringify(measurements.map(({ preset, measured, pixels, proportion }) => ({ preset, ...measured, pixels, proportion })))}`,
        );
        expect(errors).toEqual([]);
      } finally {
        await original.dispose();
      }
    });
  });
}

test.describe('render quality through actual graphics loss', () => {
  test.use({ deviceScaleFactor: 2 });

  test('a choice during native loss waits for restoration and never resumes the run', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await seed(page);
    await page.goto('./');
    await loadSunlit(page);
    await page.getByRole('button', { name: 'Pause run' }).click();
    const { dialog, quality } = await openSettings(page);
    const canvas = await page.locator('#game-root canvas').elementHandle();
    if (!canvas) throw new Error('Owned canvas missing.');
    const extension = await canvas.evaluateHandle(
      (canvas: HTMLCanvasElement) => {
        const extension = canvas
          .getContext('webgl2')
          ?.getExtension('WEBGL_lose_context');
        if (!extension)
          throw new Error('Native WEBGL_lose_context unavailable.');
        return extension;
      },
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      const before = await snapshot(page);
      const high = await dimensions(page);
      await extension.evaluate((extension) => extension.loseContext());
      await expect
        .poll(async () => (await snapshot(page)).graphicsLost)
        .toBe(true);
      const lost = await snapshot(page);
      await quality.selectOption('low');
      await quality.selectOption('medium');
      await wallInterval(page);
      const during = await snapshot(page);
      expect(during.frame).toEqual(lost.frame);
      expect(during.player).toEqual(lost.player);
      expect(during.race).toEqual(lost.race);
      expect(during.resources).toEqual({ ...before.resources, rafChains: 0 });
      expect((await dimensions(page)).canvas).toEqual(high.canvas);
      await extension.evaluate((extension) => extension.restoreContext());
      await expect
        .poll(async () => (await snapshot(page)).graphicsLost)
        .toBe(false);
      const restored = await frames(page);
      const measured = await dimensions(page);
      expect(measured.buffer).toEqual({
        width: Math.floor(high.client.width * 1.5),
        height: Math.floor(high.client.height * 1.5),
      });
      expect(measured.css).toEqual(high.css);
      expect(measured.shell).toEqual(high.shell);
      expect(restored.screen).toBe('paused');
      expect(restored.player).toEqual(lost.player);
      expect(restored.race).toEqual(lost.race);
      expect(restored.frame.steps).toBe(lost.frame.steps);
      expect(restored.resources).toEqual(before.resources);
      expect(restored.preferences.renderQuality).toBe('medium');
      expect(
        await page
          .locator('#game-root canvas')
          .evaluate((current, original) => current === original, canvas),
      ).toBe(true);
      const draw = await expectDraw(page);
      await quality.press('Escape');
      await expect(dialog).toHaveCount(0);
      await screen(page, 'paused');
      await expect(
        page.getByRole('button', { name: 'Settings', exact: true }),
      ).toBeFocused();
      expect(
        await page.evaluate((key) => localStorage.getItem(key), progressKey),
      ).toBe(progressRaw);
      expect(
        await page.evaluate(
          (key): unknown => JSON.parse(localStorage.getItem(key)!),
          settingsKey,
        ),
      ).toEqual({ ...legacy, version: 2, renderQuality: 'medium' });
      await page.getByRole('button', { name: 'Return to title' }).click();
      await expectIdle(page);
      await testInfo.attach('render-quality-native-restoration', {
        body: JSON.stringify(
          { before, lost, during, restored, high, measured, draw, errors },
          null,
          2,
        ),
        contentType: 'application/json',
      });
      console.info(
        `Render quality native restoration: ${JSON.stringify({ high, measured, stepsDuringLoss: during.frame.steps - lost.frame.steps, screen: restored.screen, resources: restored.resources })}`,
      );
      expect(errors).toEqual([]);
    } finally {
      await extension.dispose();
      await canvas.dispose();
    }
  });
});
