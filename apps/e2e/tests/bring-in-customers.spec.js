import { test, expect } from '@playwright/test';
import { login } from './helpers.js';

test('old customers come in from a filled template, with the bad row left out', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/imports');
  const card = page.getByRole('region', { name: 'Customers' });

  // The template downloads as Excel.
  const downloading = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Download template' }).click();
  expect((await downloading).suggestedFilename()).toBe('Customers template.xlsx');

  // Five old customers, one with a short phone number.
  const stamp = Date.now() % 100000;
  const rows = ['Name,Mobile,Email,Email OK?,How consent was given'];
  for (let i = 0; i < 5; i++) {
    const phone = i === 2 ? '98765' : `97400${String(stamp + i).padStart(5, '0').slice(-5)}`;
    rows.push(`Old Customer ${stamp}-${i},${phone},,No,`);
  }
  await card.getByLabel('Upload filled file').setInputFiles({
    name: 'customers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(rows.join('\n'), 'utf8'),
  });

  await expect(page.getByText('4 ready to add')).toBeVisible();
  await expect(page.getByText('1 need fixing')).toBeVisible();
  await expect(page.getByText(/^Row 4 · Old Customer .* — .*'98765'/)).toBeVisible();
  await page.getByRole('button', { name: 'Add 4 customers' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Add/ }).click();
  await expect(page.getByText(/^Added 4/)).toBeVisible();

  await page.goto('/customers');
  await page.getByLabel(/Search/).fill(`Old Customer ${stamp}`);
  await expect(page.getByText(new RegExp(`Old Customer ${stamp}-`))).toHaveCount(4);
});
