import { test, expect } from '@playwright/test';
import { USERS } from '../seed.js';
import { istDay, login, nextPhone, pick, signedIn } from './helpers.js';

test('an order goes from the counter through production to a paid bill', async ({ page, browser }) => {
  // Production steps plus the background PDF take longer than the default journey.
  test.setTimeout(300_000);
  const name = `Asha Order ${Date.now() % 10000}`;
  await login(page, 'operations');

  // A new customer.
  await page.goto('/customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  const addDialog = page.getByRole('dialog');
  await addDialog.getByLabel('Name').fill(name);
  await addDialog.getByLabel('Phone').fill(nextPhone());
  await addDialog.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  // One blouse.
  await page.goto('/orders/new');
  await page.getByLabel('Find a customer').fill(name);
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await pick(page.getByRole('radio', { name: USERS.designer.name }));
  await page.getByRole('button', { name: 'Next: garments' }).click();
  await page.getByLabel('Garment type').selectOption('blouse');
  await page.getByLabel('Description').fill('Bridal blouse');
  await page.getByLabel('Price per piece (₹)').fill('2000');
  await page.getByRole('button', { name: 'Next: dates' }).click();
  await page.getByLabel('Pickup date').fill(istDay(30));
  await page.getByRole('button', { name: 'Next: review' }).click();
  await page.getByRole('button', { name: 'Take order' }).click();
  const taken = page.getByText(/^Order .+ taken$/);
  await expect(taken).toBeVisible();
  const orderNo = (await taken.textContent()).replace(/^Order (.+) taken$/, '$1');
  await expect(page.getByRole('heading', { name: orderNo, level: 1 })).toBeVisible();
  const orderUrl = page.url();

  // The designer takes the garment through every stage.
  const designer = await signedIn(browser, 'designer');
  await designer.goto(orderUrl);
  await expect(designer.getByRole('heading', { name: orderNo, level: 1 })).toBeVisible();
  for (let step = 0; step < 30; step++) {
    // Each stage is started, then marked done; the next step is always the garment's main button.
    const mark = designer.getByRole('button', { name: /^(Start .+|Mark .+ done)$/ });
    if ((await mark.count()) === 0) break;
    await mark.first().click();
    const dialog = designer.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
  }
  await expect(designer.getByText('Ready for pickup').first()).toBeVisible();
  await designer.context().close();

  // The counter bills it and takes the full amount.
  await page.goto(orderUrl);
  const money = page.getByRole('region', { name: 'Money' });
  await money.getByRole('button', { name: 'Create bill' }).click();
  await expect(page.getByRole('heading', { name: 'Draft bill', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await page.getByRole('dialog', { name: 'Issue bill' }).getByRole('button', { name: 'Issue bill' }).click();
  const issued = page.getByRole('dialog', { name: 'Bill issued' });
  await expect(issued.getByText(/^INV\/\d{4}\/\d+$/)).toBeVisible();
  await issued.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: /^INV\// })).toBeVisible();
  await page.getByRole('button', { name: 'Take payment' }).click();
  const pay = page.getByRole('dialog');
  // ₹2,000 + 5% GST.
  await pay.getByRole('button', { name: 'Save payment of ₹2,100.00' }).click();
  await expect(pay.getByText(/^Receipt .+ saved$/)).toBeVisible();
  await pay.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Paid').first()).toBeVisible();

  // The worker renders the bill's PDF in the background; Print / PDF turns on when it is ready.
  const print = page.getByRole('button', { name: 'Print / PDF' });
  await expect(print).toBeEnabled({ timeout: 150_000 });
  // The new tab goes to a short-lived signed link for the file (headless Chromium then
  // downloads it rather than showing it, so the link is fetched here to check it is the PDF).
  const opening = page.context().waitForEvent('request', (r) => r.url().includes('/v1/dev-files/'));
  await print.click();
  const pdf = await opening;
  const response = await page.request.get(pdf.url());
  expect(response.headers()['content-type']).toBe('application/pdf');
  expect((await response.body()).subarray(0, 5).toString()).toBe('%PDF-');
});
