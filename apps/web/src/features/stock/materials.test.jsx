import { test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asDesigner } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { orderDetailFixture } from '../../test/orders.js';
import { materialLine, materialsAre } from '../../test/stock.js';

afterEach(() => vi.restoreAllMocks());

/** Serves order o1 (no money, as a designer gets it) with its first garment changed by `garment`. */
function serveOrder(garment = {}) {
  const order = orderDetailFixture({ money: false });
  Object.assign(order.garments[0], garment);
  server.use(
    http.get('/v1/orders/o1', () => HttpResponse.json(order)),
    http.get('/v1/production/garments/g1/events', () => HttpResponse.json({ items: [] })),
  );
  return order;
}

const card = (lines, version = 1) => ({ garmentId: 'g1', version, lines });

test('a designer adds materials to their garment without seeing prices', async () => {
  asDesigner();
  serveOrder();
  const sent = materialsAre();
  renderApp('/orders/o1');
  const materials = await screen.findByRole('region', { name: 'Materials' });
  await userEvent.click(await within(materials).findByRole('button', { name: 'Add material' }));
  await userEvent.type(within(materials).getByRole('textbox', { name: 'Find material' }), 'silk');
  const row = await within(materials).findByRole('button', { name: 'Red silk · Raw silk — 8.5 m free' });
  expect(materials.textContent).not.toContain('₹');
  await userEvent.click(row);
  // A new line starts at one step (0.25 m); three taps make it 1 m.
  for (let i = 0; i < 3; i += 1) await userEvent.click(within(materials).getByRole('button', { name: 'More' }));
  expect(within(materials).getByText('1 m')).toBeInTheDocument();
  await userEvent.click(within(materials).getByRole('button', { name: 'Save materials' }));
  await waitFor(() => expect(sent.plans).toEqual([{ version: 0, lines: [{ stockItemId: 's1', quantity: 1000 }] }]));
  expect(document.body.textContent).not.toContain('₹');
});

test('a short line shows how much is to buy', async () => {
  asDesigner();
  serveOrder();
  materialsAre({ cards: { g1: card([materialLine({ planned: 5000, reserved: 3000, short: 2000 })]) } });
  renderApp('/orders/o1');
  const materials = await screen.findByRole('region', { name: 'Materials' });
  const short = await within(materials).findByText('2 m to buy');
  expect(short).toHaveAttribute('data-alert', 'short');
  expect(within(materials).getByRole('button', { name: 'Remove Red silk' })).toBeInTheDocument();
});

test('after Materials ready the card offers used more and put back', async () => {
  asDesigner();
  serveOrder({ currentStage: 'pattern_making' });
  const sent = materialsAre({ cards: { g1: card([materialLine({ state: 'used', used: 2000, reserved: 0 })], 3) } });
  renderApp('/orders/o1');
  const materials = await screen.findByRole('region', { name: 'Materials' });
  expect(await within(materials).findByText('Used 2 m')).toBeInTheDocument();
  expect(within(materials).queryByRole('button', { name: 'Add material' })).toBeNull();

  await userEvent.click(within(materials).getByRole('button', { name: 'Used more' }));
  let sheet = await screen.findByRole('dialog', { name: /Used more/ });
  await userEvent.click(within(sheet).getByRole('button', { name: 'More' }));
  await userEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(sent.used).toEqual([{ version: 3, changes: [{ stockItemId: 's1', change: 500 }], note: '' }]));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  await userEvent.click(within(materials).getByRole('button', { name: 'Put back' }));
  sheet = await screen.findByRole('dialog', { name: /Put back/ });
  await userEvent.type(within(sheet).getByRole('textbox', { name: 'Note (optional)' }), 'Offcut');
  await userEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(sent.used.at(-1)).toEqual({ version: 3, changes: [{ stockItemId: 's1', change: -250 }], note: 'Offcut' }));
});
