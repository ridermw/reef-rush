import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import kelpworks from '../../src/content/courses/kelpworks';
import {
  emptyProgress,
  updateProgress,
} from '../../src/game/progression/progress';
import { driveCourseByKeyboard } from '../fixtures/courseKeyboard';
import {
  driveSunlit,
  expectIdle,
  loadSunlit,
  progressKey,
  screen,
  snapshot,
  timeLabel,
} from './acceptance-helpers';

test.use({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 0.5 });
test.describe.configure({ retries: 0 });

async function savedProgress(page: Page): Promise<unknown> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown,
    progressKey,
  );
}

test('earned Sunlit then three consecutive native Kelpworks medals save all actual IDs', async ({
  page,
}, testInfo) => {
  test.setTimeout(660_000);
  const runs: Array<
    Awaited<ReturnType<typeof driveCourseByKeyboard>> & { saved: unknown }
  > = [];
  await page.goto('./');
  expect(await savedProgress(page)).toBeNull();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('checkbox', { name: 'Mouse steering' }).uncheck();
  await dialog.getByRole('checkbox', { name: 'Reduced effects' }).check();
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await loadSunlit(page);
  const sunlitResult = await driveSunlit(page);
  expect(sunlitResult.medal).not.toBeNull();
  let progress = updateProgress(emptyProgress(), sunlitResult);
  await expect.poll(() => savedProgress(page)).toEqual(progress);
  await page.getByRole('button', { name: 'Choose another course' }).click();
  await expectIdle(page);
  await expect(
    page.getByRole('button', { name: 'Locked: Blacksmoker Run', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Load Kelpworks', exact: true })
    .click();

  try {
    for (let run = 0; run < 3; run++) {
      await screen(page, 'playing');
      expect(await snapshot(page)).toMatchObject({
        preferences: { mouseSteering: false },
        collectedPearlIds: [],
        race: {
          courseId: kelpworks.courseId,
          checkpointIndex: 0,
          pearlCount: 0,
          result: null,
        },
      });
      const finish = await driveCourseByKeyboard(page, kelpworks);
      await expect(page.locator('.results-time')).toHaveText(
        timeLabel(finish.result.elapsedMs),
      );
      await expect(
        page.getByText('5 / 5 pearls', { exact: true }),
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
      await expect.poll(() => savedProgress(page)).toEqual(progress);
      runs.push({ ...finish, saved: await savedProgress(page) });
      if (run < 2) {
        await page
          .getByRole('button', { name: 'Race again', exact: true })
          .click();
      }
    }
  } finally {
    const evidencePath = testInfo.outputPath('native-course-medals.json');
    await writeFile(
      evidencePath,
      JSON.stringify({ sunlitResult, runs }, null, 2),
    );
    await testInfo.attach('Three consecutive native Kelpworks measurements', {
      path: evidencePath,
      contentType: 'application/json',
    });
    console.info(`Native three-run evidence: ${evidencePath}`);
    console.info(
      `Native three-run measurements: ${JSON.stringify(
        runs.map(({ keyPolicy, ...run }) => ({
          ...run,
          policyObservations: keyPolicy.length,
        })),
      )}`,
    );
  }
  expect(runs).toHaveLength(3);
  for (const run of runs) {
    expect(run.checkpoints).toEqual([1, 2, 3, 4, 5]);
    expect(run.collectedPearlIds).toEqual(kelpworks.pearls.map(({ id }) => id));
  }
  // Evaluate the whole fixed sequence, not a retry-until-medal loop.
  expect(runs.map(({ result }) => result.medal)).toEqual([
    expect.stringMatching(/^(gold|silver|bronze)$/),
    expect.stringMatching(/^(gold|silver|bronze)$/),
    expect.stringMatching(/^(gold|silver|bronze)$/),
  ]);
  await page.getByRole('button', { name: 'Choose another course' }).click();
  await expectIdle(page);
  await expect(
    page.getByRole('button', { name: 'Load Blacksmoker Run', exact: true }),
  ).toBeEnabled();
  expect(await savedProgress(page)).toEqual(progress);
});
