import { test, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, customerFixture } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { todayYmd } from '../../components/DateLabel.jsx';
import { asFrontDesk } from '../../test/billing.js';

afterEach(() => vi.restoreAllMocks());

const fakeTab = () => {
  const tab = { location: { href: '' }, close: vi.fn(), opener: 'set' };
  vi.spyOn(window, 'open').mockReturnValue(tab);
  return tab;
};

/** The PDF link of each document: ready unless its id is in `pending`. Counts the asks. */
function pdfs({ pending = [] } = {}) {
  const asked = [];
  server.use(
    http.get('/v1/billing/documents/:id/pdf', ({ params }) => {
      asked.push(params.id);
      return pending.includes(params.id)
        ? HttpResponse.json({ status: 'pending', url: null, filename: 'x.pdf' })
        : HttpResponse.json({ status: 'ready', url: `https://files.test/${params.id}.pdf`, filename: `${params.id}.pdf` });
    }),
  );
  return asked;
}

function payments() {
  server.use(
    http.get('/v1/billing/payments', () =>
      HttpResponse.json({
        items: [
          {
            id: 'r1',
            status: 'issued',
            number: 'RCPT/2627/0004',
            date: todayYmd(),
            amount: 200000,
            mode: 'upi',
            reference: '',
            customer: { id: 'c1', name: 'Asha Rao' },
            order: null,
          },
        ],
        nextCursor: null,
      }),
    ),
  );
}

test('a past receipt opens its PDF from the payments list', async () => {
  asFrontDesk();
  payments();
  const asked = pdfs();
  const tab = fakeTab();
  renderApp('/bills?tab=payments');
  await userEvent.click(await screen.findByRole('button', { name: 'PDF of receipt RCPT/2627/0004' }));
  await expect.poll(() => tab.location.href).toBe('https://files.test/r1.pdf');
  expect(asked).toEqual(['r1']);
  // Opening the PDF does not also open the customer.
  expect(screen.getByRole('table', { name: 'Payments' })).toBeInTheDocument();
});

test('a PDF still being made says so instead of opening', async () => {
  asFrontDesk();
  payments();
  pdfs({ pending: ['r1'] });
  const tab = fakeTab();
  renderApp('/bills?tab=payments');
  await userEvent.click(await screen.findByRole('button', { name: 'PDF of receipt RCPT/2627/0004' }));
  expect(await screen.findByText('The PDF is not ready yet. Try again in a minute.')).toBeInTheDocument();
  expect(tab.close).toHaveBeenCalled();
});

test('the customer ledger opens the PDF of each payment, credit note and refund', async () => {
  asFrontDesk();
  const row = (id, type, number, fields) => ({ id, type, number, date: '2026-10-29', label: '', debit: 0, credit: 0, balance: 0, status: 'issued', ...fields });
  server.use(
    http.get('/v1/customers/c1', () => HttpResponse.json(customerFixture())),
    http.get('/v1/customers/c1/measurements', () => HttpResponse.json({ items: [] })),
    http.get('/v1/billing/customers/c1/summary', () =>
      HttpResponse.json({ billed: 0, received: 0, credited: 0, refunded: 0, outstanding: 0, overdue: 0, advanceHeld: 0, advanceUnassigned: 0 }),
    ),
    http.get('/v1/billing/customers/c1/ledger', () =>
      HttpResponse.json({
        items: [
          row('rf1', 'refund', 'RF/2627/0001', { debit: 5000 }),
          row('cn1', 'credit_note', 'CN/2627/0001', { credit: 5000 }),
          row('r1', 'receipt', 'RCPT/2627/0004', { label: 'Payment received (upi)', credit: 200000 }),
          row('inv1', 'invoice', 'INV/2627/0001', { debit: 205000 }),
        ],
        nextCursor: null,
      }),
    ),
  );
  pdfs();
  const tab = fakeTab();
  renderApp('/customers/c1');
  const money = await screen.findByRole('region', { name: 'Money' });
  expect(await within(money).findByRole('button', { name: 'PDF of refund RF/2627/0001' })).toBeInTheDocument();
  expect(within(money).getByRole('button', { name: 'PDF of credit note CN/2627/0001' })).toBeInTheDocument();
  // A bill opens on its own page, where its PDF is.
  expect(within(money).queryByRole('button', { name: /PDF of bill/ })).toBeNull();
  await userEvent.click(within(money).getByRole('button', { name: 'PDF of receipt RCPT/2627/0004' }));
  await expect.poll(() => tab.location.href).toBe('https://files.test/r1.pdf');
});
