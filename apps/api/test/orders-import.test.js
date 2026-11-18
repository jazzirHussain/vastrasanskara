import { test, expect, vi, afterEach } from 'vitest';
import { addDaysYmd, allowedActions, istDate } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { importHelpers, xlsx } from './helpers/imports.js';
import { clock } from '../src/clock.js';
import { AuditLog } from '../src/core/audit/model.js';
import { Outbox } from '../src/core/notify/models.js';
import { Garment, Order } from '../src/modules/orders/model.js';
import { StageEvent } from '../src/modules/production/model.js';
import { GarmentMaterials } from '../src/modules/stock/model.js';
import { importOrder } from '../src/modules/orders/service.js';

useTestDb();
afterEach(() => vi.restoreAllMocks());
const app = buildTestApp();
const { world: baseWorld, check, add, rows } = importHelpers(app);
const today = () => istDate(clock.now());
const HEAD = ['Old order no.', 'Customer phone', 'Designer', 'Order date', 'Pickup date', 'Garment type', 'Description', 'Price', 'Quantity', 'Stage'];
const dmy = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;

async function world() {
  const w = await baseWorld();
  const nila = await loginAs(app, { roles: ['designer'], name: 'Nila', email: 'nila@vs.in' });
  await w.admin.agent.post('/v1/customers').send({ name: 'Asha Rao', phone: '9876543210' });
  await w.admin.agent.post('/v1/customers').send({ name: 'Kavya', phone: '9123456789' });
  const orderDate = addDaysYmd(today(), -10);
  const pickup = addDaysYmd(today(), 20);
  const line = (overrides = {}) => {
    const v = { ref: '1234', phone: '9876543210', designer: 'Meera', orderDate, pickup, type: 'Blouse', description: 'Bridal blouse', price: 4500, quantity: 1, stage: 'Tailors', ...overrides };
    return [v.ref, v.phone, v.designer, dmy(v.orderDate), dmy(v.pickup), v.type, v.description, v.price, v.quantity, v.stage];
  };
  return { ...w, nila, orderDate, pickup, line };
}

test('an open order comes in with each garment at its stage', async () => {
  const { admin, line, orderDate } = await world();
  const run = await check(admin, 'orders', await xlsx([HEAD, line(), line({ type: 'Lehenga', stage: 'Finishing' }), line({ type: 'Kurta', stage: 'Ready for pickup' })]));
  expect(run.counts).toMatchObject({ ready: 3, error: 0 });
  const done = await add(admin, run);
  expect(done.counts.added).toBe(3);
  const [order] = await Order.find().lean();
  expect(order).toMatchObject({ legacyRef: '1234', orderDate, status: 'active' });
  const garments = await Garment.find({ orderId: order._id }).sort({ index: 1 }).lean();
  expect(garments.map((g) => [g.type, g.currentStage, g.stageState, g.status])).toEqual([
    ['blouse', 'tailors', 'pending', 'in_progress'],
    ['lehenga', 'finishing', 'pending', 'in_progress'],
    ['kurta', 'ready_for_pickup', 'pending', 'ready'],
  ]);
  expect(garments[2].readyDate).toBe(today());
  expect(garments[0].stagePlan.find((s) => s.stage === 'materials_ready').plannedDate >= orderDate).toBe(true);
  const events = await StageEvent.find({ orderId: order._id }).lean();
  expect(events).toHaveLength(3);
  expect(events.every((e) => e.action === 'imported' && e.remarks === 'Brought in from earlier records')).toBe(true);
  expect(events.map((e) => e.stage).sort()).toEqual(['finishing', 'ready_for_pickup', 'tailors']);
  const audit = await AuditLog.findOne({ entityType: 'order', entityId: String(order._id), action: 'import' }).lean();
  expect(audit.userAgent).toBe(`import:${run.id}`);
});

test('an imported order gets a new number and keeps the old one', async () => {
  const { admin, line } = await world();
  await add(admin, await check(admin, 'orders', await xlsx([HEAD, line({ ref: 'A-77' })])));
  const order = await Order.findOne().lean();
  expect(order.orderNo).toMatch(/^VS\/ORD\/\d{4}\/0001$/);
  const list = await admin.agent.get('/v1/orders').query({ q: 'A-77' });
  expect(list.body.items.map((o) => [o.orderNo, o.legacyRef])).toEqual([[order.orderNo, 'A-77']]);
  const detail = await admin.agent.get(`/v1/orders/${order._id}`);
  expect(detail.body.legacyRef).toBe('A-77');
});

test('the same old order number is never brought in twice', async () => {
  const { admin, line, branchId } = await world();
  const file = await xlsx([HEAD, line(), line({ type: 'Kurta' })]);
  await add(admin, await check(admin, 'orders', file));
  const again = await check(admin, 'orders', file);
  expect(again.counts).toMatchObject({ ready: 0, exists: 2 });
  const order = await Order.findOne().lean();
  const actor = { userId: admin.user._id, ip: null, userAgent: 'test' };
  const input = { legacyRef: '1234', customerId: String(order.customerId), designerId: String(order.designerId), pickupDate: addDaysYmd(today(), 5), garments: [{ type: 'blouse', description: 'x', agreedPrice: 100, quantity: 1, stage: 'tailors' }] };
  await expect(importOrder(branchId, input, actor)).rejects.toMatchObject({ status: 409, code: 'ORDER_EXISTS' });
  expect(await Order.countDocuments()).toBe(1);
});

test('an old order number written differently in a later file is the same order', async () => {
  const { admin, line, branchId } = await world();
  await add(admin, await check(admin, 'orders', await xlsx([HEAD, line({ ref: 'AB-12  Rush' })])));
  const again = await check(admin, 'orders', await xlsx([HEAD, line({ ref: ' ab-12 rush ' })]));
  expect(again.counts).toMatchObject({ ready: 0, exists: 1 });
  const order = await Order.findOne().lean();
  const actor = { userId: admin.user._id, ip: null, userAgent: 'test' };
  const input = { legacyRef: 'ab-12 RUSH', customerId: String(order.customerId), designerId: String(order.designerId), pickupDate: addDaysYmd(today(), 5), garments: [{ type: 'blouse', description: 'x', agreedPrice: 100, quantity: 1, stage: 'tailors' }] };
  await expect(importOrder(branchId, input, actor)).rejects.toMatchObject({ status: 409, code: 'ORDER_EXISTS' });
  expect(await Order.countDocuments()).toBe(1);
  expect(order.legacyRef).toBe('AB-12 Rush');
});

test('rows of one order must agree', async () => {
  const { admin, line } = await world();
  const run = await check(admin, 'orders', await xlsx([HEAD, line(), line({ phone: '9123456789' }), line({ ref: '99' })]));
  expect(run.counts).toMatchObject({ ready: 1, error: 2 });
  const errors = await rows(admin, run.id, 'error');
  expect(errors.map((r) => r.rowNo)).toEqual([2, 3]);
  expect(errors[1].errors).toEqual([{ column: 'Customer phone', message: 'Row 2 of this order has another customer.' }]);
  expect(errors[0].errors).toEqual([{ column: null, message: 'Another row of this order needs fixing (row 3).' }]);
  await add(admin, run);
  expect((await Order.find().lean()).map((o) => o.legacyRef)).toEqual(['99']);
});

test('a past pickup date is allowed and shows late', async () => {
  const { admin, line } = await world();
  await add(admin, await check(admin, 'orders', await xlsx([HEAD, line({ orderDate: addDaysYmd(today(), -40), pickup: addDaysYmd(today(), -3) })])));
  const [summary] = (await admin.agent.get('/v1/orders')).body.items;
  expect(summary.late).toBe(true);
  const future = await check(admin, 'orders', await xlsx([HEAD, line({ ref: '2', orderDate: addDaysYmd(today(), 2) })]));
  const done = await add(admin, future);
  expect(done.counts.failed).toBe(1);
  expect((await rows(admin, future.id, 'failed'))[0].errors[0].message).toMatch(/order date cannot be in the future/i);
});

test('picked-up garments are not open orders', async () => {
  const { admin, line } = await world();
  const run = await check(admin, 'orders', await xlsx([HEAD, line({ stage: 'Picked up' })]));
  expect((await rows(admin, run.id, 'error'))[0].errors).toEqual([{ column: 'Stage', message: 'Picked-up orders are not open. Leave this row out.' }]);
});

test('designers are matched by name or email', async () => {
  const { admin, line } = await world();
  await loginAs(app, { roles: ['designer'], name: 'Meera', email: 'meera.two@vs.in' });
  const run = await check(admin, 'orders', await xlsx([HEAD, line({ designer: 'NILA' }), line({ ref: '2', designer: 'nila@vs.in' }), line({ ref: '3', designer: 'Meera' }), line({ ref: '4', designer: 'Ghost' })]));
  expect(run.counts).toMatchObject({ ready: 2, error: 2 });
  const errors = await rows(admin, run.id, 'error');
  expect(errors[0].errors).toEqual([{ column: 'Designer', message: 'Two designers are called Meera — use their email.' }]);
  expect(errors[1].errors[0].message).toMatch(/^'Ghost' is not one of your designers/);
});

test('a customer must be brought in first', async () => {
  const { admin, line } = await world();
  const run = await check(admin, 'orders', await xlsx([HEAD, line({ phone: '9000000009' })]));
  expect((await rows(admin, run.id, 'error'))[0].errors).toEqual([{ column: 'Customer phone', message: 'No customer with phone 9000000009 — bring in customers first.' }]);
});

test('quantity makes a batch', async () => {
  const { admin, line } = await world();
  await add(admin, await check(admin, 'orders', await xlsx([HEAD, line({ quantity: 3 })])));
  const garments = await Garment.find().lean();
  expect(garments).toHaveLength(3);
  expect(new Set(garments.map((g) => String(g.batchId))).size).toBe(1);
  expect(await StageEvent.countDocuments({ action: 'imported' })).toBe(3);
});

test('imported orders send no messages and reserve no materials', async () => {
  const { admin, line } = await world();
  await Outbox.deleteMany({});
  await add(admin, await check(admin, 'orders', await xlsx([HEAD, line(), line({ stage: 'Ready for pickup', type: 'Gown' })])));
  expect(await Outbox.countDocuments()).toBe(0);
  expect(await GarmentMaterials.countDocuments()).toBe(0);
});

test('imported is never an allowed next action', async () => {
  const { admin, line, operations } = await world();
  await add(admin, await check(admin, 'orders', await xlsx([HEAD, line()])));
  const garment = await Garment.findOne().lean();
  expect(allowedActions(garment)).not.toContain('imported');
  expect(allowedActions(garment)).toContain('start');
  const r = await operations.agent.post('/v1/production/actions').send({ stage: 'tailors', action: 'imported', garments: [{ id: String(garment._id), version: garment.__v }] });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(await StageEvent.countDocuments()).toBe(1);
});
