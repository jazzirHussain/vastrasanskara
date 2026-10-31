import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { addDaysYmd } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { expenseHelpers, VENDOR_GSTIN } from './helpers/expenses.js';
import { today } from './helpers/production.js';
import { Expense } from '../src/modules/expenses/model.js';
import { expenseCostForGarments } from '../src/modules/expenses/service.js';
import { expenseLinkFilter } from '../src/modules/expenses/costing.js';
import { Garment } from '../src/modules/orders/model.js';
import { costingGarmentFilter } from '../src/modules/orders/service.js';

useTestDb();
const app = buildTestApp();
const { world, add } = expenseHelpers(app);
const { ObjectId } = mongoose.Types;

let keys = 0;
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const paths = (r) => (r.body.error?.details ?? []).map((d) => d.path);

/** The expense world plus `take(lines)`: an order with the given garment lines. */
async function setup() {
  const w = await world();
  const customerId = (await w.ops.agent.post('/v1/customers').send({ name: 'Asha Rao', phone: '9876543210' })).body.id;
  const take = async (garments) => {
    const r = await w.ops.agent.post('/v1/orders').set('Idempotency-Key', `c${++keys}`).send({
      customerId,
      designerId: String(w.designer.user._id),
      pickupDate: addDaysYmd(today(), 40),
      garments: garments.map((g) => ({ type: 'blouse', description: 'Blouse', agreedPrice: 450000, quantity: 1, ...g })),
    });
    ok(r);
    return { order: r.body, garments: r.body.garments };
  };
  return { ...w, take };
}

const costs = async (branchId, garments) => {
  const map = await expenseCostForGarments(branchId, garments.map((g) => g.id));
  return garments.map((g) => map.get(g.id)?.cost ?? 0);
};

test('an expense links to a garment, a batch or an order', async () => {
  const { ops, take } = await setup();
  const { order, garments } = await take([
    { type: 'blouse', description: 'red silk' },
    { type: 'kurta', description: 'Kurta', quantity: 20 },
  ]);
  const [blouse, kurta] = [garments[0], garments[1]];

  const g = await add(ops, { link: { kind: 'garment', id: blouse.id } });
  ok(g);
  expect(g.body.expense.link).toEqual({
    kind: 'garment',
    id: blouse.id,
    orderId: order.id,
    orderNo: order.orderNo,
    label: `Blouse — red silk (…/${blouse.garmentNo.split('/').pop()})`,
  });

  const b = await add(ops, { link: { kind: 'batch', id: kurta.batchId } });
  ok(b);
  expect(b.body.expense.link).toEqual({
    kind: 'batch', id: kurta.batchId, orderId: order.id, orderNo: order.orderNo, label: `Batch of 20 Kurta on ${order.orderNo}`,
  });

  const o = await add(ops, { link: { kind: 'order', id: order.id } });
  ok(o);
  expect(o.body.expense.link).toEqual({
    kind: 'order', id: order.id, orderId: order.id, orderNo: order.orderNo, label: `Order ${order.orderNo}`,
  });
  const read = await ops.agent.get(`/v1/expenses/${o.body.expense.id}`);
  expect(read.body.expense.link).toEqual(o.body.expense.link);
  const stored = await Expense.findById(b.body.expense.id).lean();
  expect(stored.link).toEqual({ kind: 'batch', orderId: new ObjectId(order.id), garmentId: null, batchId: new ObjectId(kurta.batchId) });

  // Edit: change the link, then clear it.
  const e1 = await ops.agent.patch(`/v1/expenses/${g.body.expense.id}`).send({ version: 0, link: { kind: 'order', id: order.id } });
  ok(e1, 200);
  expect(e1.body.expense.link).toMatchObject({ kind: 'order', id: order.id, label: `Order ${order.orderNo}` });
  const e2 = await ops.agent.patch(`/v1/expenses/${g.body.expense.id}`).send({ version: 1, link: null });
  ok(e2, 200);
  expect(e2.body.expense.link).toBeNull();
});

test('a link to something that does not exist is refused', async () => {
  const { ops, take } = await setup();
  const { garments } = await take([{}]);
  for (const link of [
    { kind: 'garment', id: String(new ObjectId()) },
    { kind: 'batch', id: String(new ObjectId()) },
    { kind: 'order', id: String(new ObjectId()) },
    // A single garment has no batch; its id is not an order.
    { kind: 'order', id: garments[0].id },
  ]) {
    const r = await add(ops, { link });
    expect(r.status, JSON.stringify(link)).toBe(400);
    expect(paths(r)).toEqual(['link.id']);
  }
  expect(await Expense.countDocuments()).toBe(0);
  const saved = await add(ops);
  ok(saved);
  expect(saved.body.expense.number).toMatch(/\/0001$/);
  const edit = await ops.agent
    .patch(`/v1/expenses/${saved.body.expense.id}`)
    .send({ version: 0, link: { kind: 'garment', id: String(new ObjectId()) } });
  expect(edit.status).toBe(400);
  expect(paths(edit)).toEqual(['link.id']);
});

test('a batch expense splits equally and sums exactly', async () => {
  const { ops, take, branchId } = await setup();
  const { garments } = await take([{ quantity: 3 }, {}]);
  ok(await add(ops, { total: 100000, link: { kind: 'batch', id: garments[0].batchId } }));
  expect(await costs(branchId, garments)).toEqual([33334, 33333, 33333, 0]);
  const map = await expenseCostForGarments(branchId, [garments[1].id]);
  expect([...map.keys()]).toEqual([garments[1].id]);
  expect(map.get(garments[1].id).expenses).toEqual([
    { expenseId: expect.any(String), number: expect.stringMatching(/\/0001$/), kind: 'batch', share: 33333 },
  ]);
});

test("an order expense splits across the order's garments", async () => {
  const { ops, take, branchId } = await setup();
  const { order, garments } = await take([{ quantity: 2 }, {}, {}]);
  const other = await take([{}]);
  ok(await add(ops, { total: 100000, link: { kind: 'order', id: order.id } }));
  expect(await costs(branchId, [...garments, ...other.garments])).toEqual([25000, 25000, 25000, 25000, 0]);
});

test('a garment expense goes to that garment only', async () => {
  const { ops, take, branchId } = await setup();
  const { garments } = await take([{ quantity: 3 }]);
  ok(await add(ops, { total: 50000, link: { kind: 'garment', id: garments[1].id } }));
  ok(await add(ops, { total: 30000, link: { kind: 'garment', id: garments[1].id } }));
  expect(await costs(branchId, garments)).toEqual([0, 80000, 0]);
});

test('cancelled garments get no share', async () => {
  const { ops, take, branchId } = await setup();
  const { order, garments } = await take([{ quantity: 3 }]);
  await Garment.updateOne({ _id: garments[2].id }, { status: 'cancelled' });
  ok(await add(ops, { total: 100000, link: { kind: 'batch', id: garments[0].batchId } }));
  expect(await costs(branchId, garments)).toEqual([50000, 50000, 0]);

  // Everything cancelled: the expense counts nowhere.
  await Garment.updateMany({ orderId: order.id }, { status: 'cancelled' });
  ok(await add(ops, { total: 70000, link: { kind: 'order', id: order.id } }));
  expect(await costs(branchId, garments)).toEqual([0, 0, 0]);
});

test('rejected garments keep their share', async () => {
  const { ops, take, branchId } = await setup();
  const { garments } = await take([{ quantity: 2 }]);
  await Garment.updateOne({ _id: garments[0].id }, { status: 'rejected' });
  ok(await add(ops, { total: 100000, link: { kind: 'batch', id: garments[0].batchId } }));
  expect(await costs(branchId, garments)).toEqual([50000, 50000]);
});

test('GST is part of the cost only when it cannot be claimed', async () => {
  const { ops, take, branchId } = await setup();
  const [a, b] = (await take([{}, {}])).garments;
  const gst = (itcEligible) => ({
    billNo: 'INV-1', billDate: today(), rateBp: 1800, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, itcEligible,
  });
  const payee = { name: 'Bengaluru Silks', gstin: VENDOR_GSTIN };
  ok(await add(ops, { total: 118000, payee, gst: gst(true), link: { kind: 'garment', id: a.id } }));
  ok(await add(ops, { total: 118000, payee, gst: gst(false), link: { kind: 'garment', id: b.id } }));
  expect(await costs(branchId, [a, b])).toEqual([100000, 118000]);
});

test('a voided expense counts nothing', async () => {
  const { ops, take, branchId } = await setup();
  const { garments } = await take([{}]);
  const r = await add(ops, { total: 50000, link: { kind: 'garment', id: garments[0].id } });
  ok(r);
  ok(await ops.agent.post(`/v1/expenses/${r.body.expense.id}/void`).send({ version: 0, reason: 'Typed twice' }), 200);
  const map = await expenseCostForGarments(branchId, [garments[0].id]);
  expect(map.get(garments[0].id)).toEqual({ cost: 0, expenses: [] });
});

test('costing queries use indexes', async () => {
  const { branchId } = await setup();
  const ids = [new ObjectId()];
  const plans = await Promise.all([
    Garment.find(costingGarmentFilter(branchId, { garmentIds: ids, orderIds: ids, batchIds: ids })).explain('queryPlanner'),
    Garment.find(costingGarmentFilter(branchId, { batchIds: ids })).explain('queryPlanner'),
    Expense.find(expenseLinkFilter(branchId, { garmentIds: ids, batchIds: ids, orderIds: ids })).explain('queryPlanner'),
  ]);
  for (const plan of plans) {
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
  }
});
