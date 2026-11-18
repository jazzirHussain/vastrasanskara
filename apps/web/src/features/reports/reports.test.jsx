import { test, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asOperations } from '../../test/server.js';
import { asOwner } from '../../test/billing.js';
import { renderApp } from '../../test/setup.js';
import { browser } from './reportsApi.js';

const lastMonth = () => {
  const now = new Date(Date.now() + 5.5 * 3600e3);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
};

const run = (fields = {}) => ({
  id: 'r1', kind: 'sales_register', label: 'Sales register', format: 'xlsx', params: { from: '2026-11-01', to: '2026-11-15' },
  status: 'done', filename: 'Sales register 2026-11-01 to 2026-11-15.xlsx', size: 20480, rows: 12, error: null,
  requestedBy: { id: 'admin1', name: 'Owner' }, createdAt: '2026-11-15T06:00:00.000Z', finishedAt: '2026-11-15T06:00:05.000Z', ...fields,
});

/** GET /v1/reports answers `items()`; POST /v1/reports is recorded with its headers. */
function reportsAre(items = () => []) {
  const posts = [];
  server.use(
    http.get('/v1/reports', () => HttpResponse.json({ items: items(), nextCursor: null })),
    http.post('/v1/reports', async ({ request }) => {
      const body = await request.json();
      posts.push({ body, key: request.headers.get('Idempotency-Key') });
      return HttpResponse.json({ report: run({ id: 'new', kind: body.kind, status: 'queued', filename: null }) }, { status: 202 });
    }),
  );
  return posts;
}

test('the GST files card asks for last month by default', async () => {
  asOwner();
  const posts = reportsAre();
  renderApp('/reports');
  const card = await screen.findByRole('region', { name: 'Last month’s GST files' });
  expect(within(card).getByRole('textbox', { name: 'Month' })).toHaveValue(lastMonth());
  await userEvent.click(within(card).getByRole('button', { name: 'Get files' }));
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].body).toEqual({ kind: 'gst_pack', format: 'xlsx', params: { month: lastMonth() } });
});

test('asking for a report sends one key and shows it preparing', async () => {
  asOwner();
  let list = [];
  const posts = reportsAre(() => list);
  renderApp('/reports');
  const card = await screen.findByRole('region', { name: 'Sales register' });
  list = [run({ id: 'new', status: 'queued', filename: null })];
  await userEvent.click(within(card).getByRole('button', { name: 'Get file' }));
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(posts[0].body).toMatchObject({ kind: 'sales_register', format: 'xlsx', params: { from: expect.any(String), to: expect.any(String) } });
  const recent = screen.getByRole('region', { name: 'Recent files' });
  expect(await within(recent).findByText('Preparing your file…')).toBeInTheDocument();
  // A second click is a new request with a new key.
  await userEvent.click(within(card).getByRole('button', { name: 'Get file' }));
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1].key).not.toBe(posts[0].key);
});

test('a ready file downloads through a fresh link', async () => {
  asOwner();
  reportsAre(() => [run()]);
  let links = 0;
  server.use(http.get('/v1/reports/r1/download', () => {
    links += 1;
    return HttpResponse.json({ url: 'https://files.test/r1?sig=x', filename: 'Sales register.xlsx' });
  }));
  const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
  renderApp('/reports');
  const recent = await screen.findByRole('region', { name: 'Recent files' });
  expect(await within(recent).findByText('Ready')).toBeInTheDocument();
  expect(within(recent).getByText(/20 KB · asked by Owner/)).toBeInTheDocument();
  await userEvent.click(within(recent).getByRole('button', { name: 'Download' }));
  await expect.poll(() => assign.mock.calls.length).toBe(1);
  expect(assign).toHaveBeenCalledWith('https://files.test/r1?sig=x');
  await userEvent.click(within(recent).getByRole('button', { name: 'Download' }));
  await expect.poll(() => links).toBe(2);
});

test('a failed file says why and can be made again', async () => {
  asOwner();
  const posts = reportsAre(() => [run({ status: 'failed', filename: null, error: { code: 'REPORT_TOO_LARGE', message: 'Choose a shorter period' } })]);
  renderApp('/reports');
  const recent = await screen.findByRole('region', { name: 'Recent files' });
  expect(await within(recent).findByText('Could not be made: That is too much for one file. Choose a shorter period.')).toBeInTheDocument();
  await userEvent.click(within(recent).getByRole('button', { name: 'Make it again' }));
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].body).toEqual({ kind: 'sales_register', format: 'xlsx', params: { from: '2026-11-01', to: '2026-11-15' } });
});

test('CSV is offered only where it fits; the statement offers PDF', async () => {
  asOwner();
  reportsAre();
  renderApp('/reports');
  const formats = async (name) => within(await screen.findByRole('region', { name })).getAllByRole('radio').map((r) => r.closest('label')?.textContent ?? r.getAttribute('aria-label') ?? r.value);
  const values = async (name) => within(await screen.findByRole('region', { name })).getAllByRole('radio').map((r) => r.value);
  expect(await values('Sales register')).toEqual(['xlsx', 'csv']);
  expect(within(screen.getByRole('region', { name: 'GST return file (GSTR-1)' })).queryAllByRole('radio')).toEqual([]);
  expect(await values('Customer statement')).toEqual(['xlsx', 'pdf']);
  expect(within(screen.getByRole('region', { name: 'Sales register' })).getByRole('radio', { name: 'Excel' })).toBeChecked();
  expect(typeof formats).toBe('function');
});

test('Reports is in the menu for admins only', async () => {
  asOwner();
  reportsAre();
  renderApp('/');
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  expect(within(nav).getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/reports');
});

test('front desk has no Reports', async () => {
  asOperations();
  renderApp('/');
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  expect(within(nav).queryByRole('link', { name: 'Reports' })).toBeNull();
});

test('a GST pack offers both of its files', async () => {
  asOwner();
  reportsAre(() => [run({
    id: 'p1', kind: 'gst_pack', label: 'All GST files for a month', params: { month: '2026-10' }, filename: 'GST files October 2026.xlsx',
    files: [{ index: 0, filename: 'GST files October 2026.xlsx', size: 4096 }, { index: 1, filename: 'GST summary and registers October 2026.xlsx', size: 8192 }],
  })]);
  const asked = [];
  server.use(http.get('/v1/reports/p1/download', ({ request }) => {
    asked.push(new URL(request.url).searchParams.get('file'));
    return HttpResponse.json({ url: 'https://files.test/p1', filename: 'x.xlsx' });
  }));
  vi.spyOn(browser, 'assign').mockImplementation(() => {});
  renderApp('/reports');
  const recent = await screen.findByRole('region', { name: 'Recent files' });
  await userEvent.click(await within(recent).findByRole('button', { name: 'Download GST summary and registers October 2026.xlsx' }));
  await userEvent.click(within(recent).getByRole('button', { name: 'Download GST files October 2026.xlsx' }));
  await expect.poll(() => asked).toEqual(['1', '0']);
});

test('a request the server refuses says why', async () => {
  asOwner();
  reportsAre();
  server.use(http.post('/v1/reports', () => HttpResponse.json({ error: { code: 'VALIDATION_FAILED', message: 'Choose a month that has started', details: [] } }, { status: 400 })));
  renderApp('/reports');
  const card = await screen.findByRole('region', { name: 'Last month’s GST files' });
  await userEvent.click(within(card).getByRole('button', { name: 'Get files' }));
  expect(await within(card).findByRole('alert')).toHaveTextContent('Choose a month that has started');
});

test('a download that fails says so', async () => {
  asOwner();
  reportsAre(() => [run()]);
  server.use(http.get('/v1/reports/r1/download', () => HttpResponse.json({ error: { code: 'REPORT_NOT_READY', message: 'x' } }, { status: 422 })));
  renderApp('/reports');
  const recent = await screen.findByRole('region', { name: 'Recent files' });
  await userEvent.click(await within(recent).findByRole('button', { name: 'Download' }));
  expect(await within(recent).findByRole('alert')).toHaveTextContent('This file is still being prepared.');
});
