import { test, expect, vi, afterEach } from 'vitest';
import { addDaysYmd, enquiryListQuery, permissionsFor } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { stockHelpers } from './helpers/stock.js';
import { enquiryBody } from './helpers/frontOffice.js';
import { today } from './helpers/production.js';
import { clock } from '../src/clock.js';
import { Branch } from '../src/modules/branches/model.js';
import { Customer } from '../src/modules/customers/model.js';
import { Order, Garment } from '../src/modules/orders/model.js';
import { StageEvent } from '../src/modules/production/model.js';
import { StockMovement } from '../src/modules/stock/model.js';
import { Enquiry } from '../src/modules/enquiries/model.js';
import { customerIdsOfType, customerTypeFilter } from '../src/modules/customers/service.js';
import {
  activeOrderCount,
  activeOrdersMatch,
  garmentsReadyBetween,
  garmentsReadyFilter,
  listOrdersPlaced,
  onHoldOrders,
  orderCounts,
  ordersPlacedMatch,
} from '../src/modules/orders/service.js';
import { qcFailureFilter, qcFailures, vendorOnTime, vendorReturnFilter, vendorSentFilter } from '../src/modules/production/service.js';
import { listMovementsByDate, movementsByDateFilter } from '../src/modules/stock/service.js';
import { enquiryListFilter, listEnquiries } from '../src/modules/enquiries/service.js';

useTestDb();
const app = buildTestApp();
const billing = billingHelpers(app);
const stock = stockHelpers(app);

afterEach(() => vi.restoreAllMocks());

let keys = 0;
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const on = (ymd) => vi.spyOn(clock, 'now').mockReturnValue(new Date(`${ymd}T06:30:00.000Z`));
const TODAY = today();
const ago = (n) => addDaysYmd(TODAY, -n);
const branchOf = async () => String((await Branch.findOne().lean())._id);
const userOf = (login) => ({ id: String(login.user._id), branchId: String(login.user.branchId), permissions: new Set(permissionsFor(login.user.roles)) });
const newCustomer = async (ops, body) => {
  const r = await ops.agent.post('/v1/customers').send(body);
  ok(r);
  return r.body.id;
};

/** Orders: d1 on day −5; d1 (rush) and d2 on day −2. */
async function orders() {
  const w = await billing.world();
  const branchId = await branchOf();
  on(ago(5));
  const early = await w.takeOrder({ designer: w.d1 });
  on(ago(2));
  const rush = await w.takeOrder({ designer: w.d1, priority: 'rush' });
  const other = await w.takeOrder({ designer: w.d2 });
  vi.restoreAllMocks();
  return { ...w, branchId, early, rush, other };
}

test('orders placed are counted by order date in the user\'s scope', async () => {
  const { branchId, admin, d1, early, rush, other } = await orders();
  const range = { from: ago(3), to: TODAY };
  expect(await orderCounts(branchId, userOf(admin), range)).toEqual({ placed: 2, byPriority: { normal: 1, rush: 1 } });
  expect(await orderCounts(branchId, userOf(admin), { from: ago(10), to: TODAY })).toMatchObject({ placed: 3 });
  expect(await orderCounts(branchId, userOf(d1), { from: ago(10), to: TODAY })).toEqual({ placed: 2, byPriority: { normal: 1, rush: 1 } });

  const page = await listOrdersPlaced(branchId, userOf(admin), { from: ago(10), to: TODAY, limit: 2 });
  expect(page.items).toHaveLength(2);
  expect(page.items[0]).toEqual(expect.objectContaining({ order: expect.any(Object), garments: expect.any(Array), customerName: 'Asha Rao' }));
  const rest = await listOrdersPlaced(branchId, userOf(admin), { from: ago(10), to: TODAY, limit: 2, cursor: page.nextCursor });
  expect([...page.items, ...rest.items].map((i) => String(i.order._id))).toEqual(
    expect.arrayContaining([early.id, rush.id, other.id]),
  );
  expect(rest.items.map((i) => String(i.order._id))).toEqual([early.id]);
  expect(rest.nextCursor).toBeNull();
});

test('a designer filter cannot widen a designer\'s scope', async () => {
  const { branchId, d1, d2, early } = await orders();
  const d2Id = String(d2.user._id);
  const range = { from: ago(10), to: TODAY };
  expect(await orderCounts(branchId, userOf(d1), { ...range, designerId: d2Id })).toEqual({ placed: 0, byPriority: { normal: 0, rush: 0 } });
  expect((await listOrdersPlaced(branchId, userOf(d1), { ...range, designerId: d2Id })).items).toEqual([]);
  expect(await activeOrderCount(branchId, userOf(d1), { designerId: d2Id })).toBe(0);
  expect(await activeOrderCount(branchId, userOf(d1), {})).toBe(2);
  await billing.makeReady(d1, early.garments[0]);
  expect((await garmentsReadyBetween(branchId, userOf(d1), { ...range, designerId: d2Id })).items).toEqual([]);
  expect((await garmentsReadyBetween(branchId, userOf(d2), range)).items).toEqual([]);
  expect((await garmentsReadyBetween(branchId, userOf(d1), range)).items).toHaveLength(1);
});

test('priority and customer type filters narrow orders', async () => {
  const { branchId, admin, ops, d1 } = await orders();
  const biz = await newCustomer(ops, { name: 'Sri Silks', phone: '9876500001', type: 'business' });
  const bizOrder = (await ops.agent.post('/v1/orders').set('Idempotency-Key', `md${++keys}`).send({
    customerId: biz, designerId: String(d1.user._id), pickupDate: addDaysYmd(TODAY, 30),
    garments: [{ type: 'blouse', description: 'Blouse', agreedPrice: 100000, quantity: 1 }],
  })).body;
  const range = { from: ago(10), to: TODAY };
  const user = userOf(admin);
  expect(await orderCounts(branchId, user, { ...range, priority: 'rush' })).toEqual({ placed: 1, byPriority: { normal: 0, rush: 1 } });
  const business = await customerIdsOfType(branchId, 'business');
  expect(business).toEqual({ in: [expect.anything()] });
  expect(business.in.map(String)).toEqual([biz]);
  expect(await orderCounts(branchId, user, { ...range, customerFilter: business })).toEqual({ placed: 1, byPriority: { normal: 1, rush: 0 } });
  expect((await listOrdersPlaced(branchId, user, { ...range, customerFilter: business })).items.map((i) => String(i.order._id))).toEqual([bizOrder.id]);
  expect(await activeOrderCount(branchId, user, { customerFilter: business })).toBe(1);
  expect(await activeOrderCount(branchId, user, { priority: 'rush' })).toBe(1);

  // On hold: one of Asha's orders.
  const held = await Order.findOne({ customerId: { $ne: biz }, priority: 'normal' });
  await Order.updateOne({ _id: held._id }, { status: 'on_hold' });
  expect((await onHoldOrders(branchId, user, {})).items.map((i) => String(i.order._id))).toEqual([String(held._id)]);
  expect((await onHoldOrders(branchId, user, { customerFilter: business })).items).toEqual([]);
});

test('customer type individual excludes business and film customers', async () => {
  const { branchId, admin, ops, customerId } = await orders();
  const biz = await newCustomer(ops, { name: 'Sri Silks', phone: '9876500001', type: 'business' });
  const film = await newCustomer(ops, { name: 'Film Co', phone: '9876500002', type: 'film_production' });
  const individual = await customerIdsOfType(branchId, 'individual');
  expect(Object.keys(individual)).toEqual(['notIn']);
  expect(individual.notIn.map(String).sort()).toEqual([biz, film].sort());
  expect((await customerIdsOfType(branchId, 'film_production')).in.map(String)).toEqual([film]);
  expect(await orderCounts(branchId, userOf(admin), { from: ago(10), to: TODAY, customerFilter: individual })).toMatchObject({ placed: 3 });
  expect(customerId).toBeTruthy();

  await expect(customerIdsOfType(branchId, 'individual', { cap: 1 })).rejects.toMatchObject({
    status: 422, code: 'FILTER_TOO_BROAD', message: 'Too many customers for this filter',
  });
});

test('garments ready in a period are on time by their original due date', async () => {
  const { admin, d1, takeOrder } = await billing.world();
  const branchId = await branchOf();
  const { makeReady } = billing;
  const late = await takeOrder({ designer: d1 });
  const fine = await takeOrder({ designer: d1, prices: [200000] });
  const noDue = await takeOrder({ designer: d1, prices: [300000] });
  await makeReady(d1, late.garments[0]);
  await makeReady(d1, fine.garments[0]);
  await makeReady(d1, noDue.garments[0]);
  // The pickup date was moved later; the garment is judged by the date first promised.
  await Garment.updateOne({ _id: late.garments[0].id }, { originalDueDate: ago(1), dueDate: addDaysYmd(TODAY, 5) });
  await Garment.updateOne({ _id: fine.garments[0].id }, { originalDueDate: TODAY });
  await Garment.updateOne({ _id: noDue.garments[0].id }, { originalDueDate: null });
  await Order.updateOne({ _id: noDue.id }, { originalPickupDate: addDaysYmd(TODAY, 2) });

  const out = await garmentsReadyBetween(branchId, userOf(admin), { from: ago(1), to: TODAY });
  expect(out.truncated).toBe(false);
  const byId = new Map(out.items.map((i) => [i.garmentId, i]));
  expect(byId.get(late.garments[0].id)).toEqual({
    garmentId: late.garments[0].id, garmentNo: late.garments[0].garmentNo, orderId: late.id, orderNo: late.orderNo,
    designerId: String(d1.user._id), readyDate: TODAY, dueDate: ago(1), onTime: false,
  });
  expect(byId.get(fine.garments[0].id)).toMatchObject({ dueDate: TODAY, onTime: true });
  expect(byId.get(noDue.garments[0].id)).toMatchObject({ dueDate: addDaysYmd(TODAY, 2), onTime: true });
  expect((await garmentsReadyBetween(branchId, userOf(admin), { from: ago(5), to: ago(1) })).items).toEqual([]);
  expect((await garmentsReadyBetween(branchId, userOf(admin), { from: ago(1), to: TODAY, priority: 'rush' })).items).toEqual([]);
});

test('QC failures in the last seven days on open garments', async () => {
  const w = await billing.world();
  const branchId = await branchOf();
  const fail = async (garment) => billing.act(w.d1, await billing.advanceTo(w.d1, garment, 'quality_check'), { action: 'qc_fail', reworkStage: 'handwork', remarks: 'Loose beads' });
  on(ago(10));
  const old = await w.takeOrder({ designer: w.d1 });
  await fail(old.garments[0]);
  vi.restoreAllMocks();
  const recent = await w.takeOrder({ designer: w.d1 });
  await fail(recent.garments[0]);
  const closed = await w.takeOrder({ designer: w.d1 });
  await fail(closed.garments[0]);
  await Garment.updateOne({ _id: closed.garments[0].id }, { status: 'picked_up' });

  const since = ago(7);
  const rows = await qcFailures(branchId, userOf(w.admin), { since });
  expect(rows).toEqual([
    {
      garmentId: recent.garments[0].id, garmentNo: recent.garments[0].garmentNo, orderId: recent.id,
      stage: 'quality_check', at: expect.any(Date), reason: 'Loose beads',
    },
  ]);
  expect(await qcFailures(branchId, userOf(w.d2), { since })).toEqual([]);
});

test('vendor returns are on time by the due-back date', async () => {
  const w = await billing.world();
  const branchId = await branchOf();
  const out = async (dueBackDate) => {
    const g = await billing.advanceTo(w.d1, (await w.takeOrder({ designer: w.d1 })).garments[0], 'handwork');
    return billing.act(w.d1, g, { action: 'sent_to_vendor', vendorId: w.vendor.id, dueBackDate });
  };
  on(ago(6));
  const a = await out(ago(2));
  const b = await out(ago(4));
  on(ago(3));
  await billing.act(w.d1, a, { action: 'returned_from_vendor' });
  on(ago(1));
  await billing.act(w.d1, b, { action: 'returned_from_vendor' });
  vi.restoreAllMocks();

  expect(await vendorOnTime(branchId, { from: ago(5), to: TODAY })).toEqual([
    { vendorId: w.vendor.id, name: 'Zari works', returned: 2, onTime: 1 },
  ]);
  expect(await vendorOnTime(branchId, { from: ago(2), to: TODAY })).toEqual([
    { vendorId: w.vendor.id, name: 'Zari works', returned: 1, onTime: 0 },
  ]);
});

test('stock movements list by date across items', async () => {
  const { ops, branchId } = await stock.world();
  on(ago(3));
  await stock.item(ops, { name: 'Old silk', opening: { quantity: 1000, unitCost: 25000 } });
  on(ago(1));
  const cotton = await stock.item(ops, { name: 'Cotton', opening: { quantity: 2000, unitCost: 10000 } });
  on(TODAY);
  const lace = await stock.item(ops, { name: 'Lace', opening: { quantity: 500, unitCost: 4000 } });
  vi.restoreAllMocks();

  const first = await listMovementsByDate(branchId, { from: ago(2), to: TODAY, limit: 1 });
  expect(first.items).toEqual([
    {
      id: expect.any(String), date: TODAY, type: 'opening', item: { id: lace.id, name: 'Lace', usageUnit: lace.usageUnit },
      quantity: 500, valueChange: expect.any(Number), reference: { garmentNo: null }, reason: expect.any(String),
    },
  ]);
  const second = await listMovementsByDate(branchId, { from: ago(2), to: TODAY, limit: 1, cursor: first.nextCursor });
  expect(second.items.map((m) => [m.item.name, m.date])).toEqual([['Cotton', ago(1)]]);
  expect(second.nextCursor).toBeNull();
  expect(cotton.id).toBeTruthy();
});

test('enquiries filter by source and date', async () => {
  const { ops } = await billing.world();
  const branchId = await branchOf();
  const add = async (body) => {
    const r = await ops.agent.post('/v1/enquiries').set('Idempotency-Key', `mde${++keys}`).send(enquiryBody(body));
    ok(r);
    return r.body.enquiry;
  };
  on(ago(5));
  await add({ name: 'Old Insta', phone: '9845000101', source: 'instagram' });
  on(ago(1));
  const recent = await add({ name: 'New Insta', phone: '9845000102', source: 'instagram' });
  await add({ name: 'Walk in', phone: '9845000103', source: 'walk_in' });
  vi.restoreAllMocks();

  const query = enquiryListQuery.parse({ view: 'open', source: 'instagram', from: ago(2), to: TODAY });
  expect(query).toMatchObject({ source: 'instagram', from: ago(2), to: TODAY });
  const page = await listEnquiries(branchId, query, { today: TODAY });
  expect(page.items.map((e) => String(e._id))).toEqual([recent.id]);
  expect(enquiryListQuery.safeParse({ source: 'pigeon' }).success).toBe(false);
});

test('M8 data queries use indexes', async () => {
  const { branchId, admin, d1 } = await orders();
  const stages = (explained) => {
    const plan = explained.queryPlanner?.winningPlan;
    const names = [];
    const walk = (node) => {
      if (!node) return;
      names.push(node.stage);
      walk(node.inputStage);
      (node.inputStages ?? []).forEach(walk);
      walk(node.queryPlan);
    };
    walk(plan);
    return names;
  };
  const range = { from: ago(10), to: TODAY };
  const customerFilter = { in: [String(branchId)] };
  const finds = [
    [Order, ordersPlacedMatch(branchId, userOf(d1), { ...range, designerId: String(d1.user._id), priority: 'rush', customerFilter })],
    [Order, activeOrdersMatch(branchId, userOf(admin), { customerFilter })],
    [Garment, garmentsReadyFilter(branchId, range)],
    [Customer, customerTypeFilter(branchId, 'business')],
    [Customer, customerTypeFilter(branchId, 'individual')],
    [StageEvent, qcFailureFilter(branchId, { since: ago(7) })],
    [StageEvent, vendorReturnFilter(branchId, range)],
    [StageEvent, vendorSentFilter([String(branchId)])],
    [StockMovement, movementsByDateFilter(branchId, range)],
    [Enquiry, enquiryListFilter(branchId, { view: 'open', source: 'instagram', ...range }, { today: TODAY })],
    [Enquiry, enquiryListFilter(branchId, { view: 'converted', ...range }, { today: TODAY })],
  ];
  for (const [Model, filter] of finds) {
    const names = stages(await Model.find(filter).explain('queryPlanner'));
    expect(names, `${Model.modelName} ${JSON.stringify(filter)}`).toContain('IXSCAN');
    expect(names, `${Model.modelName} ${JSON.stringify(filter)}`).not.toContain('COLLSCAN');
  }
});
