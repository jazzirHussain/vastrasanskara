import { test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asDesigner } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { todayYmd } from '../../test/orders.js';
import { asFrontDesk } from '../../test/billing.js';
import { expenseFixture, expenseRow, expensesAre, summaryFixture, uploadsWork } from '../../test/expenses.js';
import { monthLabel } from '../../lib/dates.js';

afterEach(() => vi.restoreAllMocks());

const thisMonth = todayYmd().slice(0, 7);
const previousMonth = (() => {
  const [y, m] = thisMonth.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
})();

function phoneWidth() {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: /max-width/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

test("the month shows its total and each category's share", async () => {
  asFrontDesk();
  expensesAre({ list: () => [expenseRow()] });
  const { container } = renderApp('/expenses');
  expect(await screen.findByText('₹48,250.00 spent')).toBeInTheDocument();
  expect(screen.getByText('₹41,000.00 last month')).toBeInTheDocument();
  expect(screen.getByText(monthLabel(thisMonth))).toBeInTheDocument();
  const rent = await screen.findByRole('button', { name: /^Rent/ });
  expect(rent).toHaveTextContent('₹30,000.00');
  expect(rent).toHaveTextContent('1 expense');
  expect(screen.getByRole('button', { name: /^Repairs and maintenance/ })).toHaveTextContent('4 expenses');
  const bar = container.querySelector('[data-bar="rent"]');
  expect(parseFloat(bar.style.width)).toBeCloseTo(62.18, 1);
  expect(screen.queryByText('Month locked')).toBeNull();
});

test('tapping a category filters the list', async () => {
  asFrontDesk();
  const seen = expensesAre({ list: () => [expenseRow()] });
  renderApp('/expenses');
  await userEvent.click(await screen.findByRole('button', { name: /^Rent/ }));
  await waitFor(() => expect(seen.lists.at(-1).get('category')).toBe('rent'));
  expect(seen.lists.at(-1).get('month')).toBe(thisMonth);
  expect(screen.getByRole('radio', { name: 'Rent' })).toBeChecked();
});

test('switching months asks the server for that month', async () => {
  asFrontDesk();
  const seen = expensesAre();
  renderApp('/expenses');
  expect(await screen.findByText('₹48,250.00 spent')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));
  expect(await screen.findByText(monthLabel(previousMonth))).toBeInTheDocument();
  await waitFor(() => expect(seen.summaries.at(-1).get('month')).toBe(previousMonth));
  await waitFor(() => expect(seen.lists.at(-1).get('month')).toBe(previousMonth));
  expect(screen.getByRole('button', { name: 'Next month' })).toBeEnabled();
});

test('voided expenses are struck through and do not count', async () => {
  asFrontDesk();
  const seen = expensesAre({
    list: (q) => (q.get('status') === 'voided' ? [expenseRow({ id: 'e9', number: 'EXP/2627/0009', status: 'voided', payee: { name: 'Gupta Traders' } })] : [expenseRow()]),
  });
  renderApp('/expenses');
  expect(await screen.findByText('Sharma Electricals')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('radio', { name: 'Voided' }));
  const payee = await screen.findByText('Gupta Traders');
  const row = payee.closest('[data-expense]');
  expect(within(row).getByText('Voided')).toBeInTheDocument();
  expect(row.querySelector('[data-struck]')).not.toBeNull();
  expect(seen.lists.at(-1).get('status')).toBe('voided');
  // The month figure is the server's, which leaves voided expenses out.
  expect(screen.getByText('₹48,250.00 spent')).toBeInTheDocument();
});

test('the GST bills without a photo link filters the list', async () => {
  asFrontDesk();
  const gst = { count: 3, taxable: 1000000, cgst: 90000, sgst: 90000, igst: 50000, itc: { cgst: 90000, sgst: 90000, igst: 50000 }, ineligible: { cgst: 0, sgst: 0, igst: 0 } };
  const seen = expensesAre({ summary: summaryFixture({ gst, missingBill: 2 }), list: () => [expenseRow({ hasGst: true })] });
  renderApp('/expenses');
  expect(await screen.findByText(/GST you can claim ₹2,300\.00/)).toHaveTextContent('CGST ₹900.00');
  expect(screen.getByText(/GST you can claim/)).toHaveTextContent('IGST ₹500.00');
  await userEvent.click(screen.getByRole('button', { name: '2 GST bills have no photo' }));
  await waitFor(() => expect(seen.lists.at(-1).get('noBill')).toBe('true'));
});

test('an empty month says so and offers Add expense', async () => {
  asFrontDesk();
  expensesAre({ summary: summaryFixture({ total: 0, count: 0, byCategory: [], previousMonthTotal: 0 }) });
  renderApp('/expenses');
  const name = new Date(`${thisMonth}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', timeZone: 'UTC' });
  expect(await screen.findByText(`No expenses in ${name} yet.`)).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Add expense' })[0]).toHaveAttribute('href', '/expenses/new');
});

async function openExpense(fields = {}) {
  asFrontDesk();
  const expense = expenseFixture(fields);
  server.use(http.get('/v1/expenses/:id', () => HttpResponse.json({ expense })));
  renderApp('/expenses/e1');
  await screen.findByText('EXP/2627/0012');
  return expense;
}

test('the expense page shows the bill, its photos and the link', async () => {
  uploadsWork();
  const tab = { location: { href: '' }, close: vi.fn(), opener: {} };
  const open = vi.spyOn(window, 'open').mockReturnValue(tab);
  await openExpense({
    total: 118000,
    payee: { vendorId: null, name: 'Sharma Electricals', gstin: '29ABCDE1234F1Z5', stateCode: '29' },
    mode: 'upi',
    reference: 'UTR12345',
    gst: { billNo: 'B-77', billDate: '2026-10-28', rateBp: 1800, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, tax: 18000, interState: false, itcEligible: true },
    attachments: [
      { key: 'b1/expense_bill/2026/a.jpg', name: 'a.jpg', contentType: 'image/jpeg', size: 100 },
      { key: 'b1/expense_bill/2026/b.pdf', name: 'b.pdf', contentType: 'application/pdf', size: 100 },
    ],
    link: { kind: 'order', id: 'o1', orderId: 'o1', orderNo: 'VS/ORD/2627/0007', label: 'Whole order' },
    note: 'New plug points',
  });
  expect(screen.getByText('₹1,180.00')).toBeInTheDocument();
  expect(screen.getByText('Repairs and maintenance')).toBeInTheDocument();
  expect(screen.getByText(/29ABCDE1234F1Z5/)).toBeInTheDocument();
  expect(screen.getByText(/UTR12345/)).toBeInTheDocument();
  expect(screen.getByText('B-77')).toBeInTheDocument();
  expect(screen.getByText('₹1,000.00')).toBeInTheDocument();
  expect(screen.getByText(/Can claim this GST back/).parentElement).toHaveTextContent('Yes');
  expect(screen.getByRole('link', { name: /VS\/ORD\/2627\/0007/ })).toHaveAttribute('href', '/orders/o1');
  expect(screen.getByText('New plug points')).toBeInTheDocument();
  expect(screen.getByText(/Added by Kavya on/)).toBeInTheDocument();
  expect(screen.queryByText(/^Changed /)).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Open b.pdf' }));
  await waitFor(() => expect(tab.location.href).toBe('https://storage.test/view.jpg'));
  expect(open).toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/expenses/e1/edit');
});

test('voiding needs a reason and is final', async () => {
  const posts = [];
  await openExpense();
  server.use(
    http.post('/v1/expenses/e1/void', async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json({
        expense: expenseFixture({ status: 'voided', version: 4, void: { reason: 'Wrong amount', at: '2026-10-31T06:00:00Z', by: { id: 'ops1', name: 'Kavya' } } }),
      });
    }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Void expense' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/stays in the list, marked void, and stops counting\. This cannot be undone\./)).toBeInTheDocument();
  const confirm = within(dialog).getByRole('button', { name: 'Yes, void it' });
  expect(confirm).toBeDisabled();
  await userEvent.type(within(dialog).getByLabelText('Why is it being voided?'), 'Wrong amount');
  await userEvent.click(confirm);
  expect(await screen.findByText(/Reason: Wrong amount/)).toBeInTheDocument();
  expect(posts).toEqual([{ reason: 'Wrong amount', version: 3 }]);
  expect(screen.queryByRole('button', { name: 'Void expense' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
});

test('a locked month offers no edit or void', async () => {
  await openExpense({ monthLocked: true });
  expect(screen.getByText('This month is locked for filing')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Void expense' })).toBeNull();
});

test('designers have no Expenses menu and are sent away from /expenses', async () => {
  asDesigner();
  renderApp('/expenses');
  expect(await screen.findByText('You do not have access to this.')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Expenses' })).toBeNull();
});

test('operations see Expenses under More and Add expense on Home', async () => {
  phoneWidth();
  asFrontDesk();
  renderApp('/');
  const add = await screen.findByRole('link', { name: 'Add expense' });
  expect(add).toHaveAttribute('href', '/expenses/new');
  const bar = await screen.findByRole('navigation', { name: 'Main' });
  expect(within(bar).queryByRole('link', { name: 'Expenses' })).toBeNull();
  await userEvent.click(within(bar).getByRole('button', { name: 'More' }));
  const more = await screen.findByRole('dialog');
  expect(within(more).getByRole('link', { name: 'Expenses' })).toHaveAttribute('href', '/expenses');
});
