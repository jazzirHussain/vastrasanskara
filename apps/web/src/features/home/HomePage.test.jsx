import { test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { addDaysYmd } from '@vs/shared';
import { server, asOperations } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { orderDetailFixture, orderSummary, todayYmd } from '../../test/orders.js';

test('home shows upcoming pickups', async () => {
  asOperations(); const queries = [];
  server.use(http.get('/v1/orders', ({ request }) => {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    queries.push(query);
    const items = query.status === 'on_hold' ? [] : [orderSummary(orderDetailFixture({ pickupDate: addDaysYmd(todayYmd(), 3) }))];
    return HttpResponse.json({ items, nextCursor: null });
  }));
  renderApp('/');
  expect(await screen.findByRole('heading', { name: 'Welcome, Kavya' })).toBeInTheDocument();
  expect(await screen.findByText('VS/ORD/2627/0007')).toBeInTheDocument();
  expect(screen.getByText('in 3 days')).toBeInTheDocument();
  expect(screen.getByText('Nothing is on hold.')).toBeInTheDocument();
  expect(queries).toContainEqual(expect.objectContaining({ status: 'active', pickupTo: addDaysYmd(todayYmd(), 14) }));
});
test('an empty home points to the next step', async () => {
  asOperations();
  server.use(http.get('/v1/orders', () => HttpResponse.json({ items: [], nextCursor: null })));
  renderApp('/');
  expect(await screen.findByText('No pickups in the next two weeks.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Take an order' })).toHaveAttribute('href', '/orders/new');
});
test('upcoming pickups include overdue orders and page past the first 25', async () => {
  asOperations(); const queries = [];
  const overdue = { ...orderSummary(orderDetailFixture({ id: 'o2', orderNo: 'VS/ORD/2627/0002' })), pickupDate: addDaysYmd(todayYmd(), -2) };
  const later = orderSummary(orderDetailFixture({ id: 'o3', orderNo: 'VS/ORD/2627/0003', pickupDate: addDaysYmd(todayYmd(), 5) }));
  server.use(http.get('/v1/orders', ({ request }) => {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    if (query.status === 'on_hold') return HttpResponse.json({ items: [], nextCursor: null });
    queries.push(query);
    return query.cursor ? HttpResponse.json({ items: [later], nextCursor: null }) : HttpResponse.json({ items: [overdue], nextCursor: 'p2' });
  }));
  renderApp('/');
  expect(await screen.findByText('VS/ORD/2627/0002')).toBeInTheDocument();
  expect(queries[0].pickupFrom).toBeUndefined();
  await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
  expect(await screen.findByText('VS/ORD/2627/0003')).toBeInTheDocument();
});
