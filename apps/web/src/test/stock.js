import { http, HttpResponse } from 'msw';
import { permissionsFor } from '@vs/shared';
import { server } from './server.js';

/** A stock item as the API answers (money fields included, as for money.view). */
export function stockItemFixture(fields = {}) {
  return {
    id: 's1',
    name: 'Red silk',
    brand: 'Mysore Silks',
    category: 'Fabric',
    colour: 'Red',
    usageUnit: 'm',
    purchaseUnit: 'm',
    factor: 1000,
    step: 250,
    reorderLevel: 5000,
    onHand: 12500,
    reserved: 4000,
    free: 8500,
    low: false,
    active: true,
    version: 2,
    value: 625000,
    avgCost: 50_000_000,
    sellingPrice: null,
    ...fields,
  };
}

/** A stock movement as the API answers. */
export function movementFixture(fields = {}) {
  return {
    id: 'm1',
    type: 'opening',
    quantity: 12500,
    onHandChange: 12500,
    reservedChange: 0,
    onHandAfter: 12500,
    reservedAfter: 0,
    ref: { garmentId: null, garmentNo: null, orderId: null, purchaseRequestId: null, expenseId: null, invoiceId: null },
    reason: '',
    by: { id: 'ops1', name: 'Kavya' },
    at: '2026-11-01T06:00:00Z',
    date: '2026-11-01',
    valueChange: 625000,
    valueAfter: 625000,
    ...fields,
  };
}

/** Stock staff who cannot see money: stock.view and stock.write only. */
export const stockClerkUser = {
  id: 'clerk1',
  name: 'Ravi',
  email: 'ravi@x.com',
  roles: ['operations'],
  permissions: ['stock.view', 'stock.write'],
  branchId: 'b1',
};

export function asStockClerk() {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json(stockClerkUser)));
}

export const ownerUser = { id: 'admin1', name: 'Owner', email: 'owner@x.com', roles: ['admin'], permissions: [...permissionsFor(['admin'])], branchId: 'b1' };

export function asOwner() {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json(ownerUser)));
}

/**
 * Answers the stock list, low list, one item and its history. `list(query)` gives the rows of a
 * list request; `movements(query)` answers a page { items, nextCursor }. Requests are recorded.
 */
export function stockAre({ items = [stockItemFixture()], low = [], item = stockItemFixture(), list, movements } = {}) {
  const seen = { lists: [], movements: [] };
  server.use(
    http.get('/v1/stock/items', ({ request }) => {
      const q = new URL(request.url).searchParams;
      seen.lists.push(q);
      return HttpResponse.json({ items: list ? list(q) : items, nextCursor: null });
    }),
    http.get('/v1/stock/low', () => HttpResponse.json({ items: low })),
    http.get('/v1/stock/items/:id', () => HttpResponse.json({ item })),
    http.get('/v1/stock/items/:id/movements', ({ request }) => {
      const q = new URL(request.url).searchParams;
      seen.movements.push(q);
      return HttpResponse.json(movements ? movements(q) : { items: [movementFixture()], nextCursor: null });
    }),
  );
  return seen;
}

/** A "to buy" request as the API answers. */
export function requestFixture(fields = {}) {
  return {
    id: 'r1',
    stockItem: { id: 's2', name: 'Gold buttons', usageUnit: 'piece', purchaseUnit: 'packet', factor: 144000 },
    quantity: 288000,
    reason: 'manual',
    needs: [],
    note: '',
    status: 'requested',
    vendor: null,
    orderedAt: null,
    receipt: null,
    cancellation: null,
    version: 0,
    ...fields,
  };
}

/** Answers GET /v1/stock/requests by status (`byStatus.open`, `byStatus.received`, ...); queries are recorded. */
export function requestsAre(byStatus = {}) {
  const seen = [];
  server.use(
    http.get('/v1/stock/requests', ({ request }) => {
      const q = new URL(request.url).searchParams;
      seen.push(q);
      const items = byStatus[q.get('status') ?? 'open'] ?? [];
      return HttpResponse.json({ items: typeof items === 'function' ? items() : items, nextCursor: null });
    }),
  );
  return seen;
}

/** Records every POST to `path` (body and Idempotency-Key); `reply(n, body)` answers the nth. */
export function postsTo(path, reply) {
  const posts = [];
  server.use(
    http.post(path, async ({ request }) => {
      const body = await request.json();
      posts.push({ body, key: request.headers.get('Idempotency-Key') });
      return reply(posts.length, body);
    }),
  );
  return posts;
}

/** A line of a garment's materials card. */
export function materialLine(fields = {}) {
  return { stockItemId: 's1', name: 'Red silk', usageUnit: 'm', step: 250, planned: 2000, reserved: 2000, used: 0, state: 'planned', short: 0, ...fields };
}

/** A picker row (quantities only). */
export function pickerRow(fields = {}) {
  return { id: 's1', name: 'Red silk', brand: 'Raw silk', colour: 'Red', usageUnit: 'm', step: 250, free: 8500, ...fields };
}

/** Answers each garment's materials card from `cards` (by garment id) and the picker with `picker`; records PUTs and used changes. */
export function materialsAre({ cards = {}, picker = [pickerRow()] } = {}) {
  const sent = { plans: [], used: [] };
  server.use(
    http.get('/v1/stock/garments/:id/materials', ({ params }) =>
      HttpResponse.json(cards[params.id] ?? { garmentId: params.id, version: 0, lines: [] })),
    http.get('/v1/stock/picker', () => HttpResponse.json({ items: picker })),
    http.put('/v1/stock/garments/:id/materials', async ({ params, request }) => {
      const body = await request.json();
      sent.plans.push(body);
      return HttpResponse.json({ garmentId: params.id, version: body.version + 1, lines: body.lines.map((l) => materialLine({ ...l, planned: l.quantity, reserved: l.quantity })) });
    }),
    http.post('/v1/stock/garments/:id/materials/used', async ({ params, request }) => {
      const body = await request.json();
      sent.used.push(body);
      return HttpResponse.json(cards[params.id] ?? { garmentId: params.id, version: body.version + 1, lines: [] });
    }),
  );
  return sent;
}
