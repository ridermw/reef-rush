import { expect, test } from '@playwright/test';
import { parseProgress } from '../../src/game/progression/progress';
import {
  driveSunlit,
  expectDraw,
  expectIdle,
  loadSunlit,
  progressKey,
  snapshot,
} from './acceptance-helpers';

test.use({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 0.5 });

test('real keyboard Sunlit finish and queued native save merge newer version 1 records', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await page.bringToFront();
  expect(
    await page.evaluate(() => {
      const hook = window.__REEF_RUSH_TEST__;
      const a = hook?.getSnapshot();
      const b = hook?.getSnapshot();
      return {
        keys: Object.keys(hook ?? {}),
        frozen:
          Object.isFrozen(hook) &&
          Object.isFrozen(a) &&
          Object.isFrozen(a?.frame),
        copies: a !== b && a?.frame !== b?.frame,
      };
    }),
  ).toEqual({ keys: ['getSnapshot'], frozen: true, copies: true });
  // A second real same-origin page owns the native lock, not a gameplay hook.
  const lockOwner = await context.newPage();
  await lockOwner.goto('./');
  await lockOwner.evaluate(
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
  await page.bringToFront();
  await loadSunlit(page);
  console.info(`WebGL framebuffer: ${JSON.stringify(await expectDraw(page))}`);
  const result = await driveSunlit(page);
  await expect(page.getByRole('status')).toContainText('save pending');
  expect(
    await page.evaluate((key) => localStorage.getItem(key), progressKey),
  ).toBeNull();
  await expect
    .poll(() =>
      page.evaluate(async (key) => {
        const locks = await navigator.locks.query();
        return {
          held: locks.held?.filter((lock) => lock.name === key).length,
          pending: locks.pending?.filter((lock) => lock.name === key).length,
        };
      }, progressKey),
    )
    .toEqual({ held: 1, pending: 1 });
  // Valid fixture arrives AFTER host startup and AFTER the save is queued.
  // Independent min-time/max-medal/max-pearls must survive the eventual merge.
  const newer = parseProgress({
    version: 1,
    courses: {
      'sunlit-shoals': {
        bestElapsedMs: result.elapsedMs - 500,
        bestMedal: 'gold',
        bestPearlCount: 2,
      },
      kelpworks: {
        bestElapsedMs: 9876,
        bestMedal: 'silver',
        bestPearlCount: 3,
      },
    },
  });
  await lockOwner.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: progressKey, value: newer },
  );
  // Navigation/scene disposal does not wait for the outstanding save either.
  await page.getByRole('button', { name: 'Return to title' }).click();
  await expectIdle(page);
  await expect(page.getByRole('status')).toContainText('save pending');
  await lockOwner.close();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown,
        progressKey,
      ),
    )
    .toEqual({
      version: 1,
      courses: {
        'sunlit-shoals': {
          ...newer.courses['sunlit-shoals'],
          bestPearlCount: result.pearlCount,
        },
        kelpworks: newer.courses.kelpworks,
      },
    });
  await expect(page.getByRole('status')).toHaveCount(0);
  expect((await snapshot(page)).resources.pendingCleanup).toBe(0);
  await page.getByRole('button', { name: 'Dive in' }).click();
  await expect(page.getByRole('button', { name: /Kelpworks/ })).toBeDisabled();
  console.info(
    'Native Web Lock: results and title before release; closing owner released queued save; latest valid records merged.',
  );
  expect(errors).toEqual([]);
});

test('invalid raw storage survives an actual keyboard finish with a visible results notice', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const raw = 'invalid save: preserve these exact bytes';
  await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), {
    key: progressKey,
    raw,
  });
  await page.goto('./');
  await page.bringToFront();
  await loadSunlit(page);
  await driveSunlit(page);
  await expect(page.getByRole('status')).toContainText('could not save');
  await expect(page.getByRole('status')).toContainText(
    'Invalid existing save preserved',
  );
  expect(
    await page.evaluate((key) => localStorage.getItem(key), progressKey),
  ).toBe(raw);
  await page.getByRole('button', { name: 'Return to title' }).click();
  await expectIdle(page);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), progressKey),
  ).toBe(raw);
  console.info(
    'Invalid storage: exact raw value retained after real finish and teardown; results save-failure notice visible.',
  );
});
