import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  mergeProgress,
  parseProgress,
  updateProgress,
  emptyProgress,
} from '../../src/game/progression/progress';
import {
  driveSunlit,
  loadSunlit,
  progressKey,
  screen,
  snapshot,
  wallInterval,
} from './acceptance-helpers';

test.use({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 0.5 });

async function seed(page: Page, raw: string) {
  await page.goto('./');
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key: progressKey,
    raw,
  });
  await page.reload();
}

async function openRecovery(page: Page) {
  await page
    .getByRole('button', { name: 'Saved progress', exact: true })
    .click({ timeout: 5000 });
  const dialog = page.getByRole('dialog', {
    name: 'Saved progress',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function backup(page: Page, raw: string, info: TestInfo) {
  const downloadEvent = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download backup', exact: true })
    .click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(
    'reef-rush-progress-backup-v1.json',
  );
  const path = info.outputPath('reef-rush-progress-backup-v1.json');
  await download.saveAs(path);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    format: 'reef-rush.progress-backup',
    version: 1,
    raw,
  });
  await info.attach('lossless-local-backup', {
    path,
    contentType: 'application/json',
  });
}

async function holdLock(owner: Page) {
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
}

async function pendingLock(page: Page, count: number) {
  await expect
    .poll(() =>
      page.evaluate(async (key) => {
        const locks = await navigator.locks.query();
        return locks.pending?.filter((lock) => lock.name === key).length ?? 0;
      }, progressKey),
    )
    .toBe(count);
}

test('native backup and acknowledged recovery retain a real Sunlit session record through reload', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const raw = '  {broken\n\ud800</script>\udfff\u0000';
  await seed(page, raw);
  await loadSunlit(page);
  const result = await driveSunlit(page);
  await expect(page.getByRole('status')).toContainText('could not save');
  expect(
    await page.evaluate((key) => localStorage.getItem(key), progressKey),
  ).toBe(raw);
  const dialog = await openRecovery(page);
  await expect(
    dialog.getByRole('button', { name: 'Replace invalid save' }),
  ).toBeDisabled();
  await backup(page, raw, info);
  await dialog.getByRole('checkbox', { name: /replace.*original/i }).check();
  await dialog.getByRole('button', { name: 'Replace invalid save' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    'Saved current session',
  );
  const expected = updateProgress(emptyProgress(), result);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown,
      progressKey,
    ),
  ).toEqual(expected);
  await dialog.getByRole('button', { name: 'Close saved progress' }).click();
  await expect(
    page.getByRole('button', { name: 'Saved progress', exact: true }),
  ).toBeFocused();
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.reload();
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown,
      progressKey,
    ),
  ).toEqual(expected);
  const retained = await openRecovery(page);
  await expect(retained.getByText(/valid saved progress/i)).toBeVisible();
  await expect(
    retained.getByRole('button', { name: 'Replace invalid save' }),
  ).toHaveCount(0);
  console.info(
    `Protected recovery: real result ${JSON.stringify(result)}; exact UTF-16 backup, replacement and reload retained.`,
  );
});

test('a native competing lock installs a valid record, aborts stale recovery and permits explicit ordinary merging', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const raw = '{broken: stale authorization';
  await seed(page, raw);
  await loadSunlit(page);
  const result = await driveSunlit(page);
  await expect(page.getByRole('status')).toContainText('could not save');
  const owner = await context.newPage();
  await holdLock(owner);
  await page.bringToFront();
  const dialog = await openRecovery(page);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Replace invalid save' }).click();
  await pendingLock(page, 1);
  const latest = parseProgress({
    version: 1,
    courses: {
      'sunlit-shoals': {
        bestElapsedMs: result.elapsedMs - 500,
        bestMedal: 'gold',
        bestPearlCount: 1,
      },
      kelpworks: {
        bestElapsedMs: 9876,
        bestMedal: 'silver',
        bestPearlCount: 3,
      },
    },
  });
  await owner.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: progressKey, value: latest },
  );
  await owner.close();
  await expect(dialog.getByRole('alert')).toContainText(/valid.*not replaced/i);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown,
      progressKey,
    ),
  ).toEqual(latest);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Retry saving' }).click();
  await expect(dialog.getByRole('status')).toContainText('Saved');
  const merged = mergeProgress(latest, updateProgress(emptyProgress(), result));
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown,
      progressKey,
    ),
  ).toEqual(merged);
  console.info(
    `Native stale recovery: real result ${JSON.stringify(result)}; newer valid save unchanged until explicit ordinary merge, latest records and session pearls retained.`,
  );
});

test('closing a confirmed recovery cancels a native pending lock and cannot write after release', async ({
  page,
  context,
}) => {
  const raw = '{broken: cancellation';
  await seed(page, raw);
  const owner = await context.newPage();
  await holdLock(owner);
  await page.bringToFront();
  const dialog = await openRecovery(page);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Replace invalid save' }).click();
  await pendingLock(page, 1);
  await expect(
    dialog.getByRole('button', { name: 'Replace invalid save' }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Download backup' }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close saved progress' }).click();
  await pendingLock(page, 0);
  await expect(page.getByRole('status')).toContainText('cancelled');
  await owner.close();
  // Acquiring the same native lock proves all earlier waiters have drained.
  await page.evaluate(
    (key) => navigator.locks.request(key, () => {}),
    progressKey,
  );
  expect(
    await page.evaluate((key) => localStorage.getItem(key), progressKey),
  ).toBe(raw);
  await expect(
    page.getByRole('button', { name: 'Saved progress', exact: true }),
  ).toBeFocused();
  const reopened = await openRecovery(page);
  await expect(reopened.getByRole('checkbox')).not.toBeChecked();
  console.info(
    'Native cancellation: pending request removed on close; lock released and reacquired, original invalid save unchanged.',
  );
});

test('future-version progress remains backup and guidance only', async ({
  page,
}, info) => {
  const raw = '{"version":99,"future":"\\ud800keep"}';
  await seed(page, raw);
  const dialog = await openRecovery(page);
  await expect(dialog.getByText(/newer or different version/i)).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Replace invalid save' }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Retry saving' }),
  ).toHaveCount(0);
  await backup(page, raw, info);
  await page.keyboard.press('Escape');
  expect(
    await page.evaluate((key) => localStorage.getItem(key), progressKey),
  ).toBe(raw);
});

test('paused recovery owns native controls, Escape and focus without resuming or changing the race', async ({
  page,
}) => {
  await seed(page, '{broken');
  await loadSunlit(page);
  await expect(
    page.getByRole('button', { name: 'Saved progress', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Pause run' }).click();
  await screen(page, 'paused');
  const before = await snapshot(page);
  for (const target of [
    'dialog',
    'close',
    'backup',
    'acknowledgment',
    'confirm',
  ]) {
    const dialog = await openRecovery(page);
    const ack = dialog.getByRole('checkbox');
    await ack.check();
    const control =
      target === 'dialog'
        ? dialog
        : target === 'acknowledgment'
          ? ack
          : dialog.getByRole('button', {
              name: {
                close: 'Close saved progress',
                backup: 'Download backup',
                confirm: 'Replace invalid save',
              }[target],
              exact: true,
            });
    await control.focus();
    await page.keyboard.press('Tab');
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Saved progress', exact: true }),
    ).toBeFocused();
    await wallInterval(page, 100);
    const after = await snapshot(page);
    expect(after.screen).toBe('paused');
    expect(after.frame.steps).toBe(before.frame.steps);
    expect(after.race).toEqual(before.race);
    expect(after.player).toEqual(before.player);
  }
});
