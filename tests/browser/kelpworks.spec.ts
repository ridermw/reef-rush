import { expect, test, type Page } from '@playwright/test';
import kelpworks from '../../src/content/courses/kelpworks';
import {
  emptyProgress,
  updateProgress,
} from '../../src/game/progression/progress';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { driveCourseByKeyboard } from '../fixtures/courseKeyboard';
import {
  driveSunlit,
  expectDraw,
  expectIdle,
  frames,
  loadSunlit,
  progressKey,
  screen,
  snapshot,
  timeLabel,
  wallInterval,
} from './acceptance-helpers';

const settingsKey = 'reef-rush.settings';

test.use({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 0.5 });

async function stored(page: Page, key: string): Promise<unknown> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown,
    key,
  );
}

test('empty progress locks implemented Kelpworks without loading its course or assets', async ({
  page,
}) => {
  const kelpRequests: string[] = [];
  page.on('request', (request) => {
    if (/kelpworks/i.test(request.url())) kelpRequests.push(request.url());
  });
  await page.goto('./');
  expect(await stored(page, progressKey)).toBeNull();
  await page.getByRole('button', { name: 'Dive in' }).click();
  await expect(
    page.getByRole('button', { name: 'Locked: Kelpworks', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Load Sunlit Shoals', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Locked: Blacksmoker Run', exact: true }),
  ).toBeDisabled();
  await expectIdle(page);
  expect(await stored(page, progressKey)).toBeNull();
  expect(kelpRequests).toEqual([]);
  await page.getByRole('button', { name: 'Back to title' }).click();
  await screen(page, 'title');
  expect(await snapshot(page)).toMatchObject({
    player: null,
    race: null,
    collectedPearlIds: [],
  });
});

test('actual Sunlit earns lazy Kelpworks, native five-pearl finishes, replay and mixed-course ownership', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(510_000);
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => errors.push(error.message));
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
    ({ contextId }: { contextId: string }) => {
      live.delete(contextId);
    },
  );
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

  async function expectHealthyAudio() {
    await expect.poll(() => created.size).toBe(1);
    expect(live.size).toBe(1);
    expect(closed.size).toBe(0);
    await expect
      .poll(() => snapshot(page))
      .toMatchObject({
        audio: {
          status: 'ready',
          ownsContext: true,
          contextState: 'running',
          pendingCleanup: false,
          cleanupErrors: [],
          observerErrors: [],
        },
      });
  }

  await page.goto('./');
  expect(created.size).toBe(0);
  expect(await stored(page, progressKey)).toBeNull();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('checkbox', { name: 'Mouse steering' }).uncheck();
  await dialog.getByRole('checkbox', { name: 'Reduced effects' }).check();
  await dialog.getByRole('checkbox', { name: 'Ambience' }).check();
  let preferences = {
    ...DEFAULT_SETTINGS,
    mouseSteering: false,
    reducedMotion: true,
    musicEnabled: true,
  };
  expect(await stored(page, settingsKey)).toEqual(preferences);
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeFocused();
  await loadSunlit(page);
  expect((await snapshot(page)).preferences).toEqual(preferences);
  await expectHealthyAudio();
  const sunlitResult = await driveSunlit(page);
  expect(sunlitResult.medal).not.toBeNull();
  let progress = updateProgress(emptyProgress(), sunlitResult);
  await expect.poll(() => stored(page, progressKey)).toEqual(progress);
  // This is an activation assertion after an actual earned/save result, not a
  // seeded progression fixture or an attempt to load a locked course directly.
  await expect(
    page.getByText('Kelpworks: unlocked', { exact: true }),
  ).toBeVisible();
  expect(requests.filter((url) => /kelpworks/i.test(url))).toEqual([]);
  await page.getByRole('button', { name: 'Choose another course' }).click();
  await expectIdle(page);
  await expect(
    page.getByRole('button', { name: 'Load Kelpworks', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Locked: Blacksmoker Run', exact: true }),
  ).toBeDisabled();
  const chunk = page.waitForResponse((response) =>
    /\/assets\/kelpworks-[^/]+\.js$/.test(new URL(response.url()).pathname),
  );
  const visual = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/courses/kelpworks.visual.glb'),
  );
  const collision = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(
      '/courses/kelpworks.collision.glb',
    ),
  );
  await page
    .getByRole('button', { name: 'Load Kelpworks', exact: true })
    .click();
  const responses = await Promise.all([chunk, visual, collision]);
  for (const response of responses) expect(response.ok()).toBe(true);
  expect((await responses[1].body()).byteLength).toBe(110388);
  expect((await responses[2].body()).byteLength).toBe(37512);
  await screen(page, 'playing');
  expect(await snapshot(page)).toMatchObject({
    preferences,
    collectedPearlIds: [],
    race: {
      courseId: 'kelpworks',
      checkpointIndex: 0,
      pearlCount: 0,
      result: null,
    },
    resources: {
      canvases: 1,
      rafChains: 1,
      pendingCleanup: 0,
      scene: { bodies: 2, colliders: 10, geometries: 31, materials: 32 },
    },
  });
  await expectHealthyAudio();
  const draw = await expectDraw(page);
  const screenshotPath = testInfo.outputPath('kelpworks-deep-active.png');
  const first = await driveCourseByKeyboard(
    page,
    kelpworks,
    async (observed) => {
      if (observed.race?.checkpointIndex !== 3) return;
      expect(observed.screen).toBe('playing');
      expect(observed.race?.checkpointIndex).toBe(3);
      if (!observed.player)
        throw new Error('Missing active screenshot player.');
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach('Kelpworks active deep checkpoint', {
        path: screenshotPath,
        contentType: 'image/png',
      });
      console.info(
        `Active Kelpworks screenshot: ${screenshotPath}; observed endpoint: ${JSON.stringify(observed.player.position)}`,
      );
    },
  );
  await expect(page.locator('.results-time')).toHaveText(
    timeLabel(first.result.elapsedMs),
  );
  await expect(page.getByText('5 / 5 pearls', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      first.result.medal ? `${first.result.medal} medal` : 'No medal this run',
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  progress = updateProgress(progress, first.result);
  await expect.poll(() => stored(page, progressKey)).toEqual(progress);
  const finished = await snapshot(page);
  await page.keyboard.press('w');
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  const after = await frames(page);
  expect(after.frame.steps).toBe(finished.frame.steps);
  expect(after.race).toEqual(finished.race);
  expect(after.collectedPearlIds).toEqual(
    kelpworks.pearls.map((pearl) => pearl.id),
  );
  await expectHealthyAudio();
  await expect.poll(() => oscillators.size).toBeGreaterThan(0);
  expect(finished.audio.emittedCues.finish).toBe(2);

  await page.getByRole('button', { name: 'Race again', exact: true }).click();
  await screen(page, 'playing');
  expect(await snapshot(page)).toMatchObject({
    preferences,
    collectedPearlIds: [],
    race: {
      courseId: 'kelpworks',
      checkpointIndex: 0,
      pearlCount: 0,
      result: null,
    },
  });
  await page.getByRole('button', { name: 'Pause run' }).click();
  await screen(page, 'paused');
  const paused = await snapshot(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    dialog.getByRole('checkbox', { name: 'Mouse steering' }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'Ambience' }),
  ).toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Reduced effects' }).uncheck();
  preferences = { ...preferences, reducedMotion: false };
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await screen(page, 'paused');
  await wallInterval(page, 150);
  expect(await snapshot(page)).toMatchObject({
    preferences,
    race: paused.race,
    player: paused.player,
    frame: { steps: paused.frame.steps },
    audio: { activeEffects: 0, activeAmbience: 0 },
  });
  expect(await stored(page, settingsKey)).toEqual(preferences);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await screen(page, 'playing');
  await expectHealthyAudio();
  await expect
    .poll(() => snapshot(page))
    .toMatchObject({ audio: { activeAmbience: 1 } });
  const replay = await driveCourseByKeyboard(page, kelpworks);
  progress = updateProgress(progress, replay.result);
  await expect.poll(() => stored(page, progressKey)).toEqual(progress);
  expect((await snapshot(page)).audio.emittedCues.finish).toBe(3);
  await page.getByRole('button', { name: 'Return to title' }).click();
  await screen(page, 'title');
  await expectIdle(page);
  await expectHealthyAudio();
  expect(await snapshot(page)).toMatchObject({
    preferences,
    player: null,
    race: null,
    collectedPearlIds: [],
    audio: { activeEffects: 0, activeAmbience: 0, ownedNodes: 1 },
  });
  await loadSunlit(page);
  expect(await snapshot(page)).toMatchObject({
    preferences,
    collectedPearlIds: [],
    race: { courseId: 'sunlit-shoals', checkpointIndex: 0, pearlCount: 0 },
  });
  await expectHealthyAudio();
  await page.getByRole('button', { name: 'Pause run' }).click();
  await page.getByRole('button', { name: 'Return to title' }).click();
  await screen(page, 'title');
  await expectIdle(page);
  await expectHealthyAudio();
  expect(await snapshot(page)).toMatchObject({
    collectedPearlIds: [],
    audio: { activeEffects: 0, activeAmbience: 0, ownedNodes: 1 },
  });
  expect(await stored(page, settingsKey)).toEqual(preferences);
  expect(await stored(page, progressKey)).toEqual(progress);
  expect(errors).toEqual([]);
  const evidence = {
    sunlitResult,
    first,
    replay,
    draw,
    screenshotPath,
    assetRequests: responses.map((response) => response.url()),
    audio: {
      created: [...created],
      live: [...live],
      closed: [...closed],
      oscillatorCount: oscillators.size,
    },
    title: await snapshot(page),
  };
  await testInfo.attach('Native earned Kelpworks evidence', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  console.info(`Native mixed-course evidence: ${JSON.stringify(evidence)}`);
  await cdp.detach();
});
