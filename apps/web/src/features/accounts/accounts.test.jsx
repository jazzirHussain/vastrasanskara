import { test, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { asFrontDesk, asOwner } from '../../test/billing.js';

afterEach(() => vi.restoreAllMocks());

const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];

function monthRow(month, fields = {}) {
  return { month, locked: false, lockedAt: null, lockedBy: null, note: '', canLock: month < '2026-10', history: [], ...fields };
}

function periods(overrides = {}) {
  const requests = [];
  server.use(
    http.get('/v1/period-locks', ({ request }) => {
      requests.push(new URL(request.url).searchParams.get('fy'));
      return HttpResponse.json({ fy: '2026-27', months: MONTHS.map((m) => monthRow(m, overrides[m])) });
    }),
  );
  return requests;
}

/** The row of a month, found by its name. */
const rowOf = async (name) => (await screen.findByText(name)).closest('[data-month]');

test('locking a month asks to confirm', async () => {
  asOwner();
  periods();
  const posts = [];
  server.use(
    http.post('/v1/period-locks/2026-09/lock', async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json(monthRow('2026-09', { locked: true }));
    }),
  );
  renderApp('/accounts');
  const row = await rowOf('September 2026');
  await userEvent.click(within(row).getByRole('button', { name: 'Lock month' }));
  const dialog = await screen.findByRole('dialog');
  expect(
    within(dialog).getByText('Lock September 2026? Do this after you file GSTR-1. No bills, payments or refunds can be added, changed or cancelled in a locked month.'),
  ).toBeInTheDocument();
  expect(posts).toHaveLength(0);
  await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'GSTR-1 filed');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Lock September 2026' }));
  await expect.poll(() => posts).toEqual([{ note: 'GSTR-1 filed' }]);
});

test('unlocking needs a reason', async () => {
  asOwner();
  periods({ '2026-08': { locked: true, lockedAt: '2026-09-12T05:00:00.000Z', lockedBy: { id: 'u1', name: 'Owner' }, note: 'Filed' } });
  const posts = [];
  server.use(
    http.post('/v1/period-locks/2026-08/unlock', async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json(monthRow('2026-08'));
    }),
  );
  renderApp('/accounts');
  const row = await rowOf('August 2026');
  expect(within(row).getByText('Locked')).toBeInTheDocument();
  expect(within(row).getByText(/Owner/)).toBeInTheDocument();
  expect(within(row).getByText('Filed')).toBeInTheDocument();
  await userEvent.click(within(row).getByRole('button', { name: 'Unlock' }));
  const dialog = await screen.findByRole('dialog');
  const confirm = within(dialog).getByRole('button', { name: 'Unlock August 2026' });
  expect(confirm).toBeDisabled();
  await userEvent.type(within(dialog).getByLabelText('Why is it being unlocked?'), 'Missed a bill');
  await userEvent.click(confirm);
  await expect.poll(() => posts).toEqual([{ reason: 'Missed a bill' }]);
});

test('the running month cannot be locked', async () => {
  asOwner();
  periods();
  renderApp('/accounts');
  const row = await rowOf('October 2026');
  expect(within(row).queryByRole('button', { name: 'Lock month' })).toBeNull();
  expect(within(row).getByText('You can lock a month after it ends')).toBeInTheDocument();
});

test('the financial year can be changed', async () => {
  asOwner();
  const requests = periods();
  renderApp('/accounts');
  await screen.findByText('April 2026');
  await userEvent.click(screen.getByRole('textbox', { name: 'Financial year' }));
  await userEvent.click(await screen.findByRole('option', { name: '2025-26' }));
  await expect.poll(() => requests.at(-1)).toBe('2025-26');
});

async function openChecks() {
  asOwner();
  periods();
  renderApp('/accounts');
  await userEvent.click(await screen.findByRole('tab', { name: 'Check records' }));
}

test('check records says all is well in plain words', async () => {
  server.use(
    http.post('/v1/admin/audit/verify', () =>
      HttpResponse.json({
        checkedAt: '2026-10-30T06:30:00.000Z',
        ok: true,
        audit: { ok: true, checked: 418, firstBreak: null },
        pdfs: { checked: 12, pending: 0, problems: [] },
        balances: { checked: 9, problems: [] },
      }),
    ),
  );
  await openChecks();
  await userEvent.click(await screen.findByRole('button', { name: 'Check records now' }));
  expect(await screen.findByText('All records check out (418 entries, 12 PDFs)')).toBeInTheDocument();
});

test('check records shows a problem in plain words', async () => {
  server.use(
    http.post('/v1/admin/audit/verify', () =>
      HttpResponse.json({
        checkedAt: '2026-10-30T06:30:00.000Z',
        ok: false,
        audit: { ok: false, checked: 417, firstBreak: { seq: 418, reason: 'hash_mismatch', entityType: 'invoice', entityId: 'abc123' } },
        pdfs: {
          checked: 12,
          pending: 0,
          problems: [
            { id: 'd1', type: 'invoice', number: 'INV/2627/0012', reason: 'hash_mismatch' },
            { id: 'd2', type: 'receipt', number: 'RCPT/2627/0003', reason: 'missing' },
          ],
        },
        balances: { checked: 9, problems: [{ id: 'd3', number: 'INV/2627/0005', fields: ['paid'], stored: { paid: 1 }, expected: { paid: 2 } }] },
      }),
    ),
  );
  await openChecks();
  await userEvent.click(await screen.findByRole('button', { name: 'Check records now' }));
  expect(await screen.findByText('Bill INV/2627/0012: the PDF has changed since it was issued')).toBeInTheDocument();
  expect(screen.getByText('Receipt RCPT/2627/0003: the PDF is missing')).toBeInTheDocument();
  expect(screen.getByText('Bill INV/2627/0005: the amount paid does not match its payments')).toBeInTheDocument();
  expect(screen.getByText('The history has been changed at entry 418 (invoice abc123)')).toBeInTheDocument();
  expect(screen.queryByText(/hash_mismatch/)).toBeNull();
  expect(screen.queryByText(/All records check out/)).toBeNull();
});

test('only the owner sees Accounts', async () => {
  asFrontDesk();
  renderApp('/accounts');
  await vi.waitFor(() => expect(window.location.pathname).toBeDefined());
  expect(screen.queryByText('Month locks')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Accounts' })).toBeNull();
});
