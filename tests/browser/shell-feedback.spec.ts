import { expect, test } from '@playwright/test';
import {
  driveSunlit,
  expectIdle,
  loadSunlit,
  progressKey,
  screen,
  snapshot,
  wallInterval,
} from './acceptance-helpers';

const settingsKey = 'reef-rush.settings';

test.use({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 0.5 });

test('native settings persist independently from progress and survive reload', async ({
  page,
}) => {
  await page.goto('./');
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .click({ timeout: 5000 });
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('slider', { name: 'Master volume' }),
  ).toHaveValue('0.4');
  await expect(
    dialog.getByRole('checkbox', { name: 'Sound effects' }),
  ).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'Ambience' }),
  ).not.toBeChecked();
  await dialog.getByRole('slider', { name: 'Master volume' }).press('Home');
  await dialog.getByRole('checkbox', { name: 'Sound effects' }).uncheck();
  await dialog.getByRole('checkbox', { name: 'Ambience' }).check();
  await dialog.getByRole('checkbox', { name: 'Mouse steering' }).uncheck();
  await dialog.getByRole('slider', { name: 'Mouse sensitivity' }).press('End');
  await dialog.getByRole('checkbox', { name: 'Invert mouse pitch' }).check();
  await dialog.getByRole('checkbox', { name: 'Reduced effects' }).check();
  const expected = {
    version: 2,
    masterVolume: 0,
    sfxEnabled: false,
    musicEnabled: true,
    mouseSteering: false,
    mouseSensitivity: 2,
    invertMouseY: true,
    reducedMotion: true,
    renderQuality: 'high',
  };
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown,
      settingsKey,
    ),
  ).toEqual(expected);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), progressKey),
  ).toBeNull();
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    dialog.getByRole('slider', { name: 'Master volume' }),
  ).toHaveValue('0');
  await expect(
    dialog.getByRole('checkbox', { name: 'Ambience' }),
  ).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'Mouse steering' }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole('slider', { name: 'Mouse sensitivity' }),
  ).toHaveValue('2');
  await expect(
    dialog.getByRole('checkbox', { name: 'Invert mouse pitch' }),
  ).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'Reduced effects' }),
  ).toBeChecked();
  await page.keyboard.press('Escape');
  await loadSunlit(page);
  expect(await snapshot(page)).toMatchObject({
    preferences: expected,
    audio: { ownsContext: false, activeEffects: 0, activeAmbience: 0 },
  });
  await page.getByRole('button', { name: 'Pause run' }).click();
  await page.getByRole('button', { name: 'Return to title' }).click();
  await expectIdle(page);
});

test('paused Settings owns Escape and native controls from every focus target', async ({
  page,
}) => {
  await page.goto('./');
  await loadSunlit(page);
  await page.getByRole('button', { name: 'Pause run' }).click();
  await screen(page, 'paused');
  const paused = await snapshot(page);
  const opener = page.getByRole('button', { name: 'Settings', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  for (const target of ['dialog', 'close', 'range', 'checkbox']) {
    await opener.click({ timeout: 5000 });
    await expect(dialog).toBeVisible();
    if (target === 'dialog') await dialog.focus();
    if (target === 'close')
      await dialog.getByRole('button', { name: 'Close settings' }).focus();
    if (target === 'range') {
      await dialog.getByRole('slider', { name: 'Master volume' }).focus();
      await page.keyboard.press('ArrowLeft');
    }
    if (target === 'checkbox') {
      await dialog.getByRole('checkbox', { name: 'Sound effects' }).focus();
      await page.keyboard.press('Space');
    }
    await page.keyboard.press('Tab');
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await screen(page, 'paused');
    await expect(opener).toBeFocused();
    await wallInterval(page, 150);
    const current = await snapshot(page);
    expect(current.frame.steps).toBe(paused.frame.steps);
    expect(current.race).toEqual(paused.race);
    expect(current.player).toEqual(paused.player);
  }
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await screen(page, 'playing');
  await page.getByRole('button', { name: 'Pause run' }).click();
  await page.getByRole('button', { name: 'Return to title' }).click();
  await expectIdle(page);
});

test('native Web Audio unlocks once, emits real nodes, silences and closes across three runs', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const cdp = await context.newCDPSession(page);
  const created = new Set<string>();
  const live = new Set<string>();
  const closed = new Set<string>();
  const oscillators = new Set<string>();
  cdp.on(
    'WebAudio.contextCreated',
    ({ context: audio }: { context: { contextId: string } }) => {
      created.add(audio.contextId);
      live.add(audio.contextId);
    },
  );
  cdp.on(
    'WebAudio.contextWillBeDestroyed',
    ({ contextId }: { contextId: string }) => live.delete(contextId),
  );
  // Native close reports contextChanged; destruction depends on wrapper collection
  // and need not arrive even after close() has resolved and state is "closed".
  cdp.on(
    'WebAudio.contextChanged',
    ({
      context: audio,
    }: {
      context: { contextId: string; contextState: string };
    }) => {
      if (audio.contextState === 'closed') {
        closed.add(audio.contextId);
        live.delete(audio.contextId);
      }
    },
  );
  cdp.on(
    'WebAudio.audioNodeCreated',
    ({ node }: { node: { nodeId: string; nodeType: string } }) => {
      if (/oscillator/i.test(node.nodeType)) oscillators.add(node.nodeId);
    },
  );
  await cdp.send('WebAudio.enable');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  expect(created.size).toBe(0);
  for (let cycle = 0; cycle < 3; cycle++) {
    await loadSunlit(page);
    await expect.poll(() => created.size).toBe(1);
    await expect
      .poll(() => snapshot(page))
      .toMatchObject({
        audio: { status: 'ready', ownsContext: true },
      });
    if (cycle === 0) {
      await page.keyboard.press('Space');
      await expect
        .poll(() => snapshot(page))
        .toMatchObject({
          audio: { emittedCues: { dash: 1 } },
        });
      await expect.poll(() => oscillators.size).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Pause run' }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const dialog = page.getByRole('dialog', {
        name: 'Settings',
        exact: true,
      });
      await dialog.getByRole('checkbox', { name: 'Ambience' }).check();
      expect(await snapshot(page)).toMatchObject({
        audio: { activeEffects: 0, activeAmbience: 0 },
      });
      await dialog.getByRole('button', { name: 'Close settings' }).click();
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
    }
    await expect
      .poll(() => snapshot(page))
      .toMatchObject({
        audio: { activeAmbience: 1 },
      });
    await page.getByRole('button', { name: 'Pause run' }).click();
    expect(await snapshot(page)).toMatchObject({
      audio: { activeEffects: 0, activeAmbience: 0 },
    });
    await page.getByRole('button', { name: 'Return to title' }).click();
    await expectIdle(page);
    expect(await snapshot(page)).toMatchObject({
      audio: {
        phase: 'idle',
        ownsContext: true,
        activeEffects: 0,
        activeAmbience: 0,
        ownedNodes: 1,
        pendingCleanup: false,
      },
    });
    expect(created.size).toBe(1);
    expect(live.size).toBe(1);
  }
  // Exercise the browser lifecycle entry point, not a mutable gameplay hook.
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent('pagehide', { persisted: false }),
    ),
  );
  await expect.poll(() => live.size).toBe(0);
  expect(closed).toEqual(created);
  expect(await page.evaluate(() => '__REEF_RUSH_TEST__' in window)).toBe(false);
  expect(errors).toEqual([]);
  await cdp.detach();
});

test('actual results support replay and course selection without stale run state', async ({
  page,
}) => {
  test.setTimeout(270_000);
  await page.goto('./');
  await loadSunlit(page);
  await driveSunlit(page);
  const replay = page.getByRole('button', { name: 'Race again', exact: true });
  const courses = page.getByRole('button', {
    name: 'Choose another course',
    exact: true,
  });
  await expect(replay).toBeVisible();
  await expect(courses).toBeVisible();
  await expect
    .poll(() => snapshot(page))
    .toMatchObject({
      audio: { emittedCues: { finish: 1 }, activeAmbience: 0 },
    });
  await replay.click();
  await screen(page, 'playing');
  expect(await snapshot(page)).toMatchObject({
    race: {
      status: 'running',
      checkpointIndex: 0,
      pearlCount: 0,
      result: null,
    },
  });
  await driveSunlit(page);
  await courses.click();
  await screen(page, 'course-select');
  await expect(
    page.getByRole('heading', { name: 'Choose a course' }),
  ).toBeVisible();
  await expectIdle(page);
  expect(await snapshot(page)).toMatchObject({
    audio: { activeEffects: 0, activeAmbience: 0 },
  });
});
