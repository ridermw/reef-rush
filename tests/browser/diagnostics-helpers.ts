import { expect, type Locator, type Page } from '@playwright/test';

export async function openDiagnostics(page: Page) {
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Diagnostics', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

export function reading(dialog: Locator, label: string) {
  return dialog.getByText(label, { exact: true }).locator('..').locator('dd');
}

export async function readings(dialog: Locator) {
  return dialog.locator('dl > div').evaluateAll((rows) => {
    const entries: [string, string][] = rows.map((row) => {
      const label = row.querySelector('dt')?.textContent;
      const value = row.querySelector('dd')?.textContent;
      if (!label || value === undefined || value === null)
        throw new Error('Incomplete diagnostics reading.');
      return [label, value];
    });
    return Object.fromEntries(entries);
  });
}
