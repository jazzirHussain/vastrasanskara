import { test, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { formatINR } from '@vs/shared/money.js';
import { server, asDesigner } from '../../test/server.js';
import { asOwner } from '../../test/billing.js';
import { renderApp } from '../../test/setup.js';

function rowsAre(metric, body) {
  const queries = [];
  server.use(
    http.get(`/v1/dashboard/metrics/${metric}/rows`, ({ request }) => {
      const q = Object.fromEntries(new URL(request.url).searchParams);
      queries.push(q);
      return typeof body === 'function' ? body(q) : HttpResponse.json(body);
    }),
  );
  return queries;
}

const billed = {
  metric: { id: 'billed', label: 'Billed', count: 2, amount: 5240000 },
  items: [
    { id: 'b1', title: 'INV/2627/0001', subtitle: 'Asha Rao', amount: 3240000, date: '2026-11-03', link: '/bills/b1' },
    { id: 'b2', title: 'INV/2627/0002', subtitle: 'Sri Silks', amount: 2000000, date: '2026-11-05', link: '/bills/b2' },
  ],
  nextCursor: null,
  columns: [{ key: 'title', label: 'Record' }],
};

test('the list shows the same number as Home and its records', async () => {
  asOwner();
  const queries = rowsAre('billed', billed);
  renderApp('/home/billed?preset=month');
  expect(await screen.findByRole('heading', { name: 'Billed' })).toBeInTheDocument();
  expect(await screen.findByText(formatINR(5240000))).toBeInTheDocument();
  expect(screen.getByText('2 records')).toBeInTheDocument();
  const list = screen.getByRole('list', { name: 'Records' });
  expect(within(list).getAllByRole('link').map((a) => a.textContent)).toEqual([
    expect.stringContaining('INV/2627/0001'),
    expect.stringContaining('INV/2627/0002'),
  ]);
  expect(within(list).getByText(formatINR(3240000))).toBeInTheDocument();
  expect(queries[0]).toMatchObject({ preset: 'month' });
});

test('rows open the order, bill or expense', async () => {
  asOwner();
  rowsAre('late_garments', {
    metric: { id: 'late_garments', label: 'Late garments', count: 1 },
    items: [{ id: 'g1', title: 'G-0007 · Blouse', subtitle: 'VS/ORD/2627/0007 · Asha Rao', date: '2026-11-10', badge: 'Handwork', link: '/orders/o7' }],
    nextCursor: null,
    columns: [],
  });
  renderApp('/home/late_garments?preset=month');
  const row = await screen.findByRole('link', { name: /G-0007/ });
  expect(row).toHaveAttribute('href', '/orders/o7');
  expect(within(row).getByText('Handwork')).toBeInTheDocument();
});

test('removing a filter chip updates the list', async () => {
  asOwner();
  const queries = rowsAre('billed', billed);
  renderApp('/home/billed?preset=month&customerType=business&priority=rush');
  await screen.findByRole('heading', { name: 'Billed' });
  expect(queries.at(-1)).toMatchObject({ customerType: 'business', priority: 'rush' });
  await userEvent.click(screen.getByRole('button', { name: 'Remove Business customers' }));
  await expect.poll(() => queries.at(-1)).toEqual({ preset: 'month', priority: 'rush' });
  expect(screen.queryByRole('button', { name: 'Remove Business customers' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Remove Rush orders' })).toBeInTheDocument();
});

test('designers see no amounts', async () => {
  asDesigner();
  rowsAre('active_orders', {
    metric: { id: 'active_orders', label: 'Active orders', count: 1 },
    items: [{ id: 'o1', title: 'VS/ORD/2627/0001', subtitle: 'Asha Rao · Meera', date: '2026-11-20', link: '/orders/o1' }],
    nextCursor: null,
    columns: [],
  });
  renderApp('/home/active_orders?preset=month');
  expect(await screen.findByRole('link', { name: /VS\/ORD\/2627\/0001/ })).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('₹');
});

test('a list that is not there says so', async () => {
  asOwner();
  rowsAre('billed', () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 }));
  renderApp('/home/billed');
  expect(await screen.findByText('This list is not available.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/');
  renderApp('/home/no_such_list');
  expect((await screen.findAllByText('This list is not available.')).length).toBeGreaterThan(0);
});

test('one bar\'s list names the bar, not its code', async () => {
  asOwner();
  rowsAre('receivables_ageing', {
    metric: { id: 'receivables_ageing', label: 'Who owes what', amount: 1200000, keyLabel: '31–60 days late' },
    items: [{ id: 'b9', title: 'INV/2627/0009', subtitle: 'Asha Rao', amount: 1200000, date: '2026-09-20', link: '/bills/b9' }],
    nextCursor: null,
    columns: [],
  });
  renderApp('/home/receivables_ageing?preset=month&key=d31_60');
  expect(await screen.findByText(formatINR(1200000), { selector: 'p' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove 31–60 days late' })).toBeInTheDocument();
  expect(screen.queryByText(/d31_60/)).toBeNull();
});
