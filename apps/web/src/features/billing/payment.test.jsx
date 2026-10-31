import { test, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { orderDetailFixture } from '../../test/orders.js';
import { asFrontDesk, issuedFixture, orderMoney } from '../../test/billing.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const receiptFixture = (fields = {}) => ({
  id: 'r1',
  type: 'receipt',
  status: 'issued',
  number: 'RCPT/2627/0004',
  date: '2026-10-30',
  amount: 200000,
  mode: 'cash',
  reference: '',
  receivedOn: null,
  note: '',
  receiptVoucher: null,
  pdf: { status: 'pending' },
  ...fields,
});

/** Records every POST /payments (body and Idempotency-Key) and answers with `reply`. */
function paymentsServer(reply = () => HttpResponse.json({ receipt: receiptFixture() }, { status: 201 })) {
  const posts = [];
  server.use(
    http.post('/v1/billing/payments', async ({ request }) => {
      posts.push({ body: await request.json(), key: request.headers.get('Idempotency-Key') });
      return reply(posts.length);
    }),
    http.get('/v1/billing/documents/:id/pdf', () => HttpResponse.json({ status: 'pending' })),
  );
  return posts;
}

async function openOrderDialog(buttonName) {
  server.use(http.get('/v1/orders/o1', () => HttpResponse.json(orderDetailFixture())));
  renderApp('/orders/o1');
  const panel = await screen.findByRole('region', { name: 'Money' });
  await userEvent.click(await within(panel).findByRole('button', { name: buttonName }));
  return screen.findByRole('dialog');
}

test('an advance pre-fills what is due and saves with one key', async () => {
  asFrontDesk();
  orderMoney({ advanceDue: 200000 });
  const posts = paymentsServer();
  const dialog = await openOrderDialog('Take advance');
  expect(within(dialog).getByLabelText('Amount (₹)')).toHaveValue('2000');
  expect(within(dialog).getByRole('button', { name: 'Cash' })).toHaveAttribute('aria-pressed', 'true');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save payment of ₹2,000.00' }));
  expect(await within(dialog).findByText('Receipt RCPT/2627/0004 saved')).toBeInTheDocument();
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toEqual({
    customerId: 'c1',
    orderId: 'o1',
    invoiceId: null,
    amount: 200000,
    mode: 'cash',
    reference: '',
    receivedOn: null,
    note: '',
  });
  expect(posts[0].key).toMatch(/^[0-9a-f-]{36}$/);
});

test('a retry after a network error reuses the key', async () => {
  asFrontDesk();
  orderMoney({ advanceDue: 200000 });
  const posts = paymentsServer((n) => (n === 1 ? HttpResponse.error() : HttpResponse.json({ receipt: receiptFixture() }, { status: 201 })));
  const dialog = await openOrderDialog('Take advance');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save payment of ₹2,000.00' }));
  expect(await within(dialog).findByText(/Cannot reach the server/)).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
  expect(await within(dialog).findByText('Receipt RCPT/2627/0004 saved')).toBeInTheDocument();
  expect(posts).toHaveLength(2);
  expect(posts[1].key).toBe(posts[0].key);
  expect(within(dialog).queryByText(/may already be saved/)).toBeNull();
});

test('paying more than the bill says the rest is kept as advance', async () => {
  asFrontDesk();
  const bill = issuedFixture();
  server.use(http.get('/v1/billing/invoices/inv1', () => HttpResponse.json({ invoice: bill })));
  const posts = paymentsServer();
  renderApp('/bills/inv1');
  await userEvent.click(await screen.findByRole('button', { name: 'Take payment' }));
  const dialog = await screen.findByRole('dialog');
  const amount = within(dialog).getByLabelText('Amount (₹)');
  expect(amount).toHaveValue('2100');
  expect(within(dialog).queryByText(/kept as advance/)).toBeNull();
  await userEvent.clear(amount);
  await userEvent.type(amount, '3000');
  expect(within(dialog).getByText('₹2,100.00 will pay the bill, ₹900.00 will be kept as advance.')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save payment of ₹3,000.00' }));
  await within(dialog).findByText("Receipt RCPT/2627/0004 saved");
  expect(posts[0].body).toMatchObject({ customerId: 'c1', invoiceId: 'inv1', amount: 300000 });
});

test('an advance above the order total shows the limit', async () => {
  asFrontDesk();
  orderMoney({ advanceDue: 200000 });
  paymentsServer(() =>
    HttpResponse.json({ error: { code: 'ADVANCE_EXCEEDS_TOTAL', message: 'x', details: { maxAmount: 150000 } } }, { status: 422 }),
  );
  const dialog = await openOrderDialog('Take advance');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save payment of ₹2,000.00' }));
  expect(await within(dialog).findByText('This is more than the order total. The most you can take now is ₹1,500.00.')).toBeInTheDocument();
});

test('the receipt number and voucher are shown after saving', async () => {
  asFrontDesk();
  orderMoney({ advanceDue: 200000 });
  paymentsServer(() =>
    HttpResponse.json(
      { receipt: receiptFixture({ receiptVoucher: { id: 'v1', number: 'RV/2627/0002', taxable: 190476, cgst: 4762, sgst: 4762, igst: 0 } }) },
      { status: 201 },
    ),
  );
  const dialog = await openOrderDialog('Take advance');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save payment of ₹2,000.00' }));
  expect(await within(dialog).findByText('Receipt RCPT/2627/0004 saved')).toBeInTheDocument();
  expect(within(dialog).getByText('A receipt voucher RV/2627/0002 with GST on the advance was also made.')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: /Preparing the PDF|Print/ })).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('cash needs no reference; UPI offers one', async () => {
  asFrontDesk();
  orderMoney({ advanceDue: 200000 });
  const posts = paymentsServer();
  const dialog = await openOrderDialog('Take advance');
  expect(within(dialog).queryByLabelText(/reference/i)).toBeNull();
  await userEvent.click(within(dialog).getByRole('button', { name: 'UPI' }));
  await userEvent.type(within(dialog).getByLabelText('UPI or card reference (optional)'), 'UTR123');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save payment of ₹2,000.00' }));
  await within(dialog).findByText("Receipt RCPT/2627/0004 saved");
  expect(posts[0].body).toMatchObject({ mode: 'upi', reference: 'UTR123' });
});

test('with a bill issued the order offers Take payment; with nothing left to bill it says so', async () => {
  asFrontDesk();
  orderMoney({
    hasUnbilled: false,
    billed: 210000,
    balanceDue: 110000,
    invoices: [{ id: 'inv0', number: 'INV/2627/0001', status: 'issued', total: 210000, balance: 110000 }],
  });
  server.use(http.get('/v1/orders/o1', () => HttpResponse.json(orderDetailFixture())));
  renderApp('/orders/o1');
  const panel = await screen.findByRole('region', { name: 'Money' });
  expect(await within(panel).findByText('Everything on this order is billed')).toBeInTheDocument();
  expect(within(panel).queryByRole('button', { name: 'Create bill' })).toBeNull();
  expect(within(panel).queryByRole('button', { name: 'Take advance' })).toBeNull();
  await userEvent.click(within(panel).getByRole('button', { name: 'Take payment' }));
  expect(await screen.findByLabelText('Amount (₹)')).toHaveValue('1100');
});

test('the dialog cannot be closed while the payment is being saved', async () => {
  asFrontDesk();
  orderMoney({ advanceDue: 200000 });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const posts = paymentsServer(async () => {
    await gate;
    return HttpResponse.json({ receipt: receiptFixture() }, { status: 201 });
  });
  const dialog = await openOrderDialog('Take advance');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save payment of ₹2,000.00' }));
  await vi.waitFor(() => expect(posts).toHaveLength(1));
  expect(document.querySelector('.mantine-Modal-close')).toBeNull();
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  release();
  expect(await within(dialog).findByText('Receipt RCPT/2627/0004 saved')).toBeInTheDocument();
});

test('after a network error the details are locked until Try again or Start again', async () => {
  asFrontDesk();
  orderMoney({ advanceDue: 200000 });
  const posts = paymentsServer((n) => (n === 1 ? HttpResponse.error() : HttpResponse.json({ receipt: receiptFixture() }, { status: 201 })));
  const dialog = await openOrderDialog('Take advance');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save payment of ₹2,000.00' }));
  await within(dialog).findByText(/Cannot reach the server/);
  expect(within(dialog).getByLabelText('Amount (₹)')).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'UPI' })).toBeDisabled();

  const warning = "The first payment may already be saved. Check the customer's payments before taking it again.";
  expect(within(dialog).queryByText(warning)).toBeNull();

  await userEvent.click(within(dialog).getByRole('button', { name: 'Start again' }));
  expect(within(dialog).queryByText(/Cannot reach the server/)).toBeNull();
  // A new payment gets a new key, so the first one, if it was saved, would not stop it.
  expect(within(dialog).getByText(warning)).toBeInTheDocument();
  const amount = within(dialog).getByLabelText('Amount (₹)');
  expect(amount).toBeEnabled();
  await userEvent.clear(amount);
  await userEvent.type(amount, '1500');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save payment of ₹1,500.00' }));
  await within(dialog).findByText('Receipt RCPT/2627/0004 saved');
  expect(posts[1].key).not.toBe(posts[0].key);
  expect(posts[1].body.amount).toBe(150000);
});

test('after part of an order is billed and paid, the action is Take advance for the rest', async () => {
  asFrontDesk();
  orderMoney({
    hasUnbilled: true,
    advanceDue: 80000,
    billed: 210000,
    balanceDue: 0,
    invoices: [{ id: 'inv0', number: 'INV/2627/0001', status: 'issued', total: 210000, balance: 0 }],
  });
  const posts = paymentsServer();
  const dialog = await openOrderDialog('Take advance');
  expect(within(dialog).getByLabelText('Amount (₹)')).toHaveValue('800');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save payment of ₹800.00' }));
  await within(dialog).findByText('Receipt RCPT/2627/0004 saved');
  expect(posts[0].body).toMatchObject({ orderId: 'o1', invoiceId: null, amount: 80000 });
});
