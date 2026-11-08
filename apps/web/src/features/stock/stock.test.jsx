import { test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asDesigner } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { asFrontDesk } from '../../test/billing.js';
import { asStockClerk, movementFixture, stockAre, stockItemFixture } from '../../test/stock.js';

afterEach(() => vi.restoreAllMocks());

const ref = (fields) => ({ garmentId: null, garmentNo: null, orderId: null, purchaseRequestId: null, expenseId: null, invoiceId: null, ...fields });

test('running-low items are listed first in red', async () => {
  asFrontDesk();
  const low = stockItemFixture({ id: 's2', name: 'Gold zari', colour: 'Gold', onHand: 2000, reserved: 0, free: 2000, reorderLevel: 5000, low: true });
  stockAre({ items: [stockItemFixture(), low], low: [low] });
  renderApp('/stock');
  const block = await screen.findByRole('region', { name: 'Running low' });
  const row = within(block).getByText('Gold zari').closest('[data-low-item]');
  const note = within(row).getByText('2 m free · reorder at 5 m');
  expect(note).toHaveAttribute('data-alert', 'true');
  expect(within(row).getByRole('button', { name: 'Order more' })).toBeInTheDocument();
  // The block comes before the list of all items.
  const list = screen.getByRole('region', { name: 'All items' });
  expect(block.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('items show free and reserved stock', async () => {
  asFrontDesk();
  const seen = stockAre();
  renderApp('/stock');
  const row = (await screen.findByText('Red silk')).closest('a');
  expect(row).toHaveAttribute('href', '/stock/items/s1');
  expect(within(row).getByText('Mysore Silks · Red')).toBeInTheDocument();
  expect(within(row).getByText('8.5 m')).toBeInTheDocument();
  expect(within(row).getByText('4 m reserved')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Running low' })).toBeNull();
  await userEvent.type(screen.getByRole('textbox', { name: 'Search stock' }), 'silk');
  await waitFor(() => expect(seen.lists.at(-1).get('q')).toBe('silk'));
});

test('adding an item with opening stock sends milli-units and paise', async () => {
  asFrontDesk();
  stockAre({ items: [] });
  const posts = [];
  server.use(
    http.post('/v1/stock/items', async ({ request }) => {
      posts.push({ body: await request.json(), key: request.headers.get('Idempotency-Key') });
      return HttpResponse.json({ item: stockItemFixture() }, { status: 201 });
    }),
  );
  renderApp('/stock');
  await userEvent.click(await screen.findByRole('button', { name: 'Add item' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Gold buttons');
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'We use it in' }), 'piece');
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'We buy it in' }), 'packet');
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'How many piece in one packet?' }), '144');
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reorder when free stock falls below' }), '50');
  await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Already have some?' }));
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'How many piece now?' }), '288');
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'Cost per piece (₹)' }), '0.70');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Add item' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].body).toEqual({
    name: 'Gold buttons', brand: '', category: '', colour: '', usageUnit: 'piece', purchaseUnit: 'packet', factor: 144000,
    step: 1000, reorderLevel: 50000, sellingPrice: null, opening: { quantity: 288000, unitCost: 70 },
  });
  expect(posts[0].key).toBeTruthy();
});

test('the item page shows stock, reserved and free; value only with money.view', async () => {
  asFrontDesk();
  stockAre();
  renderApp('/stock/items/s1');
  expect(await screen.findByText('12.5 m')).toBeInTheDocument();
  expect(screen.getByText('In stock')).toBeInTheDocument();
  expect(screen.getByText('Reserved for orders')).toBeInTheDocument();
  expect(screen.getByText('4 m')).toBeInTheDocument();
  expect(screen.getByText('Free')).toBeInTheDocument();
  expect(screen.getByText('8.5 m')).toBeInTheDocument();
  expect(screen.getByText('Stock value ₹6,250.00 · Average cost ₹500.00 per m')).toBeInTheDocument();
});

test('the item page hides value from staff without money.view', async () => {
  asStockClerk();
  stockAre();
  renderApp('/stock/items/s1');
  expect(await screen.findByText('12.5 m')).toBeInTheDocument();
  expect(screen.queryByText(/Stock value/)).toBeNull();
  expect(screen.queryByText(/₹/)).toBeNull();
});

test('counting stock sends the counted and expected quantities', async () => {
  asFrontDesk();
  stockAre();
  const counts = [];
  server.use(
    http.post('/v1/stock/items/s1/count', async ({ request }) => {
      counts.push(await request.json());
      return HttpResponse.json({ item: stockItemFixture({ onHand: 12000, free: 8000, version: 3 }) });
    }),
  );
  renderApp('/stock/items/s1');
  await userEvent.click(await screen.findByRole('button', { name: 'Count stock' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('How many are on the shelf now?')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Less' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Less' }));
  expect(within(dialog).getByText('0.5 m less than recorded')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Save count' })).toBeDisabled();
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Cut piece found damaged');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save count' }));
  await waitFor(() => expect(counts).toEqual([{ counted: 12000, expectedOnHand: 12500, reason: 'Cut piece found damaged' }]));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('a count conflict asks to count again', async () => {
  asFrontDesk();
  stockAre();
  server.use(
    http.post('/v1/stock/items/s1/count', () =>
      HttpResponse.json({ error: { code: 'CONFLICT', message: 'Changed' } }, { status: 409 })),
  );
  renderApp('/stock/items/s1');
  await userEvent.click(await screen.findByRole('button', { name: 'Count stock' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: 'More' }));
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Recount');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save count' }));
  expect(await within(dialog).findByText('Stock changed while you were counting. Count again.')).toBeInTheDocument();
});

test('the history pages and uses plain words', async () => {
  asFrontDesk();
  const pages = {
    first: {
      items: [
        movementFixture({ id: 'm5', type: 'sale', quantity: 500, onHandChange: -500, valueChange: -25000 }),
        movementFixture({ id: 'm4', type: 'consume', quantity: 2000, onHandChange: -2000, reservedChange: -2000, ref: ref({ garmentNo: 'VS/ORD/2627/0007-02' }), valueChange: -100000 }),
        movementFixture({ id: 'm3', type: 'reserve', quantity: 2000, onHandChange: 0, reservedChange: 2000, ref: ref({ garmentNo: 'VS/ORD/2627/0007-02' }), valueChange: 0 }),
      ],
      nextCursor: 'c2',
    },
    second: {
      items: [
        movementFixture({ id: 'm2', type: 'adjust', quantity: -500, onHandChange: -500, reason: 'Damaged', valueChange: -25000 }),
        movementFixture({ id: 'm1' }),
      ],
      nextCursor: null,
    },
  };
  const seen = stockAre({ movements: (q) => (q.get('cursor') === 'c2' ? pages.second : pages.first) });
  renderApp('/stock/items/s1');
  const history = await screen.findByRole('region', { name: 'History' });
  expect(await within(history).findByText('Sold on a bill')).toBeInTheDocument();
  expect(within(history).getByText('Used for VS/ORD/2627/0007-02')).toBeInTheDocument();
  expect(within(history).getByText('Reserved for VS/ORD/2627/0007-02')).toBeInTheDocument();
  expect(within(history).getAllByText('−2 m').length).toBeGreaterThan(0);
  expect(within(history).getByText('−₹1,000.00')).toBeInTheDocument();
  await userEvent.click(within(history).getByRole('button', { name: 'Show more' }));
  expect(await within(history).findByText('Count correction')).toBeInTheDocument();
  expect(within(history).getByText('Damaged')).toBeInTheDocument();
  expect(within(history).getByText('Opening stock')).toBeInTheDocument();
  expect(seen.movements.at(-1).get('cursor')).toBe('c2');
  expect(history.textContent).not.toMatch(/movement|ledger|SKU/i);
});

test('designers have no Stock menu and are sent away from /stock', async () => {
  asDesigner();
  renderApp('/stock');
  expect(await screen.findByText('You do not have access to this.')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Stock' })).toBeNull();
});
