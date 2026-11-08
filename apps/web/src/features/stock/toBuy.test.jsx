import { test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { todayYmd } from '../../test/orders.js';
import { asFrontDesk } from '../../test/billing.js';
import { expenseFixture } from '../../test/expenses.js';
import { postsTo, requestFixture, requestsAre, stockAre, stockItemFixture } from '../../test/stock.js';

afterEach(() => vi.restoreAllMocks());

const need = (garmentNo, quantity = 144000) => ({ garmentId: `g${garmentNo.slice(-2)}`, garmentNo, orderId: 'o12', quantity });
const silk = { id: 's1', name: 'Red silk', usageUnit: 'm', purchaseUnit: 'roll', factor: 6000 };
const vendor = { id: 'v1', name: 'Sharma Textiles' };

// Types by pasting: a long form typed key by key is slow on a busy machine.
async function fill(input, text) {
  await userEvent.click(input);
  await userEvent.paste(text);
}

const rowOf = (text) => screen.getByText(text).closest('[data-request]');

test('to-buy lists one row per item with who it is for', async () => {
  asFrontDesk();
  stockAre();
  requestsAre({
    open: [
      requestFixture({ id: 'r1', stockItem: silk, quantity: 6000, reason: 'shortfall', needs: [need('VS/ORD/2627/0012-01', 3000), need('VS/ORD/2627/0012-02', 3000)] }),
      requestFixture({ id: 'r2', reason: 'low_stock', status: 'ordered', vendor }),
      requestFixture({ id: 'r3', stockItem: { ...silk, id: 's3', name: 'Lining', purchaseUnit: 'm', factor: 1000 }, quantity: 2500 }),
    ],
  });
  renderApp('/stock?tab=to-buy');
  const first = (await screen.findByText('Red silk — 6 m (1 roll)')).closest('[data-request]');
  expect(within(first).getByText('For VS/ORD/2627/0012-01, -02')).toBeInTheDocument();
  expect(within(first).getByText('To order')).toBeInTheDocument();
  const second = rowOf('Gold buttons — 288 piece (2 packet)');
  expect(within(second).getByText('Running low')).toBeInTheDocument();
  expect(within(second).getByText('Ordered from Sharma Textiles')).toBeInTheDocument();
  expect(within(second).queryByRole('button', { name: 'Mark ordered' })).toBeNull();
  const third = rowOf('Lining — 2.5 m');
  expect(within(third).getByText('Added by hand')).toBeInTheDocument();
  expect(within(third).getByRole('button', { name: 'Receive delivery' })).toBeInTheDocument();
  expect(within(third).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
});

test('order more suggests whole packets', async () => {
  asFrontDesk();
  const buttons = stockItemFixture({
    id: 's2', name: 'Gold buttons', usageUnit: 'piece', purchaseUnit: 'packet', factor: 144000, step: 1000,
    onHand: 20000, reserved: 0, free: 20000, reorderLevel: 50000, low: true,
  });
  stockAre({ items: [buttons], low: [buttons] });
  const posts = postsTo('/v1/stock/requests', () => HttpResponse.json({ request: requestFixture() }, { status: 201 }));
  renderApp('/stock');
  await userEvent.click(await screen.findByRole('button', { name: 'Order more' }));
  const dialog = await screen.findByRole('dialog');
  // Free 20 pieces, twice the level is 100: 80 more is one packet of 144.
  expect(within(dialog).getByText('1 packet')).toBeInTheDocument();
  expect(within(dialog).getByText('= 144 piece')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'More' }));
  expect(within(dialog).getByText('= 288 piece')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Add to list' }));
  await waitFor(() => expect(posts.map((p) => p.body)).toEqual([{ stockItemId: 's2', quantity: 288000, reason: 'low_stock', note: '' }]));
});

test('marking ordered keeps the vendor', async () => {
  asFrontDesk();
  stockAre();
  requestsAre({ open: [requestFixture()] });
  server.use(http.get('/v1/vendors', () => HttpResponse.json({ items: [{ ...vendor, active: true }], nextCursor: null })));
  const posts = postsTo('/v1/stock/requests/r1/order', (n, body) =>
    HttpResponse.json({ request: requestFixture({ status: 'ordered', vendor, version: 1, note: body.note }) }));
  renderApp('/stock?tab=to-buy');
  await userEvent.click(await screen.findByRole('button', { name: 'Mark ordered' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('textbox', { name: 'Ordered from (optional)' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Sharma Textiles' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Mark ordered' }));
  await waitFor(() => expect(posts.map((p) => p.body)).toEqual([{ version: 0, vendorId: 'v1', note: '' }]));
});

test('receiving sends usage milli-units, the payment and one Idempotency-Key', async () => {
  asFrontDesk();
  stockAre();
  requestsAre({ open: [requestFixture({ status: 'ordered', vendor })] });
  const posts = postsTo('/v1/stock/requests/r1/receive', (n) =>
    n === 1
      ? HttpResponse.error()
      : HttpResponse.json({ request: requestFixture({ status: 'received' }), item: stockItemFixture(), expense: { id: 'e31', number: 'EXP/2627/0031' } }, { status: 201 }));
  renderApp('/stock?tab=to-buy');
  await userEvent.click(await screen.findByRole('button', { name: 'Receive delivery' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('How much arrived?')).toBeInTheDocument();
  expect(within(dialog).getByText('2 packet')).toBeInTheDocument();
  expect(within(dialog).getByText('= 288 piece')).toBeInTheDocument();
  expect(within(dialog).getByText('Sharma Textiles')).toBeInTheDocument();
  await fill(within(dialog).getByLabelText('How much did you pay?'), '500');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save delivery of ₹500.00' }));
  expect(await within(dialog).findByText(/Cannot reach the server/)).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save delivery of ₹500.00' }));
  expect(await screen.findByText('Stock added and expense EXP/2627/0031 saved')).toBeInTheDocument();
  expect(posts).toHaveLength(2);
  expect(posts[1].key).toBe(posts[0].key);
  expect(posts[1].body).toEqual({
    quantity: 288000, date: todayYmd(), total: 50000, mode: 'cash', reference: '', payee: { vendorId: 'v1', name: 'Sharma Textiles' }, gst: null, attachments: [],
  });
});

test('a GST bill on a delivery uses the expense GST section', async () => {
  asFrontDesk();
  stockAre();
  requestsAre({ open: [requestFixture()] });
  const posts = postsTo('/v1/stock/requests/r1/receive', () =>
    HttpResponse.json({ request: requestFixture({ status: 'received' }), item: stockItemFixture(), expense: { id: 'e31', number: 'EXP/2627/0031' } }, { status: 201 }));
  renderApp('/stock?tab=to-buy');
  await userEvent.click(await screen.findByRole('button', { name: 'Receive delivery' }));
  const dialog = await screen.findByRole('dialog');
  await fill(within(dialog).getByLabelText('How much did you pay?'), '1180');
  await fill(within(dialog).getByLabelText('Paid to'), 'Lakshmi Textiles');
  await userEvent.click(within(dialog).getByRole('switch', { name: 'Has a GST bill?' }));
  await fill(within(dialog).getByLabelText('Supplier GSTIN'), '29ABCDE1234F1Z5');
  await fill(within(dialog).getByLabelText('Bill number'), 'A/12');
  expect(within(dialog).getByText('Before GST ₹1,000.00')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save delivery of ₹1,180.00' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].body.gst).toEqual({ billNo: 'A/12', billDate: todayYmd(), rateBp: 1800, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, itcEligible: true });
  expect(posts[0].body.payee).toMatchObject({ name: 'Lakshmi Textiles', gstin: '29ABCDE1234F1Z5', stateCode: '29' });
});

test('undo delivery needs a reason and explains a used delivery', async () => {
  asFrontDesk();
  stockAre();
  const receipt = (date) => ({ quantity: 288000, date, expenseId: 'e31', value: 50000 });
  requestsAre({
    received: [
      requestFixture({ id: 'r9', status: 'received', receipt: receipt('2026-11-05'), version: 2 }),
      requestFixture({ id: 'r8', status: 'received', receipt: receipt('2026-11-01'), version: 2 }),
    ],
  });
  const posts = postsTo('/v1/stock/requests/r9/undo', () =>
    HttpResponse.json({ error: { code: 'RECEIPT_USED', message: 'Some of this delivery has been used or counted. Count the stock instead.' } }, { status: 422 }));
  renderApp('/stock?tab=to-buy');
  await userEvent.click(await screen.findByRole('radio', { name: 'Received' }));
  const undo = await screen.findAllByRole('button', { name: 'Undo delivery' });
  // Only the latest delivery of an item can be undone.
  expect(undo).toHaveLength(1);
  expect(undo[0].closest('[data-request]')).toHaveAttribute('data-request', 'r9');
  await userEvent.click(undo[0]);
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('The stock comes back out and the expense is voided.')).toBeInTheDocument();
  const confirm = within(dialog).getByRole('button', { name: 'Yes, undo delivery' });
  expect(confirm).toBeDisabled();
  await fill(within(dialog).getByRole('textbox', { name: 'Why undo it?' }), 'Wrong item delivered');
  await userEvent.click(confirm);
  expect(await within(dialog).findByText('Some of this delivery has been used or counted. Count the stock instead.')).toBeInTheDocument();
  expect(posts.map((p) => p.body)).toEqual([{ version: 2, reason: 'Wrong item delivered' }]);
});

test('a purchase expense links back to stock and cannot be voided', async () => {
  asFrontDesk();
  server.use(
    http.get('/v1/expenses/e31', () =>
      HttpResponse.json({ expense: expenseFixture({ id: 'e31', source: 'purchase', category: { key: 'material_purchase', label: 'Material purchase' } }) })),
  );
  renderApp('/expenses/e31');
  expect(await screen.findByText('From a stock delivery')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'See deliveries in Stock' })).toHaveAttribute('href', '/stock?tab=to-buy&status=received');
  expect(screen.queryByRole('button', { name: 'Void expense' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Edit' })).toBeInTheDocument();
});
