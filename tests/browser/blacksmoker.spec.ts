import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import blacksmoker from '../../src/content/courses/blacksmokerRun';
import kelpworks from '../../src/content/courses/kelpworks';
import type { HostSnapshot } from '../../src/game/core/GameHost';
import {
  emptyProgress,
  updateProgress,
  type Progress,
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
test.describe.configure({ retries: 0 });

async function stored(page: Page, key: string): Promise<unknown> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown,
    key,
  );
}

const sunlitBest = {
  bestElapsedMs: 25_000,
  bestMedal: 'bronze',
  bestPearlCount: 4,
} as const;
const kelpBest = {
  bestElapsedMs: 35_000,
  bestMedal: 'silver',
  bestPearlCount: 5,
} as const;
const finalBest = {
  bestElapsedMs: 30_000,
  bestMedal: 'gold',
  bestPearlCount: 6,
} as const;

for (const { name, courses } of [
  { name: 'empty progress', courses: null },
  { name: 'Sunlit only', courses: { 'sunlit-shoals': sunlitBest } },
  {
    name: 'non-medal Kelpworks',
    courses: {
      'sunlit-shoals': sunlitBest,
      kelpworks: { ...kelpBest, bestMedal: null },
    },
  },
  {
    name: 'orphan later medals',
    courses: { kelpworks: kelpBest, 'blacksmoker-run': finalBest },
  },
  {
    name: 'non-medal Sunlit with later medals',
    courses: {
      'sunlit-shoals': { ...sunlitBest, bestMedal: null },
      kelpworks: kelpBest,
      'blacksmoker-run': finalBest,
    },
  },
]) {
  test(`${name} locks Blacksmoker without requesting final content`, async ({
    page,
  }) => {
    const raw = courses ? JSON.stringify({ version: 1, courses }) : null;
    if (raw !== null) {
      await page.addInitScript(
        ({ key, raw }) => localStorage.setItem(key, raw),
        { key: progressKey, raw },
      );
    }
    const requests: string[] = [];
    page.on('request', (request) => {
      if (/blacksmoker/i.test(request.url())) requests.push(request.url());
    });
    await page.goto('./');
    await page.getByRole('button', { name: 'Dive in' }).click();
    const locked = page.getByRole('button', {
      name: 'Locked: Blacksmoker Run',
      exact: true,
    });
    await expect(locked).toBeDisabled();
    await expect(locked).toHaveAttribute('type', 'button');
    await expectIdle(page);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), progressKey),
    ).toBe(raw);
    expect(requests).toEqual([]);
    await page.getByRole('button', { name: 'Back to title' }).click();
    await screen(page, 'title');
    expect(await snapshot(page)).toMatchObject({
      player: null,
      race: null,
      collectedPearlIds: [],
    });
  });
}

test('actual earned Sunlit and Kelpworks unlock lazy Blacksmoker, six native pearls, replay and mixed ownership', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(600_000);
  const requests: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
    if (message.type() === 'error') errors.push(message.text());
  });
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

  const screenshotPath = testInfo.outputPath('blacksmoker-deep-active.png');
  const evidence: {
    stage: string;
    sunlit?: Awaited<ReturnType<typeof driveSunlit>>;
    kelp?: Awaited<ReturnType<typeof driveCourseByKeyboard>>;
    blacksmoker: Array<Awaited<ReturnType<typeof driveCourseByKeyboard>>>;
    saves: Progress[];
    assets: Array<{ url: string; status: number; bytes: number }>;
    draw?: Awaited<ReturnType<typeof expectDraw>>;
    active?: HostSnapshot;
    title?: HostSnapshot;
    disposal?: unknown;
  } = { stage: 'settings', blacksmoker: [], saves: [], assets: [] };

  try {
    await page.goto('./');
    expect(await stored(page, progressKey)).toBeNull();
    expect(created.size).toBe(0);
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

    evidence.stage = 'earned Sunlit';
    await loadSunlit(page);
    await expectHealthyAudio();
    evidence.sunlit = await driveSunlit(page, testInfo);
    expect(evidence.sunlit.medal).not.toBeNull();
    let progress = updateProgress(emptyProgress(), evidence.sunlit);
    await expect.poll(() => stored(page, progressKey)).toEqual(progress);
    evidence.saves.push(progress);
    await expect(
      page.getByText('Kelpworks: unlocked', { exact: true }),
    ).toBeVisible();
    expect(
      requests.filter((url) => /kelpworks|blacksmoker/i.test(url)),
    ).toEqual([]);
    await page.getByRole('button', { name: 'Choose another course' }).click();
    await expectIdle(page);
    await expect(
      page.getByRole('button', {
        name: 'Locked: Blacksmoker Run',
        exact: true,
      }),
    ).toBeDisabled();
    await page
      .getByRole('button', { name: 'Load Kelpworks', exact: true })
      .click();
    await screen(page, 'playing');
    await expectHealthyAudio();
    evidence.stage = 'qualifying Kelpworks';
    evidence.kelp = await driveCourseByKeyboard(page, kelpworks);
    expect(evidence.kelp.result.medal).not.toBeNull();
    progress = updateProgress(progress, evidence.kelp.result);
    await expect.poll(() => stored(page, progressKey)).toEqual(progress);
    evidence.saves.push(progress);
    await expect(
      page.getByText('Blacksmoker Run: unlocked', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Choose another course' }).click();
    await expectIdle(page);
    const loadFinal = page.getByRole('button', {
      name: 'Load Blacksmoker Run',
      exact: true,
    });
    await expect(loadFinal).toBeEnabled();
    expect(requests.filter((url) => /blacksmoker/i.test(url))).toEqual([]);

    evidence.stage = 'lazy Blacksmoker assets';
    const chunk = page.waitForResponse((response) =>
      /\/assets\/blacksmokerRun-[^/]+\.js$/.test(
        new URL(response.url()).pathname,
      ),
    );
    const visual = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(
        '/courses/blacksmoker-run.visual.glb',
      ),
    );
    const collision = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(
        '/courses/blacksmoker-run.collision.glb',
      ),
    );
    await loadFinal.click();
    for (const response of await Promise.all([chunk, visual, collision])) {
      expect(response.ok()).toBe(true);
      evidence.assets.push({
        url: response.url(),
        status: response.status(),
        bytes: (await response.body()).byteLength,
      });
    }
    expect(evidence.assets[1].bytes).toBe(144384);
    expect(evidence.assets[2].bytes).toBe(40784);

    for (let run = 0; run < 2; run++) {
      evidence.stage = `native Blacksmoker ${run + 1}`;
      await screen(page, 'playing');
      expect(await snapshot(page)).toMatchObject({
        preferences,
        collectedPearlIds: [],
        race: {
          courseId: 'blacksmoker-run',
          status: 'running',
          checkpointIndex: 0,
          pearlCount: 0,
          result: null,
        },
        resources: {
          canvases: 1,
          rafChains: 1,
          pendingCleanup: 0,
          scene: { bodies: 3, colliders: 13, geometries: 35, materials: 38 },
        },
      });
      await expectHealthyAudio();
      if (run === 0) {
        evidence.draw = await expectDraw(page);
      } else {
        await page.getByRole('button', { name: 'Pause run' }).click();
        await screen(page, 'paused');
        const paused = await snapshot(page);
        await page
          .getByRole('button', { name: 'Settings', exact: true })
          .click();
        await expect(
          dialog.getByRole('checkbox', { name: 'Mouse steering' }),
        ).not.toBeChecked();
        await expect(
          dialog.getByRole('checkbox', { name: 'Ambience' }),
        ).toBeChecked();
        await dialog
          .getByRole('checkbox', { name: 'Reduced effects' })
          .uncheck();
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
      }
      const finish = await driveCourseByKeyboard(
        page,
        blacksmoker,
        async (observed) => {
          if (run !== 0 || observed.race?.checkpointIndex !== 3) return;
          expect(observed.screen).toBe('playing');
          evidence.active = observed;
          await page.screenshot({ path: screenshotPath });
          await testInfo.attach('Blacksmoker active deep checkpoint', {
            path: screenshotPath,
            contentType: 'image/png',
          });
        },
      );
      evidence.blacksmoker.push(finish);
      await expect(page.locator('.results-time')).toHaveText(
        timeLabel(finish.result.elapsedMs),
      );
      await expect(
        page.getByText('6 / 6 pearls', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(
          finish.result.medal
            ? `${finish.result.medal} medal`
            : 'No medal this run',
          { exact: true },
        ),
      ).toBeVisible();
      progress = updateProgress(progress, finish.result);
      await expect.poll(() => stored(page, progressKey)).toEqual(progress);
      evidence.saves.push(progress);
      const finished = await snapshot(page);
      await page.keyboard.press('w');
      await page.keyboard.press('Space');
      await page.keyboard.press('Escape');
      const after = await frames(page);
      expect(after.frame.steps).toBe(finished.frame.steps);
      expect(after.race).toEqual(finished.race);
      expect(after.collectedPearlIds).toEqual(
        blacksmoker.pearls.map(({ id }) => id),
      );
      expect(finished.audio.emittedCues.finish).toBe(run + 3);
      await expectHealthyAudio();
      if (run === 0) {
        await page
          .getByRole('button', { name: 'Race again', exact: true })
          .click();
      }
    }
    const [first, replay] = evidence.blacksmoker;
    expect(progress.courses['blacksmoker-run']).toEqual({
      bestElapsedMs: Math.min(first.result.elapsedMs, replay.result.elapsedMs),
      bestMedal:
        first.result.elapsedMs <= replay.result.elapsedMs
          ? first.result.medal
          : replay.result.medal,
      bestPearlCount: 6,
    });

    evidence.stage = 'mixed-course cleanup';
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
      race: {
        courseId: 'sunlit-shoals',
        checkpointIndex: 0,
        pearlCount: 0,
        result: null,
      },
    });
    await expectHealthyAudio();
    await page.getByRole('button', { name: 'Pause run' }).click();
    await page.getByRole('button', { name: 'Return to title' }).click();
    await screen(page, 'title');
    await expectIdle(page);
    await expectHealthyAudio();
    evidence.title = await snapshot(page);
    expect(evidence.title).toMatchObject({
      preferences,
      player: null,
      race: null,
      collectedPearlIds: [],
      audio: { activeEffects: 0, activeAmbience: 0, ownedNodes: 1 },
    });
    expect(await stored(page, progressKey)).toEqual(progress);
    expect(await stored(page, settingsKey)).toEqual(preferences);
    expect(oscillators.size).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    evidence.stage = 'native navigation disposal';
    const disposalKey = 'reef-rush-test.pagehide';
    // Chromium drops CDP audio notifications while unloading a document. Retain
    // only its actual read-only snapshot, without synthesizing lifecycle events.
    await page.evaluate((key) => {
      const read = window.__REEF_RUSH_TEST__!.getSnapshot;
      window.addEventListener(
        'pagehide',
        (event) =>
          sessionStorage.setItem(
            key,
            JSON.stringify({ persisted: event.persisted, state: read() }),
          ),
        { once: true },
      );
    }, disposalKey);
    await page.reload();
    evidence.disposal = await page.evaluate((key) => {
      const observed: unknown = JSON.parse(
        sessionStorage.getItem(key) ?? 'null',
      );
      sessionStorage.removeItem(key);
      return observed;
    }, disposalKey);
    expect(evidence.disposal).toMatchObject({
      persisted: false,
      state: {
        lifecycle: 'disposed',
        cleanupError: null,
        player: null,
        race: null,
        collectedPearlIds: [],
        resources: {
          canvases: 0,
          rafChains: 0,
          pendingCleanup: 0,
          scene: null,
        },
        audio: {
          status: 'disposed',
          contextState: null,
          ownsContext: false,
          ownedNodes: 0,
          activeEffects: 0,
          activeAmbience: 0,
          pendingCleanup: false,
          cleanupErrors: [],
          observerErrors: [],
        },
      },
    });
    await screen(page, 'title');
    await expectIdle(page);
    expect(created.size).toBe(1);
    expect(await stored(page, progressKey)).toEqual(progress);
    expect(await stored(page, settingsKey)).toEqual(preferences);
    await page.getByRole('button', { name: 'Dive in' }).click();
    await expect(loadFinal).toBeEnabled();
    expect(errors).toEqual([]);
    evidence.stage = 'complete';
  } finally {
    const evidencePath = testInfo.outputPath('native-blacksmoker.json');
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          ...evidence,
          screenshotPath,
          requests,
          errors,
          warnings,
          audio: {
            created: [...created],
            lastObservedLive: [...live],
            closedEvents: [...closed],
            oscillatorCount: oscillators.size,
          },
        },
        null,
        2,
      ),
    );
    await testInfo.attach('Native earned Blacksmoker evidence', {
      path: evidencePath,
      contentType: 'application/json',
    });
    console.info(
      `Native Blacksmoker evidence: ${evidencePath}; active screenshot: ${screenshotPath}`,
    );
    await cdp.detach();
  }
});
