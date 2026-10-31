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

test('locking a month says expenses are locked too', async () => {
  asOwner();
  periods();
  renderApp('/accounts');
  const row = await rowOf('September 2026');
  await userEvent.click(within(row).getByRole('button', { name: 'Lock month' }));
  expect(await screen.findByText(/No bills, payments, refunds or expenses can be added, changed, voided or cancelled in a locked month\./)).toBeInTheDocument();
});

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
    within(dialog).getByText('Lock September 2026? Do this after you file GSTR-1. No bills, payments, refunds or expenses can be added, changed, voided or cancelled in a locked month.'),
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

const RUN = { id: 'run1', startedAt: '2026-10-30T06:29:00.000Z' };

/**
 * The check-records API: no check until one is started; then GET answers `running` for the
 * first `runningReads` reads and then the finished check with `result`. Returns the POST count.
 */
function checks(result, { runningReads = 0 } = {}) {
  const calls = { posts: 0, gets: 0 };
  server.use(
    http.post('/v1/admin/audit/verify', () => {
      calls.posts += 1;
      return HttpResponse.json({ run: { ...RUN, status: 'running', finishedAt: null, result: null } }, { status: 202 });
    }),
    http.get('/v1/admin/audit/verify', () => {
      if (!calls.posts) return HttpResponse.json({ run: null });
      calls.gets += 1;
      if (calls.gets <= runningReads) return HttpResponse.json({ run: { ...RUN, status: 'running', finishedAt: null, result: null } });
      return HttpResponse.json({ run: { ...RUN, status: 'done', finishedAt: '2026-10-30T06:30:00.000Z', result } });
    }),
  );
  return calls;
}

const CLEAN = {
  checkedAt: '2026-10-30T06:30:00.000Z',
  ok: true,
  audit: { ok: true, checked: 418, firstBreak: null },
  pdfs: { checked: 12, pending: 0, problems: [] },
  balances: { checked: 9, problems: [] },
};

test('check records says all is well in plain words', async () => {
  const calls = checks(CLEAN);
  await openChecks();
  await userEvent.click(await screen.findByRole('button', { name: 'Check records now' }));
  expect(await screen.findByText('All records check out (418 entries, 12 PDFs)')).toBeInTheDocument();
  expect(calls.posts).toBe(1);
});

test('check records waits for a long check and then shows the result', async () => {
  const calls = checks(CLEAN, { runningReads: 1 });
  await openChecks();
  await userEvent.click(await screen.findByRole('button', { name: 'Check records now' }));
  expect(await screen.findByText('Checking your records… this can take a minute')).toBeInTheDocument();
  expect(await screen.findByText('All records check out (418 entries, 12 PDFs)', {}, { timeout: 5000 })).toBeInTheDocument();
  expect(screen.queryByText('Checking your records… this can take a minute')).toBeNull();
  expect(calls).toEqual({ posts: 1, gets: 2 });
});

test('a check that could not finish says so', async () => {
  server.use(
    http.get('/v1/admin/audit/verify', () =>
      HttpResponse.json({ run: { ...RUN, status: 'failed', finishedAt: '2026-10-30T06:30:00.000Z', result: null } }),
    ),
  );
  await openChecks();
  expect(await screen.findByText('The check could not finish. Please try again.')).toBeInTheDocument();
});

test('check records shows a problem in plain words', async () => {
  checks({
    checkedAt: '2026-10-30T06:30:00.000Z',
    ok: false,
    audit: {
      ok: false,
      checked: 417,
      firstBreak: { seq: 418, reason: 'hash_mismatch', entityType: 'invoice', entityId: 'abc123', number: 'INV/2627/0012' },
    },
    pdfs: {
      checked: 12,
      pending: 0,
      problems: [
        { id: 'd1', type: 'invoice', number: 'INV/2627/0012', reason: 'hash_mismatch' },
        { id: 'd2', type: 'receipt', number: 'RCPT/2627/0003', reason: 'missing' },
      ],
    },
    balances: { checked: 9, problems: [{ id: 'd3', number: 'INV/2627/0005', fields: ['paid'], stored: { paid: 1 }, expected: { paid: 2 } }] },
  });
  await openChecks();
  await userEvent.click(await screen.findByRole('button', { name: 'Check records now' }));
  expect(await screen.findByText('Bill INV/2627/0012: the PDF has changed since it was issued')).toBeInTheDocument();
  expect(screen.getByText('Receipt RCPT/2627/0003: the PDF is missing')).toBeInTheDocument();
  expect(screen.getByText('Bill INV/2627/0005: the amount paid does not match its payments')).toBeInTheDocument();
  expect(screen.getByText('The history has been changed at entry 418 (Bill INV/2627/0012)')).toBeInTheDocument();
  expect(screen.queryByText(/abc123/)).toBeNull();
  expect(screen.queryByText(/hash_mismatch/)).toBeNull();
  expect(screen.queryByText(/All records check out/)).toBeNull();
});

test('a changed history entry with no document number names no id', async () => {
  checks({
    ...CLEAN,
    ok: false,
    audit: { ok: false, checked: 417, firstBreak: { seq: 418, reason: 'hash_mismatch', entityType: 'customer', entityId: 'abc123' } },
  });
  await openChecks();
  await userEvent.click(await screen.findByRole('button', { name: 'Check records now' }));
  expect(await screen.findByText('The history has been changed at entry 418')).toBeInTheDocument();
  expect(screen.queryByText(/abc123/)).toBeNull();
});

test('only the owner sees Accounts', async () => {
  asFrontDesk();
  renderApp('/accounts');
  await vi.waitFor(() => expect(window.location.pathname).toBeDefined());
  expect(screen.queryByText('Month locks')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Accounts' })).toBeNull();
});
