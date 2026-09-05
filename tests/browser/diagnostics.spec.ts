import { expect, test, type Locator, type Page } from '@playwright/test';
import type { HostSnapshot } from '../../src/game/core/GameHost';
import {
  COURSE_NAMES,
  type CourseId,
} from '../../src/content/courses/courseIds';
import {
  keyboardSurface,
  loadSunlit,
  progressKey,
  screen,
  snapshot,
} from './acceptance-helpers';

test.use({
  channel: 'chromium',
  viewport: { width: 960, height: 540 },
  deviceScaleFactor: 1,
});

async function openDiagnostics(page: Page) {
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Diagnostics', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

function reading(dialog: Locator, label: string) {
  return dialog.getByText(label, { exact: true }).locator('..').locator('dd');
}

async function readings(dialog: Locator) {
  return dialog.locator('dl > div').evaluateAll((rows) => {
    const entries = rows.map((row) => {
      const label = row.querySelector('dt')?.textContent;
      const value = row.querySelector('dd')?.textContent;
      if (!label || value === undefined || value === null)
        throw new Error('Incomplete diagnostics reading.');
      return [label, value];
    });
    return Object.fromEntries(entries) as Record<string, string>;
  });
}

function number(text: string): number {
  if (!/^\d+$/.test(text))
    throw new Error(`Expected an integer reading: ${text}`);
  return Number(text);
}

function summary(text: string) {
  const values = text.split(' / ').map(Number);
  if (
    values.length !== 3 ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error(`Expected mean / P95 / max: ${text}`);
  const [mean, p95, max] = values;
  expect(mean).toBeLessThanOrEqual(max);
  expect(p95).toBeLessThanOrEqual(max);
  return { mean, p95, max };
}

function compareOwners(ui: Record<string, string>, observed: HostSnapshot) {
  expect(number(ui['Active scene owners'])).toBe(
    observed.resources.scene ? 1 : 0,
  );
  expect(number(ui['Attached canvases'])).toBe(observed.resources.canvases);
  expect(number(ui['RAF chains'])).toBe(observed.resources.rafChains);
  expect(number(ui['Pending release owners'])).toBe(
    observed.resources.pendingCleanup,
  );
  expect(number(ui['Bodies'])).toBe(observed.resources.scene?.bodies ?? 0);
  expect(number(ui['Colliders'])).toBe(
    observed.resources.scene?.colliders ?? 0,
  );
  expect(number(ui['Geometries'])).toBe(
    observed.resources.scene?.geometries ?? 0,
  );
  expect(number(ui['Materials'])).toBe(
    observed.resources.scene?.materials ?? 0,
  );
  expect(number(ui['Profiled frames'])).toBe(observed.frame.profiled);
  expect(number(ui['Simulation steps'])).toBe(observed.frame.steps);
}

// Explicit 200 ms observation, not RAF-polled full snapshots or summary reads.
async function qualifyingFrames(page: Page, target: number) {
  return page.evaluate(
    ({ target, cadenceMs }) =>
      new Promise<{
        before: number;
        after: number;
        delta: number;
        cadenceMs: number;
        polls: Array<{ elapsedMs: number; profiled: number }>;
      }>((resolve, reject) => {
        const hook = window.__REEF_RUSH_TEST__;
        if (!hook) throw new Error('Acceptance snapshot missing.');
        const initial = hook.getSnapshot();
        if (
          initial.screen !== 'playing' ||
          initial.graphicsLost ||
          document.hidden
        )
          throw new Error('Sampling must start in uninterrupted play.');
        const start = performance.now();
        const before = initial.frame.profiled;
        const polls: Array<{ elapsedMs: number; profiled: number }> = [];
        let timer: ReturnType<typeof setTimeout>;
        const interrupted = () =>
          finish(
            new Error('Native sample interrupted by focus/visibility loss.'),
          );
        function finish(error?: Error, after?: number) {
          clearTimeout(timer);
          window.removeEventListener('blur', interrupted);
          document.removeEventListener('visibilitychange', interrupted);
          if (error) reject(error);
          else if (after !== undefined)
            resolve({ before, after, delta: after - before, cadenceMs, polls });
        }
        function poll() {
          const next = hook!.getSnapshot();
          const elapsedMs = performance.now() - start;
          if (
            next.screen !== 'playing' ||
            next.graphicsLost ||
            document.hidden ||
            next.resources.pendingCleanup !== 0 ||
            next.frame.profiled < before
          ) {
            finish(
              new Error(
                `Sample interrupted: ${next.screen}, lost=${next.graphicsLost}.`,
              ),
            );
            return;
          }
          polls.push({ elapsedMs, profiled: next.frame.profiled });
          if (next.frame.profiled - before >= target)
            finish(undefined, next.frame.profiled);
          else if (elapsedMs >= 45_000)
            finish(
              new Error(
                `Only ${next.frame.profiled - before} qualifying frames in ${elapsedMs} ms.`,
              ),
            );
          else timer = setTimeout(poll, cadenceMs);
        }
        window.addEventListener('blur', interrupted);
        document.addEventListener('visibilitychange', interrupted);
        timer = setTimeout(poll, cadenceMs);
      }),
    { target, cadenceMs: 200 },
  );
}

test('native manual diagnostics stays static, retains a lost/restored race, and resets only on request or changed quality', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  let dialog = await openDiagnostics(page);
  await expect(reading(dialog, 'Running samples')).toHaveText('0 / 120');
  await expect(reading(dialog, 'Backing pixels')).toHaveText('No canvas');
  await expect(
    dialog.getByText('No running samples', { exact: true }),
  ).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Diagnostics', exact: true }),
  ).toBeFocused();
  await loadSunlit(page);
  const observation = await qualifyingFrames(page, 12);
  await page.getByRole('button', { name: 'Pause run', exact: true }).click();
  await screen(page, 'paused');
  const paused = await snapshot(page);
  dialog = await openDiagnostics(page);
  const initial = await readings(dialog);
  compareOwners(initial, paused);
  expect(number(initial['Rendered frames'])).toBeGreaterThanOrEqual(
    paused.frame.rendered,
  );
  await page.waitForFunction(
    (rendered) =>
      window.__REEF_RUSH_TEST__!.getSnapshot().frame.rendered > rendered + 3,
    number(initial['Rendered frames']),
    { polling: 200 },
  );
  expect(await readings(dialog)).toEqual(initial);
  await dialog.getByRole('button', { name: 'Refresh snapshot' }).click();
  const refreshed = await readings(dialog);
  expect(number(refreshed['Rendered frames'])).toBeGreaterThan(
    number(initial['Rendered frames']),
  );
  expect(refreshed['Frame interval (ms)']).toBe(initial['Frame interval (ms)']);
  compareOwners(refreshed, await snapshot(page));
  const close = dialog.getByRole('button', { name: 'Close diagnostics' });
  const refresh = dialog.getByRole('button', { name: 'Refresh snapshot' });
  await refresh.focus();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(refresh).toBeFocused();
  await page.keyboard.press('Escape');
  await screen(page, 'paused');
  expect((await snapshot(page)).race).toEqual(paused.race);

  const canvas = await page.locator('#game-root canvas').elementHandle();
  if (!canvas) throw new Error('Owned canvas missing.');
  const extension = await canvas.evaluateHandle(
    (element: HTMLCanvasElement) => {
      const extension = element
        .getContext('webgl2')
        ?.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Native WEBGL_lose_context unavailable.');
      return extension;
    },
  );
  try {
    await extension.evaluate((extension) => extension.loseContext());
    await expect
      .poll(async () => (await snapshot(page)).graphicsLost)
      .toBe(true);
    const lost = await snapshot(page);
    dialog = await openDiagnostics(page);
    const lostUI = await readings(dialog);
    expect(lostUI.Graphics).toBe('Lost');
    compareOwners(lostUI, lost);
    expect(lostUI['Running samples']).toBe(initial['Running samples']);
    await extension.evaluate((extension) => extension.restoreContext());
    await expect
      .poll(async () => (await snapshot(page)).graphicsLost)
      .toBe(false);
    expect(await readings(dialog)).toEqual(lostUI);
    await dialog.getByRole('button', { name: 'Refresh snapshot' }).click();
    const restoredUI = await readings(dialog);
    const restored = await snapshot(page);
    expect(restoredUI.Graphics).toBe('Available');
    compareOwners(restoredUI, restored);
    expect(restored.race).toEqual(lost.race);
    expect(restored.player).toEqual(lost.player);
    expect(restored.frame.profiled).toBe(lost.frame.profiled);
    await page.keyboard.press('Escape');
    await screen(page, 'paused');
    await expect(
      page.getByRole('button', { name: 'Diagnostics', exact: true }),
    ).toBeFocused();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('combobox', { name: 'Render quality' })
      .selectOption('low');
    await page.keyboard.press('Escape');
    dialog = await openDiagnostics(page);
    await expect(reading(dialog, 'Running samples')).toHaveText('0 / 120');
    await expect(
      dialog.getByText('No running samples', { exact: true }),
    ).toHaveCount(3);
    const resetUI = await readings(dialog);
    await testInfo.attach('13d-native-manual-snapshots', {
      body: JSON.stringify(
        {
          observation,
          paused,
          initial,
          refreshed,
          lost,
          lostUI,
          restored,
          restoredUI,
          resetUI,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    await page.keyboard.press('Escape');
  } finally {
    await extension.dispose();
    await canvas.dispose();
  }
  await page.getByRole('button', { name: 'Return to title' }).click();
  const idle = await snapshot(page);
  expect(idle.resources).toEqual({
    canvases: 0,
    rafChains: 0,
    pendingCleanup: 0,
    scene: null,
  });
  expect(errors).toEqual([]);
});

test('fixed native matrix: nine single attempts in one host, 180 qualifying frames and identical per-course owners', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Isolated valid qualification fixture, not evidence of earned progression.
  const raw = JSON.stringify({
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
  });
  await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), {
    key: progressKey,
    raw,
  });
  await page.goto('./');
  // Fixed test surface, independent of responsive shell padding/minimum height.
  await page.addStyleTag({
    content: `
    .app-shell--runtime { padding: 0; }
    .runtime-stage { width: 960px; min-height: 540px; height: 540px; border: 0; }
    .runtime-overlay { min-height: 540px; }
  `,
  });
  const baseline = new Map<CourseId, HostSnapshot['resources']['scene']>();
  const evidence = [];
  for (const courseId of [
    'sunlit-shoals',
    'kelpworks',
    'blacksmoker-run',
  ] as const) {
    for (const quality of ['low', 'medium', 'high'] as const) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page
        .getByRole('combobox', { name: 'Render quality' })
        .selectOption(quality);
      await page.getByRole('checkbox', { name: 'Mouse steering' }).uncheck();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Dive in', exact: true }).click();
      await page
        .getByRole('button', {
          name: `Load ${COURSE_NAMES[courseId]}`,
          exact: true,
        })
        .click();
      await screen(page, 'playing');
      await keyboardSurface(page);
      const observation = await qualifyingFrames(page, 180);
      expect(observation.delta).toBeGreaterThanOrEqual(180);
      await page
        .getByRole('button', { name: 'Pause run', exact: true })
        .click();
      await screen(page, 'paused');
      const paused = await snapshot(page);
      const dimensions = await page
        .locator('#game-root canvas')
        .evaluate((canvas: HTMLCanvasElement) => {
          const rect = canvas.getBoundingClientRect();
          return {
            css: { width: rect.width, height: rect.height },
            backing: { width: canvas.width, height: canvas.height },
            dpr: window.devicePixelRatio,
          };
        });
      expect(dimensions.css).toEqual({ width: 960, height: 540 });
      expect(dimensions.dpr).toBe(1);
      const scale = quality === 'low' ? 0.5 : quality === 'medium' ? 0.75 : 1;
      expect(dimensions.backing).toEqual({
        width: 960 * scale,
        height: 540 * scale,
      });
      const dialog = await openDiagnostics(page);
      const ui = await readings(dialog);
      expect(ui['Selected quality']).toBe(quality);
      expect(ui['Backing pixels']).toBe(
        `${dimensions.backing.width} x ${dimensions.backing.height}`,
      );
      expect(ui['Running samples']).toBe('120 / 120');
      compareOwners(ui, paused);
      expect(
        number(ui['Profiled frames']) - observation.before - 120,
      ).toBeGreaterThanOrEqual(60);
      const expected =
        courseId === 'sunlit-shoals'
          ? { bodies: 1, colliders: 7, geometries: 29, materials: 27 }
          : courseId === 'kelpworks'
            ? { bodies: 2, colliders: 10, geometries: 31, materials: 32 }
            : { bodies: 3, colliders: 13, geometries: 35, materials: 38 };
      expect(paused.resources).toMatchObject({
        canvases: 1,
        rafChains: 1,
        pendingCleanup: 0,
        scene: { lifecycle: 'active', ...expected },
      });
      if (!baseline.has(courseId))
        baseline.set(courseId, paused.resources.scene);
      else expect(paused.resources.scene).toEqual(baseline.get(courseId));
      const cell = {
        courseId,
        quality,
        observation,
        dimensions,
        excludedWarmupFrames:
          number(ui['Profiled frames']) - observation.before - 120,
        intervalMs: summary(ui['Frame interval (ms)']),
        cpuWorkMs: summary(ui['CPU work (ms)']),
        discardedMs: summary(ui['Discarded time (ms)']),
        droppedSampleCount: number(ui['Dropped-time samples']),
        ui,
        paused,
      };
      await dialog.getByRole('button', { name: 'Close diagnostics' }).click();
      await screen(page, 'paused');
      await page.getByRole('button', { name: 'Return to title' }).click();
      await screen(page, 'title');
      const title = await snapshot(page);
      expect(title.resources).toEqual({
        canvases: 0,
        rafChains: 0,
        pendingCleanup: 0,
        scene: null,
      });
      expect(title.cleanupError).toBeNull();
      expect(title.audio.activeEffects).toBe(0);
      expect(title.audio.activeAmbience).toBe(0);
      const idleDialog = await openDiagnostics(page);
      const idleUI = await readings(idleDialog);
      compareOwners(idleUI, title);
      expect(idleUI['Running samples']).toBe('120 / 120');
      await page.keyboard.press('Escape');
      evidence.push({ ...cell, title, idleUI });
      // By-value attachments survive worker-specific temporary output roots.
      await testInfo.attach(`13d-matrix-${courseId}-${quality}`, {
        body: JSON.stringify(evidence.at(-1), null, 2),
        contentType: 'application/json',
      });
      console.info(
        `13D native matrix ${courseId}/${quality}: ${JSON.stringify({
          intervalMs: cell.intervalMs,
          cpuWorkMs: cell.cpuWorkMs,
          discardedMs: cell.discardedMs,
          droppedSampleCount: cell.droppedSampleCount,
          dimensions,
          qualifyingDelta: observation.delta,
          pollCadenceMs: observation.cadenceMs,
        })}`,
      );
    }
  }
  expect(errors).toEqual([]);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), progressKey),
  ).toBe(raw);
  await testInfo.attach('13d-native-matrix', {
    body: JSON.stringify(
      {
        scope:
          'One attempt per cell, one page/host, neutral native input with mouse steering disabled. Early-course observation, not full traversal, worst-case, FPS or human quality evidence.',
        precision:
          'Timing summaries read only from paused native Diagnostics; UI rounds milliseconds to 2 decimals. Integer counters and dimensions are exact. Poll cadence requested at 200 ms; actual poll elapsed times retained.',
        fixture:
          'Valid qualification seeded in isolated browser storage, not earned progress. Canvas CSS fixed at 960 x 540; DPR 1.',
        evidence,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});
