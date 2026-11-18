import { test, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { addDaysYmd } from '@vs/shared/fy.js';
import { server, asDesigner, customerFixture } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { asFrontDesk, asOwner } from '../../test/billing.js';
import { todayYmd } from '../../components/DateLabel.jsx';

afterEach(() => vi.restoreAllMocks());

const ago = (n) => addDaysYmd(todayYmd(), -n);

const owedRow = (fields = {}) => ({
  invoice: { id: 'inv1', number: 'INV/2627/0001', date: ago(20), dueDate: ago(12), total: 210000, balance: 150000 },
  customer: { id: 'c1', name: 'Asha Rao' },
  daysOverdue: 12,
  bucket: 'd0_30',
  ...fields,
});

/** Records every receivables query string and answers with `rows`. */
function receivables(rows = [owedRow()], totals = { count: rows.length, balance: 150000, overdue: 150000 }) {
  const queries = [];
  server.use(
    http.get('/v1/billing/receivables', ({ request }) => {
      queries.push(Object.fromEntries(new URL(request.url).searchParams));
      return HttpResponse.json({ items: rows, totals, nextCursor: null });
    }),
  );
  return queries;
}

test('money owed lists the oldest due first with late days', async () => {
  asFrontDesk();
  receivables(
    [
      owedRow(),
      owedRow({
        invoice: { id: 'inv2', number: 'INV/2627/0002', date: ago(3), dueDate: addDaysYmd(todayYmd(), 4), total: 50000, balance: 50000 },
        customer: { id: 'c2', name: 'Meera Iyer' },
        daysOverdue: 0,
        bucket: 'not_due',
      }),
    ],
    { count: 2, balance: 200000, overdue: 150000 },
  );
  renderApp('/bills');
  const strip = await screen.findByRole('region', { name: 'Money owed summary' });
  expect(within(strip).getByText('₹2,000.00')).toBeInTheDocument();
  expect(within(strip).getByText('₹1,500.00')).toBeInTheDocument();
  expect(within(strip).getByText(/2 bills/)).toBeInTheDocument();
  const table = await screen.findByRole('table', { name: 'Money owed' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows[0]).toHaveTextContent('Asha Rao');
  expect(rows[0]).toHaveTextContent('INV/2627/0001');
  expect(rows[0]).toHaveTextContent('12 days late');
  expect(rows[0]).toHaveTextContent('₹1,500.00');
  expect(rows[1]).toHaveTextContent('Meera Iyer');
  expect(rows[1]).toHaveTextContent('in 4 days');
});

test('an empty money owed list says what to do', async () => {
  asFrontDesk();
  receivables([], { count: 0, balance: 0, overdue: 0 });
  renderApp('/bills');
  expect(await screen.findByText('Nobody owes you money')).toBeInTheDocument();
});

test('ageing chips ask the server for the bucket', async () => {
  asFrontDesk();
  const queries = receivables();
  renderApp('/bills');
  await screen.findByRole('table', { name: 'Money owed' });
  expect(queries[0].bucket).toBeUndefined();
  await userEvent.click(screen.getByRole('radio', { name: 'Overdue' }));
  await expect.poll(() => queries.at(-1).bucket).toBe('overdue');
  await userEvent.click(screen.getByRole('radio', { name: '31–60 days' }));
  await expect.poll(() => queries.at(-1).bucket).toBe('d31_60');
  await userEvent.click(screen.getByRole('radio', { name: '61–90 days' }));
  await expect.poll(() => queries.at(-1).bucket).toBe('d61_90');
  await userEvent.click(screen.getByRole('radio', { name: 'Over 90 days' }));
  await expect.poll(() => queries.at(-1).bucket).toBe('d90_plus');
  await userEvent.click(screen.getByRole('radio', { name: 'All' }));
  await expect.poll(() => queries.at(-1).bucket).toBeUndefined();
});

const billRow = (fields = {}) => ({
  id: 'inv1',
  status: 'issued',
  number: 'INV/2627/0001',
  date: ago(2),
  dueDate: addDaysYmd(todayYmd(), 5),
  customer: { id: 'c1', name: 'Asha Rao' },
  order: null,
  total: 210000,
  balance: 210000,
  payStatus: 'unpaid',
  overdue: false,
  ...fields,
});

test('bills tab filters drafts and unpaid', async () => {
  asFrontDesk();
  const queries = [];
  server.use(
    http.get('/v1/billing/invoices', ({ request }) => {
      const q = Object.fromEntries(new URL(request.url).searchParams);
      queries.push(q);
      const items =
        q.status === 'draft' ? [billRow({ id: 'd1', status: 'draft', number: null, total: null, balance: null, payStatus: null })] : [billRow()];
      return HttpResponse.json({ items, nextCursor: null });
    }),
  );
  renderApp('/bills?tab=bills');
  expect(await screen.findByText('INV/2627/0001')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('radio', { name: 'Drafts' }));
  await expect.poll(() => queries.at(-1)).toMatchObject({ status: 'draft' });
  expect(await screen.findByText('Not issued yet')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('radio', { name: 'Unpaid' }));
  await expect.poll(() => queries.at(-1)).toMatchObject({ status: 'issued', payStatus: 'unpaid' });
  await userEvent.click(screen.getByRole('radio', { name: 'Cancelled' }));
  await expect.poll(() => queries.at(-1)).toMatchObject({ status: 'cancelled' });
  await userEvent.type(screen.getByLabelText('Search bills'), 'INV/2627/0001');
  await expect.poll(() => queries.at(-1).q).toBe('INV/2627/0001');
});

test('payments tab lists receipts with their mode', async () => {
  asFrontDesk();
  const queries = [];
  const customer = (id, name) => ({ id, name });
  server.use(
    http.get('/v1/billing/payments', ({ request }) => {
      queries.push(Object.fromEntries(new URL(request.url).searchParams));
      return HttpResponse.json({
        items: [
          { id: 'r1', status: 'issued', number: 'RCPT/2627/0004', date: todayYmd(), amount: 200000, mode: 'upi', reference: '', customer: customer('c1', 'Asha Rao'), order: null },
          { id: 'r2', status: 'cancelled', number: 'RCPT/2627/0003', date: todayYmd(), amount: 50000, mode: 'bank_transfer', reference: '', customer: customer('c2', 'Meera Iyer'), order: null },
        ],
        nextCursor: null,
      });
    }),
  );
  renderApp('/bills?tab=payments');
  const table = await screen.findByRole('table', { name: 'Payments' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows[0]).toHaveTextContent('Asha Rao');
  expect(rows[0]).toHaveTextContent('UPI');
  expect(rows[0]).toHaveTextContent('₹2,000.00');
  expect(rows[1]).toHaveTextContent('Bank transfer');
  expect(rows[1]).toHaveTextContent('Cancelled');
  expect(queries[0]).toEqual({ from: todayYmd(), to: todayYmd() });
  await userEvent.click(screen.getByRole('radio', { name: 'All' }));
  await expect.poll(() => queries.at(-1)).toEqual({});
});

test("the customer's money shows owed, advance and the ledger", async () => {
  asFrontDesk();
  const ledgerRows = [
    { id: 'l1', type: 'receipt', number: 'RCPT/2627/0004', date: ago(1), label: 'Payment received (upi)', debit: 0, credit: 200000, balance: 10000, status: 'issued' },
    { id: 'l2', type: 'invoice', number: 'INV/2627/0012', date: ago(5), label: 'Bill', debit: 210000, credit: 0, balance: 210000, status: 'issued' },
    { id: 'l3', type: 'receipt', number: 'RCPT/2627/0001', date: ago(6), label: 'Payment received (cash), cancelled', debit: 0, credit: 0, balance: 0, status: 'cancelled' },
  ];
  server.use(
    http.get('/v1/customers/c1', () => HttpResponse.json(customerFixture())),
    http.get('/v1/customers/c1/measurements', () => HttpResponse.json({ items: [] })),
    http.get('/v1/billing/customers/c1/summary', () =>
      HttpResponse.json({ billed: 210000, received: 200000, credited: 0, refunded: 0, outstanding: 150000, overdue: 100000, advanceHeld: 30000 }),
    ),
    http.get('/v1/billing/customers/c1/ledger', () => HttpResponse.json({ items: ledgerRows, nextCursor: null })),
  );
  renderApp('/customers/c1');
  const money = await screen.findByRole('region', { name: 'Money' });
  expect(await within(money).findByText('₹1,500.00')).toBeInTheDocument();
  expect(within(money).getByText('Owed')).toBeInTheDocument();
  expect(within(money).getByText('₹1,000.00')).toBeInTheDocument();
  expect(within(money).getByText('Advance held')).toBeInTheDocument();
  expect(within(money).getByText('₹300.00')).toBeInTheDocument();
  expect(await within(money).findByText('Bill INV/2627/0012')).toBeInTheDocument();
  expect(within(money).getByText('Payment (UPI)')).toBeInTheDocument();
  expect(within(money).getByText('Payment (Cash)')).toHaveStyle({ textDecoration: 'line-through' });
  expect(within(money).getAllByText('Cancelled')).toHaveLength(2); // the badge and the amount
  expect(within(money).queryByRole('button', { name: 'Refund' })).toBeNull();
  await userEvent.click(within(money).getByRole('button', { name: 'Take payment' }));
  const dialog = await screen.findByRole('dialog', { name: 'Take payment from Asha Rao' });
  // On account: the dialog starts at what is owed, and says more than that is kept as advance.
  const amount = within(dialog).getByLabelText('Amount (₹)');
  expect(amount).toHaveValue('1500');
  await userEvent.clear(amount);
  await userEvent.type(amount, '2000');
  expect(within(dialog).getByText('₹1,500.00 will pay their bills, ₹500.00 will be kept as advance.')).toBeInTheDocument();
});

test('designers have no Bills menu', async () => {
  asDesigner();
  renderApp('/');
  await screen.findByRole('navigation', { name: 'Main' });
  expect(screen.queryByRole('link', { name: 'Bills' })).toBeNull();
});

test('show more asks for the next page and adds its rows', async () => {
  asFrontDesk();
  const cursors = [];
  server.use(
    http.get('/v1/billing/receivables', ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      cursors.push(cursor);
      const totals = { count: 2, balance: 200000, overdue: 150000 };
      return HttpResponse.json(
        cursor
          ? { items: [owedRow({ invoice: { id: 'inv2', number: 'INV/2627/0002', date: ago(3), dueDate: ago(1), total: 50000, balance: 50000 }, customer: { id: 'c2', name: 'Meera Iyer' } })], totals, nextCursor: null }
          : { items: [owedRow()], totals, nextCursor: 'next-1' },
      );
    }),
  );
  renderApp('/bills');
  await screen.findByText('INV/2627/0001');
  await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
  expect(await screen.findByText('INV/2627/0002')).toBeInTheDocument();
  expect(screen.getByText('INV/2627/0001')).toBeInTheDocument();
  expect(cursors).toEqual([null, 'next-1']);
  expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
});

test('a designer on a customer page makes no billing request', async () => {
  asDesigner();
  const billing = [];
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname.startsWith('/v1/billing')) billing.push(request.url);
  });
  server.use(
    http.get('/v1/customers/c1', () => HttpResponse.json(customerFixture())),
    http.get('/v1/customers/c1/measurements', () => HttpResponse.json({ items: [] })),
  );
  renderApp('/customers/c1');
  expect(await screen.findByRole('heading', { name: 'Asha Rao', level: 1 })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Money' })).toBeNull();
  expect(billing).toEqual([]);
  server.events.removeAllListeners();
});

test('opening balance rows show their label and admins can cancel them', async () => {
  asOwner();
  let sent = null;
  const ledgerRows = [
    { id: 'ob1', type: 'opening_balance', number: 'OB/2627/0001', date: ago(3), label: 'Owed before 15 Nov 2026 (opening balance)', debit: 500000, credit: 0, balance: 300000, status: 'issued', opening: true, version: 0 },
    { id: 'oa1', type: 'receipt', number: 'OA/2627/0001', date: ago(3), label: 'Advance held before 15 Nov 2026 (opening balance)', debit: 0, credit: 200000, balance: -200000, status: 'issued', opening: true, version: 0 },
  ];
  server.use(
    http.get('/v1/customers/c1', () => HttpResponse.json(customerFixture())),
    http.get('/v1/customers/c1/measurements', () => HttpResponse.json({ items: [] })),
    http.get('/v1/billing/customers/c1/summary', () =>
      HttpResponse.json({ billed: 0, received: 0, credited: 0, refunded: 0, outstanding: 500000, overdue: 500000, advanceHeld: 200000, advanceUnassigned: 0 }),
    ),
    http.get('/v1/billing/customers/c1/ledger', () => HttpResponse.json({ items: ledgerRows, nextCursor: null })),
    http.post('/v1/billing/opening-balances/ob1/cancel', async ({ request }) => {
      sent = await request.json();
      return HttpResponse.json({ openingBalance: { id: 'ob1', status: 'cancelled', version: 1 } });
    }),
  );
  renderApp('/customers/c1');
  const money = await screen.findByRole('region', { name: 'Money' });
  expect(await within(money).findByText('Owed before 15 Nov 2026 (opening balance)')).toBeInTheDocument();
  expect(within(money).getByText('Advance held before 15 Nov 2026 (opening balance)')).toBeInTheDocument();
  // An opening advance is not a payment: no "Cancel payment" and no receipt PDF.
  expect(within(money).queryByRole('button', { name: 'Cancel payment' })).toBeNull();
  const cancels = within(money).getAllByRole('button', { name: 'Cancel opening balance' });
  expect(cancels).toHaveLength(1);
  await userEvent.click(cancels[0]);
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Why is it being cancelled?'), 'Wrong amount');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, cancel the opening balance' }));
  await expect.poll(() => sent).toEqual({ version: 0, reason: 'Wrong amount' });
});
