import { test, expect, vi, afterEach } from 'vitest';
import { addDaysYmd, istDate } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { clock } from '../src/clock.js';
import { Garment, Order } from '../src/modules/orders/model.js';
useTestDb();
afterEach(() => vi.restoreAllMocks());
const app = buildTestApp();

let keys = 0;
const today = () => istDate(clock.now());

async function world() {
  const ops = await loginAs(app, { roles: ['operations'] });
  const d1 = await loginAs(app, { roles: ['designer'], name: 'Meera' });
  const d2 = await loginAs(app, { roles: ['designer'], name: 'Nila' });
  const customer = async (name, phone) => (await ops.agent.post('/v1/customers').send({ name, phone })).body.id;
  const asha = await customer('Asha Rao', '9876543210');
  const bhavna = await customer('Bhavna', '9123456789');
  const take = async ({ customerId = asha, designer = d1, days = 45, priority = 'normal' } = {}) =>
    (await ops.agent.post('/v1/orders').set('Idempotency-Key', `r${++keys}`).send({
      customerId, designerId: String(designer.user._id), priority, pickupDate: addDaysYmd(today(), days), expectedBudget: 5000000,
      garments: [{ type: 'blouse', description: 'Blouse', agreedPrice: 450000 }],
    })).body;
  return { ops, d1, d2, asha, bhavna, take };
}

test('designer sees only own orders and no money fields', async () => {
  const { d1, take, d2 } = await world();
  const mine = await take({ designer: d1 });
  const theirs = await take({ designer: d2 });
  const list = await d1.agent.get('/v1/orders');
  expect(list.status).toBe(200);
  expect(list.body.items.map((o) => o.id)).toEqual([mine.id]);
  const detail = await d1.agent.get(`/v1/orders/${mine.id}`);
  expect(detail.status).toBe(200);
  expect(detail.body.garments).toHaveLength(1);
  for (const body of [list.body, detail.body]) {
    const text = JSON.stringify(body);
    expect(text).not.toContain('agreedPrice');
    expect(text).not.toContain('expectedBudget');
  }
  expect((await d1.agent.get(`/v1/orders/${theirs.id}`)).status).toBe(404);
  expect((await d1.agent.get('/v1/orders').query({ designerId: String(d2.user._id) })).body.items).toEqual([]);
});
test('operations sees all with money', async () => {
  const { ops, take, d2 } = await world();
  await take();
  await take({ designer: d2 });
  const list = await ops.agent.get('/v1/orders');
  expect(list.body.items).toHaveLength(2);
  expect(list.body.items[0].thread).toMatchObject({ currentStage: 'order_taken', status: 'in_progress', tightSchedule: false, stagePlan: expect.any(Array) });
  expect(list.body.items[0].thread.stagePlan).toHaveLength(14);
  expect(list.body.items[0]).toMatchObject({ expectedBudget: 5000000, customer: { name: 'Asha Rao' }, designer: { name: 'Meera' }, garmentCount: 1, late: false, tight: false });
  const detail = await ops.agent.get(`/v1/orders/${list.body.items[0].id}`);
  expect(detail.body.garments[0].agreedPrice).toBe(450000);
  expect(detail.body.customer).toEqual({ id: expect.any(String), name: 'Asha Rao' });
});
test('filters by status, pickup range and search', async () => {
  const { ops, take, bhavna, d2 } = await world();
  const soon = await take({ days: 5, priority: 'rush' });
  const later = await take({ days: 30, customerId: bhavna, designer: d2 });
  await Order.updateOne({ _id: later.id }, { status: 'on_hold' });
  const ids = async (query) => (await ops.agent.get('/v1/orders').query(query)).body.items.map((o) => o.id);
  expect(await ids({})).toEqual([soon.id, later.id]);
  expect(await ids({ status: 'on_hold' })).toEqual([later.id]);
  expect(await ids({ priority: 'rush' })).toEqual([soon.id]);
  expect(await ids({ designerId: String(d2.user._id) })).toEqual([later.id]);
  expect(await ids({ pickupFrom: addDaysYmd(today(), 1), pickupTo: addDaysYmd(today(), 7) })).toEqual([soon.id]);
  expect(await ids({ q: 'bha' })).toEqual([later.id]);
  expect(await ids({ customerId: bhavna })).toEqual([later.id]);
  expect(await ids({ q: later.orderNo.slice(-4) })).toEqual([later.id]);
  expect(await ids({ q: later.orderNo })).toEqual([later.id]);
  expect((await ops.agent.get('/v1/orders').query({ status: 'lost' })).status).toBe(400);
});
test('pages orders by pickup date', async () => {
  const { ops, take } = await world();
  for (let i = 0; i < 3; i++) await take({ days: 10 + i });
  const first = await ops.agent.get('/v1/orders').query({ limit: 2 });
  const second = await ops.agent.get('/v1/orders').query({ limit: 2, cursor: first.body.nextCursor });
  expect([...first.body.items, ...second.body.items].map((o) => o.pickupDate)).toEqual([10, 11, 12].map((d) => addDaysYmd(today(), d)));
  expect(second.body.nextCursor).toBeNull();
});
test('late is suspended while on hold', async () => {
  const { ops, take } = await world();
  const order = await take({ days: 45 });
  await Garment.updateOne({ _id: order.garments[0].id, 'stagePlan.stage': 'materials_ready' }, { $set: { 'stagePlan.$.plannedDate': addDaysYmd(today(), -1) } });
  expect((await ops.agent.get(`/v1/orders/${order.id}`)).body.late).toBe(true);
  await Order.updateOne({ _id: order.id }, { status: 'on_hold' });
  expect((await ops.agent.get(`/v1/orders/${order.id}`)).body.late).toBe(false);
});
test('late filter returns only orders with a late garment', async () => {
  const { ops, take } = await world();
  const late = await take({ days: 45 });
  await take({ days: 46 });
  const held = await take({ days: 47 });
  const pastPlan = { $set: { 'stagePlan.$.plannedDate': addDaysYmd(today(), -1) } };
  for (const o of [late, held]) await Garment.updateOne({ _id: o.garments[0].id, 'stagePlan.stage': 'materials_ready' }, pastPlan);
  await Order.updateOne({ _id: held.id }, { status: 'on_hold' });
  const r = await ops.agent.get('/v1/orders').query({ late: 'true' });
  expect(r.body.items.map((o) => o.id)).toEqual([late.id]);
});
