import { test, expect } from '@playwright/test';
import { USERS } from '../seed.js';
import { login, nextPhone, pick } from './helpers.js';

test('a phone enquiry is booked in and becomes an order', async ({ page }) => {
  const name = `Priya Enquiry ${Date.now() % 10000}`;
  await login(page, 'operations');

  await page.goto('/enquiries/new');
  await page.getByLabel('Phone').fill(nextPhone());
  await page.getByLabel('Name').fill(name);
  await pick(page.getByRole('checkbox', { name: 'Blouse' }));
  await pick(page.getByRole('radio', { name: 'Instagram' }));
  await page.getByRole('button', { name: 'Save enquiry' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const enquiryUrl = page.url();

  // A consultation tomorrow at the first free time.
  await page.getByRole('link', { name: 'Book appointment' }).first().click();
  await pick(page.getByRole('radio', { name: USERS.designer.name }));
  await pick(page.getByRole('radio', { name: 'Tomorrow' }));
  await pick(page.getByRole('radio', { name: /^\d{1,2}:\d{2} (am|pm)$/ }).first());
  await page.getByRole('button', { name: /^Book for / }).click();
  await expect(page.getByText('Booked')).toBeVisible();

  // Convert: the caller becomes a customer and New order opens with them filled in.
  await page.goto(enquiryUrl);
  await page.getByRole('button', { name: 'Convert to order' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(`We'll add ${name} as a customer.`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(`From enquiry: ${name}`)).toBeVisible();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
});
