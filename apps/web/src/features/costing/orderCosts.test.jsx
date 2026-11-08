import { test, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asDesigner } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { orderDetailFixture } from '../../test/orders.js';
import { asFrontDesk } from '../../test/billing.js';
import { asOwner } from '../../test/stock.js';

afterEach(() => vi.restoreAllMocks());

const garmentCosts = (fields) => ({
  id: 'g1', garmentNo: 'VS/ORD/2627/0007-01', description: 'Blouse 1', status: 'in_progress',
  revenue: 1000000, sharedRevenue: 0, material: 240000, expense: 100000, margin: 660000, materials: [], expenses: [], ...fields,
});

/** Serves order o1 with two garments and its costs; answers the requests made to the costs route. */
function serve({ order: orderFields = {}, garments } = {}) {
  const order = orderDetailFixture({ garments: 2 });
  const rows = garments ?? [
    garmentCosts({
      materials: [{ stockItemId: 's1', name: 'Red silk', usageUnit: 'm', quantity: 2400, cost: 240000 }],
      expenses: [{ expenseId: 'e7', number: 'EXP/2627/0007', kind: 'batch', share: 100000 }],
    }),
    garmentCosts({ id: 'g2', garmentNo: 'VS/ORD/2627/0007-02', description: 'Blouse 2', revenue: 0, material: 0, expense: 0, margin: 0 }),
  ];
  const sum = (key) => rows.reduce((s, g) => s + g[key], 0);
  const costs = {
    order: { id: 'o1', orderNo: order.orderNo, status: 'active', revenue: sum('revenue'), material: sum('material'), expense: sum('expense'), margin: sum('margin'), ...orderFields },
    garments: rows,
  };
  const calls = [];
  server.use(
    http.get('/v1/orders/o1', () => HttpResponse.json(order)),
    http.get('/v1/production/garments/:id/events', () => HttpResponse.json({ items: [] })),
    http.get('/v1/costing/orders/o1', () => {
      calls.push(1);
      return HttpResponse.json(costs);
    }),
  );
  return calls;
}

const openCard = async () => {
  const card = await screen.findByRole('region', { name: 'Costs and profit' });
  await userEvent.click(within(card).getByRole('button', { name: /Costs and profit/ }));
  return card;
};

test('the admin sees billed, materials, other costs and margin per garment', async () => {
  asOwner();
  serve();
  renderApp('/orders/o1');
  const card = await screen.findByRole('region', { name: 'Costs and profit' });
  expect(await within(card).findByText('Profit ₹6,600.00')).toBeInTheDocument();
  await openCard();
  const row = within(card).getByText('VS/ORD/2627/0007-01').closest('[data-garment]');
  expect(within(row).getByText('Billed').nextSibling).toHaveTextContent('₹10,000.00');
  expect(within(row).getByText('Materials cost').nextSibling).toHaveTextContent('₹2,400.00');
  expect(within(row).getByText('Other costs').nextSibling).toHaveTextContent('₹1,000.00');
  expect(within(row).getByText('Margin').nextSibling).toHaveTextContent('₹6,600.00');
  const unbilled = within(card).getByText('VS/ORD/2627/0007-02').closest('[data-garment]');
  expect(within(unbilled).getByText('Not billed yet — margin will change')).toBeInTheDocument();
});

test('a loss shows in red', async () => {
  asOwner();
  serve({ garments: [garmentCosts({ revenue: 0, material: 150000, expense: 50000, margin: -200000, status: 'rejected' })] });
  renderApp('/orders/o1');
  const card = await screen.findByRole('region', { name: 'Costs and profit' });
  const profit = await within(card).findByText('Loss ₹2,000.00');
  expect(profit).toHaveAttribute('data-loss', 'true');
  await openCard();
  // The order's margin and the garment's.
  for (const label of within(card).getAllByText('Margin')) {
    expect(label.nextSibling).toHaveTextContent('−₹2,000.00');
    expect(label.nextSibling).toHaveAttribute('data-loss', 'true');
  }
});

test("a garment's breakdown lists materials and expenses", async () => {
  asOwner();
  serve();
  renderApp('/orders/o1');
  const card = await openCard();
  await userEvent.click(within(card).getByRole('button', { name: /VS\/ORD\/2627\/0007-01/ }));
  const breakdown = within(card).getByRole('region', { name: 'Costs of VS/ORD/2627/0007-01' });
  expect(within(breakdown).getByText('Red silk — 2.4 m')).toBeInTheDocument();
  expect(within(breakdown).getByText('₹2,400.00')).toBeInTheDocument();
  const expense = within(breakdown).getByRole('link', { name: 'EXP/2627/0007' });
  expect(expense).toHaveAttribute('href', '/expenses/e7');
  expect(within(breakdown).getByText('₹1,000.00')).toBeInTheDocument();
});

test('operations and designers see no costs card', async () => {
  for (const as of [asFrontDesk, asDesigner]) {
    as();
    const calls = serve();
    const { unmount } = renderApp('/orders/o1');
    expect(await screen.findByText('VS/ORD/2627/0007')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Costs and profit' })).toBeNull();
    expect(calls).toHaveLength(0);
    unmount();
  }
});
