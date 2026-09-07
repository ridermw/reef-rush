import { test, expect } from './productionTest';
import { devices, type Locator, type Page } from '@playwright/test';

async function expectReachable(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error('Touch control has no layout box.');
  const viewport = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: window.innerHeight,
  }));
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(
    await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        ),
      );
    }),
  ).toBe(true);
}

async function expectMobileLayout(page: Page) {
  for (const name of [
    'Steer fish',
    'Dash',
    'Brake',
    'Faster',
    'Slower',
    'Pause run',
  ])
    await expectReachable(
      page,
      page.getByRole('button', { name, exact: true }),
    );
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    height: window.innerHeight,
    coarse: matchMedia('(any-pointer: coarse)').matches,
    touch: navigator.maxTouchPoints > 0 || 'ontouchstart' in window,
    pointerEvents: typeof PointerEvent === 'function',
  }));
  expect(layout.coarse).toBe(true);
  expect(layout.touch).toBe(true);
  expect(layout.pointerEvents).toBe(true);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height + 1);
}

async function expectOriginalDraw(page: Page) {
  const draw = await page.locator('#game-root canvas').evaluate(
    (canvas: HTMLCanvasElement) =>
      new Promise<{ webgl2: boolean; colors: number }>((resolve) => {
        requestAnimationFrame(() => {
          const gl = canvas.getContext('webgl2');
          if (!gl) {
            resolve({ webgl2: false, colors: 0 });
            return;
          }
          const pixels = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(
            0,
            0,
            canvas.width,
            canvas.height,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            pixels,
          );
          const colors = new Set<string>();
          for (let i = 0; i < pixels.length; i += 4 * 101)
            colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
          resolve({ webgl2: true, colors: colors.size });
        });
      }),
  );
  expect(draw.webgl2).toBe(true);
  expect(draw.colors).toBeGreaterThan(8);
}

async function startByTouch(page: Page) {
  await page.getByRole('button', { name: 'Dive in' }).tap();
  await expect(
    page.getByRole('heading', { name: 'Choose a course' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Load Sunlit Shoals' }).tap();
  await expect(page.getByRole('button', { name: 'Pause run' })).toBeVisible();
  await expect(page.locator('#game-root canvas')).toHaveCount(1);
}

for (const [orientation, viewport] of [
  ['portrait', devices['iPhone 13'].viewport],
  ['landscape', devices['iPhone 13 landscape'].viewport],
] as const) {
  test.describe(orientation, () => {
    test.use({ viewport });

    test('normal production supports touch play, pause and clean re-entry', async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      const assets = new Set<string>();
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        const pathname = new URL(response.url()).pathname;
        if (pathname.endsWith('.glb')) {
          expect(response.ok()).toBe(true);
          assets.add(pathname);
        }
      });
      await page.goto('./');
      expect(await page.evaluate(() => '__REEF_RUSH_TEST__' in window)).toBe(
        false,
      );
      await startByTouch(page);
      await expectMobileLayout(page);
      await expectOriginalDraw(page);
      expect([...assets].sort()).toEqual([
        '/reef-rush/assets/courses/sunlit-shoals.collision.glb',
        '/reef-rush/assets/courses/sunlit-shoals.visual.glb',
        '/reef-rush/assets/fish/sunfin.glb',
      ]);
      const reserve = page.locator('.dash-meter strong');
      const time = page
        .locator('.hud-card')
        .filter({ hasText: 'Time' })
        .locator('strong');
      const before = await time.innerText();
      await page.getByRole('button', { name: 'Steer fish' }).tap();
      await page.getByRole('button', { name: 'Dash', exact: true }).tap();
      await expect(reserve).not.toHaveText('100%');
      await expect(time).not.toHaveText(before);
      await page.getByRole('button', { name: 'Pause run' }).tap();
      await expect(page.getByText('Run paused', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('group', { name: 'Touch controls' }),
      ).toHaveCount(0);
      const paused = await time.innerText();
      await page.getByRole('button', { name: 'Settings', exact: true }).tap();
      const settings = page.getByRole('dialog', {
        name: 'Settings',
        exact: true,
      });
      await expect(settings).toBeVisible();
      await settings.getByRole('button', { name: 'Close settings' }).tap();
      await expect(settings).toHaveCount(0);
      await expect(time).toHaveText(paused);
      await page.getByRole('button', { name: 'Resume', exact: true }).tap();
      await expectMobileLayout(page);
      await expect(time).not.toHaveText(paused);

      // Viewport rotation is emulation, not physical iPhone orientation.
      await page.setViewportSize({
        width: viewport.height,
        height: viewport.width,
      });
      await expectMobileLayout(page);
      await page.getByRole('button', { name: 'Pause run' }).tap();
      await page.getByRole('button', { name: 'Return to title' }).tap();
      await expect(page.locator('#game-root canvas')).toHaveCount(0);
      await expect(
        page.getByRole('group', { name: 'Touch controls' }),
      ).toHaveCount(0);
      await page
        .getByRole('button', { name: 'Diagnostics', exact: true })
        .tap();
      const diagnostics = page.getByRole('dialog', {
        name: 'Diagnostics',
        exact: true,
      });
      for (const label of [
        'Attached canvases',
        'RAF chains',
        'Active scene owners',
      ])
        await expect(
          diagnostics
            .getByText(label, { exact: true })
            .locator('..')
            .locator('dd'),
        ).toHaveText('0');
      await diagnostics
        .getByRole('button', { name: 'Close diagnostics' })
        .tap();
      await startByTouch(page);
      await expectMobileLayout(page);
      await expect(reserve).toHaveText('100%');
      expect(await page.evaluate(() => '__REEF_RUSH_TEST__' in window)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      await testInfo.attach(`mobile-${orientation}`, {
        body: JSON.stringify({
          nativeTouchTaps: true,
          physicalIPhone: false,
          exactHeldAxesAndMultiPointer:
            'Covered by TouchControls.test.tsx using the real GameHost and scene.',
          assets: [...assets].sort(),
        }),
        contentType: 'application/json',
      });
    });
  });
}
