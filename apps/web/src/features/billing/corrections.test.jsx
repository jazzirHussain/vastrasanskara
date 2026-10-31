import { test, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, customerFixture } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { orderDetailFixture } from '../../test/orders.js';
import { asFrontDesk, asOwner, issuedFixture, orderMoney } from '../../test/billing.js';

afterEach(() => vi.restoreAllMocks());

function showBill(fields) {
  const invoice = issuedFixture(fields);
  server.use(
    http.get('/v1/billing/invoices/inv1', () => HttpResponse.json({ invoice })),
    http.get('/v1/billing/documents/:id/pdf', () => HttpResponse.json({ status: 'pending' })),
  );
  return invoice;
}

async function openMore(itemName) {
  await userEvent.click(await screen.findByRole('button', { name: 'More' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: itemName }));
  return screen.findByRole('dialog');
}

const receiptRow = {
  id: 'r1',
  type: 'receipt',
  number: 'RCPT/2627/0004',
  date: '2026-10-29',
  label: 'Payment received (upi)',
  debit: 0,
  credit: 200000,
  balance: 0,
  status: 'issued',
};

function customerPage({ held = 0, unassigned = held, rows = [] } = {}) {
  server.use(
    http.get('/v1/customers/c1', () => HttpResponse.json(customerFixture())),
    http.get('/v1/customers/c1/measurements', () => HttpResponse.json({ items: [] })),
    http.get('/v1/billing/customers/c1/summary', () =>
      HttpResponse.json({ billed: 0, received: held, credited: 0, refunded: 0, outstanding: 0, overdue: 0, advanceHeld: held, advanceUnassigned: unassigned }),
    ),
    http.get('/v1/billing/customers/c1/ledger', () => HttpResponse.json({ items: rows, nextCursor: null })),
  );
}

test('cancel bill needs a reason and says payments become advance', async () => {
  asOwner();
  const invoice = showBill();
  const posts = [];
  server.use(
    http.post('/v1/billing/invoices/inv1/cancel', async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json({ invoice: { ...invoice, status: 'cancelled', cancellation: { reason: 'Wrong customer', at: 'x' } } });
    }),
  );
  renderApp('/bills/inv1');
  const dialog = await openMore('Cancel bill');
  expect(
    within(dialog).getByText('Payments on this bill will be kept as advance for Asha Rao. The bill number stays, marked cancelled.'),
  ).toBeInTheDocument();
  const confirm = within(dialog).getByRole('button', { name: 'Yes, cancel the bill' });
  expect(confirm).toBeDisabled();
  await userEvent.type(within(dialog).getByLabelText('Why is it being cancelled?'), 'Wrong customer');
  await userEvent.click(confirm);
  await expect.poll(() => posts).toEqual([{ reason: 'Wrong customer' }]);
});

test('a locked month offers a credit note instead of cancel', async () => {
  asOwner();
  showBill({ monthLocked: true });
  renderApp('/bills/inv1');
  await userEvent.click(await screen.findByRole('button', { name: 'More' }));
  expect(await screen.findByRole('menuitem', { name: 'Month locked — use a credit note' })).toBeDisabled();
  expect(screen.getByRole('menuitem', { name: 'Reduce this bill (credit note)' })).toBeEnabled();
});

test('a bill with a credit note cannot be cancelled', async () => {
  asOwner();
  showBill({ creditNotes: [{ id: 'cn1', number: 'CN/2627/0001', date: '2026-10-29', total: 10500, lines: [] }] });
  renderApp('/bills/inv1');
  await userEvent.click(await screen.findByRole('button', { name: 'More' }));
  expect(await screen.findByRole('menuitem', { name: 'Has a credit note — cannot cancel' })).toBeDisabled();
});

test('the last of a line takes exactly the GST left on it', async () => {
  asOwner();
  const invoice = issuedFixture();
  const line = invoice.lines[0];
  // An earlier note took all but ₹1 of the line, and a little more of its GST than the rate gives.
  const earlier = { key: line.key, taxable: line.taxable - 100, cgst: line.cgst - 1, sgst: line.sgst - 1, igst: 0 };
  showBill({ creditNotes: [{ id: 'cn1', number: 'CN/2627/0001', date: '2026-10-29', total: 0, lines: [earlier] }] });
  renderApp('/bills/inv1');
  const dialog = await openMore('Reduce this bill (credit note)');
  await userEvent.type(within(dialog).getByLabelText(/Reduce by ₹/), '1');
  expect(within(dialog).getByText('GST ₹0.02')).toBeInTheDocument();
});

test('a credit note for part of a line previews the GST', async () => {
  asOwner();
  showBill();
  const posts = [];
  server.use(
    http.post('/v1/billing/invoices/inv1/credit-notes', async ({ request }) => {
      posts.push({ body: await request.json(), key: request.headers.get('Idempotency-Key') });
      return HttpResponse.json(
        {
          creditNote: { id: 'cn1', number: 'CN/2627/0001', totals: { total: 105000 }, pdf: { status: 'pending' } },
          warnings: [{ code: 'CORRECTION_DEADLINE_NEAR', deadline: '2026-11-30' }],
        },
        { status: 201 },
      );
    }),
  );
  renderApp('/bills/inv1');
  const dialog = await openMore('Reduce this bill (credit note)');
  await userEvent.click(within(dialog).getByRole('radio', { name: 'Some lines' }));
  await userEvent.type(within(dialog).getByLabelText(/Reduce by ₹/), '1000');
  expect(within(dialog).getByText('GST ₹50.00')).toBeInTheDocument();
  expect(within(dialog).getByText('Credit note total ₹1,050.00')).toBeInTheDocument();
  await userEvent.type(within(dialog).getByLabelText('Why is the bill being reduced?'), 'Price agreed lower');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Issue credit note of ₹1,050.00' }));
  expect(await within(dialog).findByText('Credit note CN/2627/0001 saved')).toBeInTheDocument();
  expect(within(dialog).getByText(/30 November 2026/)).toBeInTheDocument();
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toEqual({ reason: 'Price agreed lower', full: false, lines: [{ key: 'g-g1', taxable: 100000 }] });
  expect(posts[0].key).toBeTruthy();
});

test('a line cannot be reduced by more than is left', async () => {
  asOwner();
  showBill();
  renderApp('/bills/inv1');
  const dialog = await openMore('Reduce this bill (credit note)');
  await userEvent.click(within(dialog).getByRole('radio', { name: 'Some lines' }));
  await userEvent.type(within(dialog).getByLabelText(/Reduce by ₹/), '2500');
  expect(within(dialog).getByText('The most you can reduce this line by is ₹2,000.00.')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Enter the amounts' })).toBeDisabled();
});

async function openRefund(held = 200000) {
  asOwner();
  customerPage({ held });
  renderApp('/customers/c1');
  const money = await screen.findByRole('region', { name: 'Money' });
  await userEvent.click(await within(money).findByRole('button', { name: 'Give refund' }));
  return screen.findByRole('dialog');
}

test('a refund cannot be more than is held', async () => {
  const dialog = await openRefund(200000);
  await userEvent.type(within(dialog).getByLabelText('Amount (₹)'), '3000');
  expect(within(dialog).getByText('The most you can refund is ₹2,000.00.')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Enter the amount' })).toBeDisabled();
});

test('a refund saves with one key and shows its voucher number', async () => {
  const posts = [];
  server.use(
    http.post('/v1/billing/refunds', async ({ request }) => {
      posts.push({ body: await request.json(), key: request.headers.get('Idempotency-Key') });
      return HttpResponse.json({ refund: { id: 'rf1', number: 'RF/2627/0001', amount: 100000 } }, { status: 201 });
    }),
    http.get('/v1/billing/documents/:id/pdf', () => HttpResponse.json({ status: 'pending' })),
  );
  const dialog = await openRefund(200000);
  await userEvent.type(within(dialog).getByLabelText('Amount (₹)'), '1000');
  await userEvent.click(within(dialog).getByRole('button', { name: 'UPI' }));
  await userEvent.type(within(dialog).getByLabelText('Why is it being refunded?'), 'Order called off');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Refund ₹1,000.00' }));
  expect(await within(dialog).findByText('Refund RF/2627/0001 saved')).toBeInTheDocument();
  expect(posts[0].body).toMatchObject({ customerId: 'c1', orderId: null, amount: 100000, mode: 'upi', reason: 'Order called off' });
  expect(posts[0].key).toBeTruthy();
});

test('a cancelled order pre-fills the scheduled refund', async () => {
  asOwner();
  server.use(http.get('/v1/orders/o1', () => HttpResponse.json(orderDetailFixture({ status: 'cancelled' }))));
  orderMoney({ advanceHeld: 200000, refundSuggestion: { held: 200000, refundPercent: 50, suggested: 100000 } });
  renderApp('/orders/o1');
  const panel = await screen.findByRole('region', { name: 'Money' });
  expect(await within(panel).findByText('Refund due ₹1,000.00 (50% of the advance)')).toBeInTheDocument();
  await userEvent.click(within(panel).getByRole('button', { name: 'Give refund' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText('Amount (₹)')).toHaveValue('1000');
});

test('a payment can be cancelled from the customer money, with a reason', async () => {
  asOwner();
  customerPage({ rows: [receiptRow] });
  const posts = [];
  server.use(
    http.post('/v1/billing/payments/r1/cancel', async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json({ receipt: { id: 'r1', status: 'cancelled' } });
    }),
  );
  renderApp('/customers/c1');
  await userEvent.click(await screen.findByRole('button', { name: 'Cancel payment' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/The money comes off any bills it paid\./)).toBeInTheDocument();
  const confirm = within(dialog).getByRole('button', { name: 'Yes, cancel the payment' });
  expect(confirm).toBeDisabled();
  await userEvent.type(within(dialog).getByLabelText('Why is it being cancelled?'), 'Entered twice');
  await userEvent.click(confirm);
  await expect.poll(() => posts).toEqual([{ reason: 'Entered twice' }]);
});

test('a customer refund offers only the advance with no order', async () => {
  asOwner();
  customerPage({ held: 200000, unassigned: 0 });
  renderApp('/customers/c1');
  const money = await screen.findByRole('region', { name: 'Money' });
  await within(money).findByText('No bills or payments yet.');
  expect(within(money).queryByRole('button', { name: 'Give refund' })).toBeNull();
});

test('advance on an open order can be refunded from the order', async () => {
  asOwner();
  server.use(http.get('/v1/orders/o1', () => HttpResponse.json(orderDetailFixture())));
  orderMoney({ advanceHeld: 200000, refundSuggestion: { held: 200000, refundPercent: 0, suggested: 0 } });
  renderApp('/orders/o1');
  const panel = await screen.findByRole('region', { name: 'Money' });
  await userEvent.click(await within(panel).findByRole('button', { name: 'Give refund' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText('Amount (₹)')).toHaveValue('');
  expect(within(dialog).getByText(/₹2,000.00 now/)).toBeInTheDocument();
});

test('operations see no correction actions', async () => {
  asFrontDesk();
  showBill();
  renderApp('/bills/inv1');
  await screen.findByText('INV/2627/0001');
  expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
});

test('operations see no refund or cancel payment on a customer', async () => {
  asFrontDesk();
  customerPage({ held: 200000, rows: [receiptRow] });
  renderApp('/customers/c1');
  const money = await screen.findByRole('region', { name: 'Money' });
  await within(money).findByText('Payment (UPI)');
  expect(within(money).queryByRole('button', { name: 'Give refund' })).toBeNull();
  expect(within(money).queryByRole('button', { name: 'Cancel payment' })).toBeNull();
});
