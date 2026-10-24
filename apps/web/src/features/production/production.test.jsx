import { test, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { STAGE_KEYS, workingStage } from '@vs/shared';
import { server, asDesigner, asOperations } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { orderDetailFixture } from '../../test/orders.js';

const BOARD_STAGES = STAGE_KEYS.slice(1, 13);

/** Production rows for garments of order o1 at the given current stages. */
function rowsAt(stages, { money = false } = {}) {
  const order = orderDetailFixture({ money, garments: stages.length });
  return order.garments.map((g, i) => {
    const garment = { ...g, currentStage: stages[i] };
    return {
      garment,
      order: { id: order.id, orderNo: order.orderNo, pickupDate: order.pickupDate, priority: 'normal' },
      customer: order.customer,
      designer: order.designer,
      workingStage: workingStage(garment),
      late: false,
      nearlyReady: false,
      vendor: null,
    };
  });
}

function serve(rows, counts = {}) {
  const queries = [];
  let posted;
  server.use(
    http.get('/v1/production/board', () =>
      HttpResponse.json({
        stages: BOARD_STAGES.map((stage) => ({ stage, inHouse: counts[stage] ?? 0, withVendor: 0, late: 0, ...(counts[`${stage}:late`] && { late: counts[`${stage}:late`] }) })),
      }),
    ),
    http.get('/v1/production/garments', ({ request }) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      queries.push(query);
      return HttpResponse.json({ items: rows.filter((r) => !query.stage || r.workingStage === query.stage), truncated: false });
    }),
    http.get('/v1/workers', () => HttpResponse.json({ items: [] })),
    http.get('/v1/vendors', () => HttpResponse.json({ items: [] })),
    http.post('/v1/production/actions', async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({ garments: [] });
    }),
  );
  return { queries, posted: () => posted };
}

test('board counts filter the garment list', async () => {
  asDesigner();
  const api = serve(rowsAt(['order_taken', 'order_taken', 'pattern_making']), { materials_ready: 2, pattern_making: 1, 'pattern_making:late': 1 });
  renderApp('/production');
  const tile = await screen.findByRole('button', { name: 'Pattern making: 1 garment, 1 late' });
  expect(await screen.findAllByRole('link', { name: /VS\/ORD\/2627\/0007-0/ })).toHaveLength(3);
  await userEvent.click(tile);
  expect(tile).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => api.queries.at(-1)).toEqual({ stage: 'pattern_making' });
  await expect.poll(() => screen.queryAllByRole('link', { name: /VS\/ORD\/2627\/0007-0/ }).length).toBe(1);
  await userEvent.click(screen.getByRole('radio', { name: 'Late' }));
  await expect.poll(() => api.queries.at(-1)).toEqual({ stage: 'pattern_making', late: 'true' });
});

test('bulk complete sends every selected garment once', async () => {
  asDesigner();
  const api = serve(rowsAt(['order_taken', 'order_taken']));
  renderApp('/production');
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Select VS/ORD/2627/0007-01' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select VS/ORD/2627/0007-02' }));
  const bar = screen.getByRole('region', { name: '2 garments selected' });
  await userEvent.click(within(bar).getByRole('button', { name: 'Mark materials ready done' }));
  const dialog = await screen.findByRole('dialog', { name: /2 garments/ });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await expect.poll(api.posted).toEqual({
    action: 'complete', stage: 'materials_ready', garments: [{ id: 'g1', version: 0 }, { id: 'g2', version: 0 }],
  });
  await expect.poll(() => screen.queryByRole('region', { name: /selected/ })).toBeNull();
});

test('bulk offers nothing for garments at different stages', async () => {
  asDesigner();
  serve(rowsAt(['order_taken', 'pattern_making']));
  renderApp('/production');
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Select VS/ORD/2627/0007-01' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select VS/ORD/2627/0007-02' }));
  const bar = screen.getByRole('region', { name: '2 garments selected' });
  expect(within(bar).getByText('Pick garments at the same stage')).toBeInTheDocument();
  expect(within(bar).queryByRole('button', { name: /done/ })).toBeNull();
});

test('operations sees the board without checkboxes', async () => {
  asOperations();
  serve(rowsAt(['order_taken']), { materials_ready: 1 });
  renderApp('/production');
  expect(await screen.findByRole('link', { name: /VS\/ORD\/2627\/0007-01/ })).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).toBeNull();
});
