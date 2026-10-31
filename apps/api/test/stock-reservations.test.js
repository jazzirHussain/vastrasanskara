import { test, expect } from 'vitest';
import { addDaysYmd, istDate } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { stockHelpers } from './helpers/stock.js';
import { clock } from '../src/clock.js';
import { GarmentMaterials, PurchaseRequest, StockItem } from '../src/modules/stock/model.js';
import { garmentMaterialsFilter, needsFilter, pickerFilter, shortfallFilter } from '../src/modules/stock/queries.js';

useTestDb();
const app = buildTestApp();
const { world: stockWorld, item, expectBalanced } = stockHelpers(app);

const MONEY_KEYS = ['cost', 'usedCost', 'value', 'valueChange', 'avgCost', 'sellingPrice', 'price', 'total', 'revenue', 'margin', 'profit'];
const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const today = () => istDate(clock.now());
let keys = 0;

async function world() {
  const w = await stockWorld();
  const other = await loginAs(app, { roles: ['designer'], name: 'Nila' });
  const customerId = (await w.ops.agent.post('/v1/customers').send({ name: 'Asha Rao', phone: '9876543210' })).body.id;
  /** Takes an order for `designer` (default the world's designer) with garment lines. */
  async function take(garments, { designer = w.designer } = {}) {
    const r = await w.ops.agent.post('/v1/orders').set('Idempotency-Key', `r${++keys}`).send({
      customerId,
      designerId: String(designer.user._id),
      pickupDate: addDaysYmd(today(), 40),
      garments: garments.map((g) => ({ type: 'blouse', description: 'Blouse', agreedPrice: 450000, ...g })),
    });
    return r;
  }
  async function takeOk(garments, options) {
    const r = await take(garments, options);
    ok(r, 201);
    return r.body;
  }
  return { ...w, other, customerId, take, takeOk };
}

const silkWith = (ops, metres, fields = {}) =>
  item(ops, { ...(metres ? { opening: { quantity: metres * 1000, unitCost: 25000 } } : {}), ...fields });
const view = (who, garmentId) => who.agent.get(`/v1/stock/garments/${garmentId}/materials`);
const plan = (who, garmentId, version, lines) => who.agent.put(`/v1/stock/garments/${garmentId}/materials`).send({ version, lines });
const line = (stockItem, quantity) => ({ stockItemId: stockItem.id, quantity });
const stored = (id) => StockItem.findById(id).lean();
const requestsFor = (id) => PurchaseRequest.find({ stockItemId: id }).sort({ createdAt: 1, _id: 1 }).lean();
const openRequests = async (id) => (await requestsFor(id)).filter((r) => r.status === 'requested');

function expectNoMoney(value) {
  if (Array.isArray(value)) return value.forEach(expectNoMoney);
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      expect(MONEY_KEYS, `money key ${key}`).not.toContain(key);
      expectNoMoney(v);
    }
  }
  return undefined;
}

test('materials listed when the order is taken are reserved', async () => {
  const { ops, takeOk } = await world();
  const silk = await silkWith(ops, 10);
  const order = await takeOk([{ materials: [line(silk, 2000)] }, { description: 'Second', materials: [line(silk, 2000)] }]);
  const after = await stored(silk.id);
  expect(after).toMatchObject({ onHand: 10000, reserved: 4000 });
  expect(after.onHand - after.reserved).toBe(6000);
  await expectBalanced(silk.id);
  const r = await view(ops, order.garments[0].id);
  ok(r);
  expect(r.body).toEqual({
    garmentId: order.garments[0].id,
    version: 0,
    lines: [{ stockItemId: silk.id, name: 'Red silk', usageUnit: 'm', step: 1000, planned: 2000, reserved: 2000, used: 0, state: 'planned', short: 0 }],
  });
  expect(await requestsFor(silk.id)).toEqual([]);
  // The garment itself keeps no materials list (the stock module owns it).
  const { Garment } = await import('../src/modules/orders/model.js');
  expect((await Garment.findById(order.garments[0].id).lean()).materials).toEqual([]);
});

test('a batch gives each garment the list', async () => {
  const { ops, takeOk } = await world();
  const silk = await silkWith(ops, 10);
  const buttons = await item(ops, { name: 'Gold buttons', usageUnit: 'pcs', opening: { quantity: 100000, unitCost: 100 } });
  const order = await takeOk([{ quantity: 3, materials: [line(silk, 1000), line(buttons, 4000)] }]);
  expect(order.garments).toHaveLength(3);
  for (const g of order.garments) {
    const r = await view(ops, g.id);
    expect(r.body.lines.map((l) => [l.stockItemId, l.planned, l.reserved])).toEqual([[silk.id, 1000, 1000], [buttons.id, 4000, 4000]]);
  }
  expect((await stored(silk.id)).reserved).toBe(3000);
  expect((await stored(buttons.id)).reserved).toBe(12000);
  // Garments added later get theirs too.
  const r = await ops.agent.post(`/v1/orders/${order.id}/garments`).set('Idempotency-Key', `r${++keys}`).send({
    garments: [{ type: 'blouse', description: 'Added', agreedPrice: 1000, materials: [line(silk, 500)] }],
  });
  ok(r, 201);
  const added = r.body.garments.find((g) => g.description === 'Added');
  expect((await view(ops, added.id)).body.lines[0]).toMatchObject({ planned: 500, reserved: 500 });
  expect((await stored(silk.id)).reserved).toBe(3500);
});

test('a shortfall reserves what is free and asks for the rest', async () => {
  const { ops, takeOk } = await world();
  const silk = await silkWith(ops, 5);
  const order = await takeOk([{ materials: [line(silk, 8000)] }]);
  const garment = order.garments[0];
  expect(await stored(silk.id)).toMatchObject({ onHand: 5000, reserved: 5000 });
  const requests = await requestsFor(silk.id);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ quantity: 3000, reason: 'shortfall', status: 'requested' });
  expect(requests[0].needs.map((n) => ({ ...n, garmentId: String(n.garmentId), orderId: String(n.orderId) }))).toEqual([
    { garmentId: garment.id, garmentNo: garment.garmentNo, orderId: order.id, quantity: 3000, reservedOnReceipt: 0 },
  ]);
  expect((await view(ops, garment.id)).body.lines[0]).toMatchObject({ planned: 8000, reserved: 5000, short: 3000, state: 'planned' });
  await expectBalanced(silk.id);
});

test('shortfalls for one item collect on one request until it is ordered', async () => {
  const { ops, takeOk } = await world();
  const silk = await silkWith(ops, 0);
  const first = await takeOk([{ materials: [line(silk, 2000)] }, { description: 'Second', materials: [line(silk, 3000)] }]);
  let requests = await requestsFor(silk.id);
  expect(requests).toHaveLength(1);
  expect(requests[0].quantity).toBe(5000);
  expect(requests[0].needs.map((n) => [n.garmentNo, n.quantity])).toEqual([
    [first.garments[0].garmentNo, 2000],
    [first.garments[1].garmentNo, 3000],
  ]);
  // More for a garment already waiting adds to its need.
  const r = await plan(ops, first.garments[0].id, 0, [line(silk, 2500)]);
  ok(r);
  requests = await requestsFor(silk.id);
  expect(requests[0].quantity).toBe(5500);
  expect(requests[0].needs.map((n) => n.quantity)).toEqual([2500, 3000]);

  await PurchaseRequest.updateOne({ _id: requests[0]._id }, { $set: { status: 'ordered' } });
  const later = await takeOk([{ materials: [line(silk, 1000)] }]);
  requests = await requestsFor(silk.id);
  expect(requests.map((x) => [x.status, x.quantity])).toEqual([['ordered', 5500], ['requested', 1000]]);
  expect(requests[1].needs.map((n) => String(n.garmentId))).toEqual([later.garments[0].id]);
});

test('two reservations at once never oversell', async () => {
  const { ops, takeOk } = await world();
  const silk = await silkWith(ops, 10);
  const order = await takeOk([{}, { description: 'Second' }]);
  await PurchaseRequest.init();
  const [a, b] = await Promise.all(order.garments.map((g) => plan(ops, g.id, 0, [line(silk, 8000)])));
  ok(a);
  ok(b);
  const after = await expectBalanced(silk.id);
  expect(after).toMatchObject({ onHand: 10000, reserved: 10000 });
  expect(after.onHand - after.reserved).toBeGreaterThanOrEqual(0);
  const requests = await requestsFor(silk.id);
  expect(requests).toHaveLength(1);
  expect(requests[0].quantity).toBe(6000);
  const reserved = [a.body, b.body].map((v) => v.lines[0].reserved).sort((x, y) => x - y);
  expect(reserved).toEqual([2000, 8000]);
});

test('two shortfalls at once open one request', async () => {
  const { ops, takeOk } = await world();
  const silk = await silkWith(ops, 0);
  const order = await takeOk([{}, { description: 'Second' }]);
  await PurchaseRequest.init();
  const replies = await Promise.all(order.garments.map((g) => plan(ops, g.id, 0, [line(silk, 3000)])));
  for (const r of replies) ok(r);
  const requests = await requestsFor(silk.id);
  expect(requests).toHaveLength(1);
  expect(requests[0].quantity).toBe(6000);
  expect(requests[0].needs).toHaveLength(2);
});

test('changing the plan reserves more or releases the difference', async () => {
  const { ops, takeOk } = await world();
  const silk = await silkWith(ops, 5);
  const order = await takeOk([{ materials: [line(silk, 4000)] }]);
  const id = order.garments[0].id;
  expect((await stored(silk.id)).reserved).toBe(4000);

  // Up to 7 m: the 1 m still free is reserved, 2 m is asked for.
  let r = await plan(ops, id, 0, [line(silk, 7000)]);
  ok(r);
  expect(r.body).toMatchObject({ version: 1, lines: [{ planned: 7000, reserved: 5000, short: 2000 }] });
  expect((await openRequests(silk.id))[0].quantity).toBe(2000);

  // Down to 6 m: still more than reserved, so only the request shrinks.
  r = await plan(ops, id, 1, [line(silk, 6000)]);
  ok(r);
  expect(r.body.lines[0]).toMatchObject({ planned: 6000, reserved: 5000, short: 1000 });
  expect((await openRequests(silk.id))[0].quantity).toBe(1000);

  // Down to 3 m: 2 m goes back to free stock and nothing is asked for any more.
  r = await plan(ops, id, 2, [line(silk, 3000)]);
  ok(r);
  expect(r.body.lines[0]).toMatchObject({ planned: 3000, reserved: 3000, short: 0 });
  expect(await stored(silk.id)).toMatchObject({ reserved: 3000 });
  const [request] = await requestsFor(silk.id);
  expect(request).toMatchObject({ status: 'cancelled', cancellation: { reason: 'No longer needed' } });
  await expectBalanced(silk.id);

  // A stale version is refused and nothing changes.
  ok(await plan(ops, id, 2, [line(silk, 1000)]), 409);
  expect((await stored(silk.id)).reserved).toBe(3000);
});

test('removing a line releases it and drops its request', async () => {
  const { ops, takeOk } = await world();
  const silk = await silkWith(ops, 5);
  const buttons = await item(ops, { name: 'Gold buttons', usageUnit: 'pcs', opening: { quantity: 100000, unitCost: 100 } });
  const order = await takeOk([{ materials: [line(silk, 8000), line(buttons, 6000)] }]);
  const id = order.garments[0].id;
  const r = await plan(ops, id, 0, [line(buttons, 6000)]);
  ok(r);
  expect(r.body.lines.map((l) => l.stockItemId)).toEqual([buttons.id]);
  expect((await stored(silk.id)).reserved).toBe(0);
  expect((await stored(buttons.id)).reserved).toBe(6000);
  const [request] = await requestsFor(silk.id);
  expect(request).toMatchObject({ status: 'cancelled', needs: [], cancellation: { reason: 'No longer needed' } });
  // Kept for history, hidden from the card.
  const doc = await GarmentMaterials.findOne({ garmentId: id }).lean();
  expect(doc.lines.find((l) => String(l.stockItemId) === silk.id)).toMatchObject({ state: 'released', reserved: 0 });
  // Listing it again plans it afresh.
  const again = await plan(ops, id, 1, [line(buttons, 6000), line(silk, 1000)]);
  ok(again);
  expect(again.body.lines.map((l) => [l.stockItemId, l.reserved])).toEqual([[buttons.id, 6000], [silk.id, 1000]]);
  await expectBalanced(silk.id);
  await expectBalanced(buttons.id);
});

test('cancelling an order releases every unused material', async () => {
  const { ops, takeOk } = await world();
  const silk = await silkWith(ops, 5);
  const order = await takeOk([{ materials: [line(silk, 3000)] }, { description: 'Second', materials: [line(silk, 4000)] }]);
  expect((await stored(silk.id)).reserved).toBe(5000);
  expect((await openRequests(silk.id))[0].quantity).toBe(2000);
  ok(await ops.agent.post(`/v1/orders/${order.id}/cancel`).send({ version: 0, reason: 'Wedding called off' }));
  expect((await stored(silk.id)).reserved).toBe(0);
  const [request] = await requestsFor(silk.id);
  expect(request.status).toBe('cancelled');
  await expectBalanced(silk.id);
  const r = await view(ops, order.garments[0].id);
  ok(r);
  expect(r.body.lines).toEqual([]);
  const refused = await plan(ops, order.garments[0].id, r.body.version, [line(silk, 1000)]);
  ok(refused, 422);
  expect(refused.body.error.code).toBe('INVALID_STATUS');
});

test('a rejected garment releases its materials and a remake reserves them again', async () => {
  const { ops, takeOk } = await world();
  const silk = await silkWith(ops, 10);
  const order = await takeOk([{ materials: [line(silk, 2000)] }, { description: 'Refunded', materials: [line(silk, 3000)] }]);
  const [kept, refunded] = order.garments;
  let r = await ops.agent.post('/v1/production/actions').send({
    action: 'rejected', stage: 'order_taken', reason: 'Wrong colour', resolution: 'remake', garments: [{ id: kept.id, version: kept.version }],
  });
  ok(r);
  const remakeId = r.body.garments[0].rejection.remakeGarmentId;
  expect((await view(ops, kept.id)).body.lines).toEqual([]);
  expect((await view(ops, remakeId)).body.lines[0]).toMatchObject({ stockItemId: silk.id, planned: 2000, reserved: 2000 });
  expect((await stored(silk.id)).reserved).toBe(5000);

  r = await ops.agent.post('/v1/production/actions').send({
    action: 'rejected', stage: 'order_taken', reason: 'Refused', resolution: 'refund', garments: [{ id: refunded.id, version: refunded.version }],
  });
  ok(r);
  expect((await stored(silk.id)).reserved).toBe(2000);
  await expectBalanced(silk.id);
});

test('materials already used cannot be re-planned', async () => {
  const { ops, designer, takeOk } = await world();
  const silk = await silkWith(ops, 10);
  const order = await takeOk([{ materials: [line(silk, 2000)] }]);
  const g = order.garments[0];
  ok(await designer.agent.post('/v1/production/actions').send({
    action: 'complete', stage: 'materials_ready', garments: [{ id: g.id, version: g.version }],
  }));
  const r = await plan(designer, g.id, 0, [line(silk, 3000)]);
  ok(r, 422);
  expect(r.body.error).toMatchObject({
    code: 'MATERIALS_ALREADY_USED',
    message: 'Materials for this garment are already used. Use "Used more" or "Put back".',
  });
});

test('an inactive item cannot be planned', async () => {
  const { ops, take, takeOk } = await world();
  const silk = await silkWith(ops, 10);
  ok(await ops.agent.patch(`/v1/stock/items/${silk.id}`).send({ version: 0, active: false }));
  const refused = await take([{ materials: [line(silk, 1000)] }]);
  ok(refused, 400);
  expect(refused.body.error.details).toEqual([{ path: 'materials.0.stockItemId', message: 'Choose an item from stock' }]);
  const order = await takeOk([{}]);
  const r = await plan(ops, order.garments[0].id, 0, [line(silk, 1000)]);
  ok(r, 400);
  expect(r.body.error.details).toEqual([{ path: 'materials.0.stockItemId', message: 'Choose an item from stock' }]);
  const unknown = await plan(ops, order.garments[0].id, 0, [{ stockItemId: '0123456789abcdef01234567', quantity: 1000 }]);
  ok(unknown, 400);
  expect((await stored(silk.id)).reserved).toBe(0);
  expect(await GarmentMaterials.countDocuments()).toBe(0);
});

test('a designer can plan materials only on their own garments', async () => {
  const { ops, designer, other, takeOk } = await world();
  const silk = await silkWith(ops, 10);
  const mine = await takeOk([{}]);
  const theirs = await takeOk([{}], { designer: other });
  const r = await plan(designer, mine.garments[0].id, 0, [line(silk, 1500)]);
  ok(r);
  expect(r.body.lines[0]).toMatchObject({ planned: 1500, reserved: 1500 });
  ok(await plan(designer, theirs.garments[0].id, 0, [line(silk, 1500)]), 404);
  ok(await view(designer, theirs.garments[0].id), 404);
  ok(await view(other, theirs.garments[0].id));
  expect((await stored(silk.id)).reserved).toBe(1500);
});

test('the materials card and picker carry no costs', async () => {
  const { ops, designer, admin, takeOk } = await world();
  const silk = await silkWith(ops, 10, { sellingPrice: 40000 });
  await item(ops, { name: 'Silk lining', opening: { quantity: 3000, unitCost: 100 } });
  await item(ops, { name: 'Raw silk', opening: { quantity: 3000, unitCost: 100 } });
  const hidden = await item(ops, { name: 'Silk old' });
  ok(await ops.agent.patch(`/v1/stock/items/${hidden.id}`).send({ version: 0, active: false }));
  const order = await takeOk([{ materials: [line(silk, 2000)] }]);
  for (const who of [designer, ops, admin]) {
    const card = await view(who, order.garments[0].id);
    ok(card);
    expectNoMoney(card.body);
    const picker = await who.agent.get('/v1/stock/picker?q=silk');
    ok(picker);
    expectNoMoney(picker.body);
    // Names starting with the words first, then names containing them; hidden items never.
    expect(picker.body.items.map((i) => i.name)).toEqual(['Silk lining', 'Raw silk', 'Red silk']);
    expect(picker.body.items[2]).toEqual({ id: silk.id, name: 'Red silk', brand: '', colour: '', usageUnit: 'm', step: 1000, free: 8000 });
  }
  const all = await designer.agent.get('/v1/stock/picker');
  ok(all);
  expect(all.body.items).toHaveLength(3);
});

test('materials queries use indexes', async () => {
  const { ops, branchId, takeOk } = await world();
  const silk = await silkWith(ops, 1);
  const order = await takeOk([{ materials: [line(silk, 2000)] }]);
  await Promise.all([GarmentMaterials.init(), PurchaseRequest.init(), StockItem.init()]);
  const plans = await Promise.all([
    GarmentMaterials.find(garmentMaterialsFilter(order.garments[0].id)).explain('queryPlanner'),
    PurchaseRequest.find(shortfallFilter(branchId, silk.id)).explain('queryPlanner'),
    PurchaseRequest.find(needsFilter(branchId, [order.garments[0].id])).explain('queryPlanner'),
    StockItem.find(pickerFilter(branchId, 'red', 'prefix')).sort({ searchName: 1, _id: 1 }).explain('queryPlanner'),
    StockItem.find(pickerFilter(branchId, 'silk', 'contains')).sort({ searchName: 1, _id: 1 }).explain('queryPlanner'),
  ]);
  for (const p of plans) expect(JSON.stringify(p.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
  expect(JSON.stringify(plans[0].queryPlanner.winningPlan)).toContain('garment_unique');
  expect(JSON.stringify(plans[2].queryPlanner.winningPlan)).toContain('needs');
});
