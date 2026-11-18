import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { USERS } from '../seed.js';
import { istDay, login, nextPhone } from './helpers.js';

const API = 'http://localhost:4100';
const rupees = (text) => Number(text.replace(/[^\d.]/g, ''));

/** Calls the API with the page's session (as the app does), failing the test on an error. */
async function call(page, method, path, body) {
  const r = await page.request.fetch(`${API}${path}`, {
    method,
    headers: { 'X-Requested-With': 'vs-app', 'Idempotency-Key': randomUUID(), Origin: 'http://localhost:4173' },
    data: body,
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

/** One issued bill this month, so Home has something to add up. */
async function issueABill(page) {
  const customer = await call(page, 'POST', '/v1/customers', { name: `Lata Home ${Date.now() % 10000}`, phone: nextPhone() });
  const designers = await call(page, 'GET', '/v1/designers');
  const designer = designers.items.find((d) => d.name === USERS.designer.name);
  const order = await call(page, 'POST', '/v1/orders', {
    customerId: customer.id,
    designerId: designer.id,
    pickupDate: istDay(30),
    garments: [{ type: 'blouse', description: 'Blouse', agreedPrice: 300000, quantity: 1 }],
  });
  const { invoice } = await call(page, 'POST', '/v1/billing/invoices/from-order', { orderId: order.id });
  await call(page, 'POST', `/v1/billing/invoices/${invoice.id}/issue`, { version: invoice.version });
}

test('the Billed figure on Home opens the bills that make it up', async ({ page }) => {
  await login(page, 'admin');
  await issueABill(page);
  // Home keeps each figure for a minute; Refresh asks for fresh ones.
  await page.getByRole('button', { name: 'Refresh' }).click();

  const tile = page.getByRole('link', { name: /^Billed/ });
  await expect(tile).toContainText(/₹[\d,]+\.\d\d/);
  await expect(tile).not.toContainText('₹0.00');
  const figure = rupees((await tile.textContent()).match(/₹[\d,]+\.\d\d/)[0]);
  expect(figure).toBeGreaterThan(0);

  await tile.click();
  await expect(page.getByRole('heading', { name: 'Billed' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Records' });
  await expect(list.getByRole('link').first()).toBeVisible();
  const rows = await list.getByRole('link').allTextContents();
  // Each row's amount is its last rupee figure; together they make the Home figure.
  const sum = rows.reduce((total, row) => total + rupees(row.match(/₹[\d,]+\.\d\d/g).at(-1)), 0);
  expect(Math.round(sum * 100)).toBe(Math.round(figure * 100));
  await expect(page.getByText(`${rows.length} record${rows.length === 1 ? '' : 's'}`)).toBeVisible();
});
