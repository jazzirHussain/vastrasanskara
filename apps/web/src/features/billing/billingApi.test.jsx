import { test, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/server.js';
import { draftFixture, issuedFixture, orderMoneyFixture } from '../../test/billing.js';
import { orderDetailFixture } from '../../test/orders.js';
import { createQueryClient } from '../../lib/queryClient.js';
import { useOrder, useOrders } from '../orders/ordersApi.js';
import { useInvoice, useIssueInvoice, useOrderMoney } from './billingApi.js';

test('issuing refreshes the bill, the order, its money and the orders list', async () => {
  const counts = { invoice: 0, money: 0, order: 0, orders: 0 };
  let issued = false;
  server.use(
    http.get('/v1/billing/invoices/inv1', () => {
      counts.invoice += 1;
      return HttpResponse.json({ invoice: issued ? issuedFixture() : draftFixture() });
    }),
    http.get('/v1/billing/orders/o1/summary', () => {
      counts.money += 1;
      return HttpResponse.json(orderMoneyFixture());
    }),
    http.get('/v1/orders/o1', () => {
      counts.order += 1;
      return HttpResponse.json(orderDetailFixture());
    }),
    http.get('/v1/orders', () => {
      counts.orders += 1;
      return HttpResponse.json({ items: [], nextCursor: null });
    }),
    http.post('/v1/billing/invoices/inv1/issue', () => {
      issued = true;
      return HttpResponse.json({ invoice: issuedFixture() }, { status: 201 });
    }),
  );
  const client = createQueryClient();
  const wrapper = ({ children }) => createElement(QueryClientProvider, { client }, children);
  const { result } = renderHook(
    () => ({
      invoice: useInvoice('inv1'),
      money: useOrderMoney('o1'),
      order: useOrder('o1'),
      orders: useOrders({}),
      issue: useIssueInvoice('inv1'),
    }),
    { wrapper },
  );
  await waitFor(() => expect(counts).toEqual({ invoice: 1, money: 1, order: 1, orders: 1 }));
  await act(() => result.current.issue.mutateAsync({ version: 0, key: 'k1' }));
  await waitFor(() => expect(counts).toEqual({ invoice: 2, money: 2, order: 2, orders: 2 }));
  await waitFor(() => expect(result.current.invoice.data.status).toBe('issued'));
});
