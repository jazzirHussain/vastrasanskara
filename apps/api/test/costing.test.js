import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { addDaysYmd } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { stockHelpers } from './helpers/stock.js';
import { today } from './helpers/production.js';
import { VENDOR_GSTIN } from './helpers/expenses.js';
import { BillingDocument } from '../src/modules/billing/model.js';
import { Garment } from '../src/modules/orders/model.js';
import { StockMovement } from '../src/modules/stock/model.js';
import { creditNotesFilter, orderInvoicesFilter } from '../src/modules/billing/attribution.js';
import { orderRevenueLines } from '../src/modules/billing/service.js';
import {
  garmentConsumeFilter,
  materialCostTotal,
  movementDateFilter,
  stockItemProfit,
  stockValuation,
} from '../src/modules/stock/queries.js';
import { garmentCosts, orderProfits } from '../src/modules/costing/service.js';

useTestDb();
const app = buildTestApp();
const { world: billingWorld, draftFor, issue, act, advanceTo } = billingHelpers(app);
const { item } = stockHelpers(app);
const { ObjectId } = mongoose.Types;

let keys = 0;
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);

/**
 * The billing world plus `silk` (10 m at ₹1,000 a metre) and helpers: `take(lines, fields)` takes an
 * order for Meera (lines over a ₹10,000 blouse), `use(garment)` completes Materials ready as Meera,
 * `bill(order)` issues the order's bill, `spend(body)` adds an expense.
 */
async function world({ silkFields = {} } = {}) {
  const w = await billingWorld();
  const branchId = String(w.admin.user.branchId);
  const silk = await item(w.ops, { name: 'Silk', opening: { quantity: 10000, unitCost: 100000 }, ...silkFields });
  const take = async (lines, fields = {}) => {
    const r = await w.ops.agent.post('/v1/orders').set('Idempotency-Key', `k${++keys}`).send({
      customerId: w.customerId, designerId: String(w.d1.user._id), pickupDate: addDaysYmd(today(), 40), ...fields,
      garments: lines.map((l) => ({ type: 'blouse', description: 'Blouse', agreedPrice: 1000000, quantity: 1, ...l })),
    });
    ok(r);
    return r.body;
  };
  const use = (garment) => act(w.d1, garment, { action: 'complete' });
  const bill = async (order) => {
    const r = await issue(w.ops, await draftFor(order));
    ok(r);
    return r.body.invoice;
  };
  const spend = async (body) => {
    const r = await w.ops.agent.post('/v1/expenses').set('Idempotency-Key', `x${++keys}`).send({
      date: today(), category: 'rent', payee: { name: 'Lakshmi Textiles' }, mode: 'cash', ...body,
    });
    ok(r);
    return r.body.expense;
  };
  const silkLine = (quantity) => ({ stockItemId: silk.id, quantity });
  return { ...w, branchId, silk, take, use, bill, spend, silkLine };
}

const byGarment = (costs) => Object.fromEntries(costs.garments.map((g) => [g.id, g]));

test("a garment's margin is billed value less materials and expenses", async () => {
  const w = await world();
  const order = await w.take([{ quantity: 2, materials: [w.silkLine(2400)] }]);
  const [a, b] = order.garments;
  await w.use(a);
  await w.spend({ total: 200000, link: { kind: 'batch', id: a.batchId } });
  await w.bill(order);

  const costs = await garmentCosts(w.branchId, order.id);
  const g = byGarment(costs);
  expect(g[a.id]).toMatchObject({ revenue: 1000000, sharedRevenue: 0, material: 240000, expense: 100000, margin: 660000 });
  expect(g[a.id].materials).toEqual([{ stockItemId: w.silk.id, name: 'Silk', usageUnit: 'm', quantity: 2400, cost: 240000 }]);
  expect(g[a.id].expenses).toHaveLength(1);
  expect(g[b.id]).toMatchObject({ revenue: 1000000, material: 0, expense: 100000, margin: 900000 });
  expect(costs.order).toMatchObject({ id: order.id, orderNo: order.orderNo, revenue: 2000000, material: 240000, expense: 200000, margin: 1560000 });

  const r = await w.admin.agent.get(`/v1/costing/orders/${order.id}`);
  ok(r, 200);
  expect(r.body.order.margin).toBe(1560000);
  expect(r.body.garments.map((x) => [x.garmentNo, x.margin])).toEqual([[a.garmentNo, 660000], [b.garmentNo, 900000]]);
  expect((await w.ops.agent.get(`/v1/costing/orders/${order.id}`)).status).toBe(403);
  expect((await w.admin.agent.get(`/v1/costing/orders/${new ObjectId()}`)).status).toBe(404);
});

test("a credit note reduces the garment's billed value", async () => {
  const w = await world();
  const order = await w.take([{}, {}]);
  const bill = await w.bill(order);
  const line = bill.lines.find((l) => l.garmentId === order.garments[1].id);
  ok(await w.admin.agent.post(`/v1/billing/invoices/${bill.id}/credit-notes`).set('Idempotency-Key', 'cn1')
    .send({ reason: 'Discount after fitting', lines: [{ key: line.key, taxable: 250000 }] }));
  const g = byGarment(await garmentCosts(w.branchId, order.id));
  expect([g[order.garments[0].id].revenue, g[order.garments[1].id].revenue]).toEqual([1000000, 750000]);
  const lines = await orderRevenueLines(w.branchId, order.id);
  expect(lines.find((l) => l.lineKey === line.key)).toMatchObject({ invoiceId: bill.id, number: bill.number, garmentId: order.garments[1].id, taxable: 750000 });
});

test('a cancelled bill counts nothing', async () => {
  const w = await world();
  const order = await w.take([{}]);
  const bill = await w.bill(order);
  ok(await w.admin.agent.post(`/v1/billing/invoices/${bill.id}/cancel`).send({ reason: 'Billed by mistake' }), 200);
  expect(await orderRevenueLines(w.branchId, order.id)).toEqual([]);
  expect((await garmentCosts(w.branchId, order.id)).order.revenue).toBe(0);
});

test('a charge line counts for its garment', async () => {
  const w = await world();
  const order = await w.take([{}, {}]);
  const [a, b] = order.garments;
  const atTrials = await advanceTo(w.d1, b, 'trials_fittings');
  await act(w.admin, atTrials, { action: 'alteration', stage: 'trials_fittings', chargeable: true, readyBy: addDaysYmd(today(), 5) });
  await w.bill(order);
  const g = byGarment(await garmentCosts(w.branchId, order.id));
  expect([g[a.id].revenue, g[b.id].revenue]).toEqual([1000000, 1020000]);
  expect(g[b.id].sharedRevenue).toBe(0);
});

test("lines without a garment are shared across the order's garments", async () => {
  const w = await world();
  await w.addItem({
    name: 'Rush', kind: 'extra_charge', supplyType: 'service', hsnSac: '998821', defaultPrice: 100000,
    gstSlabs: [{ upToUnitPrice: null, rateBp: 1800 }], chargeFor: 'rush',
  });
  const order = await w.take([{}, {}, {}, {}], { priority: 'rush' });
  await Garment.updateOne({ _id: order.garments[3].id }, { status: 'cancelled' });
  const bill = await w.bill(order);
  expect(bill.lines.find((l) => l.source === 'rush').taxable).toBe(100000);
  const costs = await garmentCosts(w.branchId, order.id);
  expect(costs.garments.map((g) => g.sharedRevenue)).toEqual([33334, 33333, 33333, 0]);
  expect(costs.garments.map((g) => g.revenue)).toEqual([1033334, 1033333, 1033333, 0]);
  expect(costs.order.revenue).toBe(3100000);
});

test('GST that can be claimed is not a cost', async () => {
  const w = await world();
  const order = await w.take([{}, {}]);
  const [a, b] = order.garments;
  const gst = (itcEligible) => ({
    billNo: `INV-${itcEligible}`, billDate: today(), rateBp: 1800, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, itcEligible,
  });
  const payee = { name: 'Bengaluru Silks', gstin: VENDOR_GSTIN };
  await w.spend({ total: 118000, payee, gst: gst(true), link: { kind: 'garment', id: a.id } });
  await w.spend({ total: 118000, payee, gst: gst(false), link: { kind: 'garment', id: b.id } });
  const g = byGarment(await garmentCosts(w.branchId, order.id));
  expect([g[a.id].expense, g[b.id].expense]).toEqual([100000, 118000]);
});

test('order profit is the sum of garment margins', async () => {
  const w = await world();
  const order = await w.take([{ materials: [w.silkLine(1000)] }, { materials: [w.silkLine(2000)] }]);
  const [a, b] = order.garments;
  await w.use(a);
  await w.use(b);
  // The first garment was cut and then cancelled: its materials still cost the order.
  await Garment.updateOne({ _id: a.id }, { status: 'cancelled' });
  await w.bill(order);
  const costs = await garmentCosts(w.branchId, order.id);
  const g = byGarment(costs);
  expect(g[a.id]).toMatchObject({ revenue: 0, material: 100000, margin: -100000 });
  expect(g[b.id]).toMatchObject({ revenue: 1000000, material: 200000, margin: 800000 });
  expect(costs.order).toMatchObject({ revenue: 1000000, material: 300000, expense: 0, margin: 700000 });

  const other = await w.take([{}]);
  const profits = await orderProfits(w.branchId, [order.id, other.id]);
  expect(profits.get(order.id)).toEqual({ revenue: 1000000, material: 300000, expense: 0, profit: 700000 });
  expect(profits.get(other.id)).toEqual({ revenue: 0, material: 0, expense: 0, profit: 0 });
  await expect(orderProfits(w.branchId, Array.from({ length: 101 }, () => String(new ObjectId())))).rejects.toThrow();
});

test('a rejected garment shows its costs as a loss', async () => {
  const w = await world();
  const order = await w.take([{ materials: [w.silkLine(1500)] }]);
  const used = await w.use(order.garments[0]);
  await act(w.ops, used, { action: 'rejected', stage: 'pattern_making', reason: 'Refused', resolution: 'refund' });
  await w.spend({ total: 50000, link: { kind: 'garment', id: used.id } });
  const g = byGarment(await garmentCosts(w.branchId, order.id))[used.id];
  expect(g).toMatchObject({ status: 'rejected', revenue: 0, material: 150000, expense: 50000, margin: -200000 });
});

test('profit per stock item uses its selling price', async () => {
  const w = await world({ silkFields: { sellingPrice: 150000 } });
  const thread = await item(w.ops, { name: 'Thread', usageUnit: 'pcs', opening: { quantity: 10000, unitCost: 2000 } });
  const material = await w.addItem({
    name: 'Silk by the metre', kind: 'material', supplyType: 'goods', hsnSac: '5007', unit: 'MTR',
    defaultPrice: 150000, gstSlabs: [{ upToUnitPrice: null, rateBp: 500 }], stockItemId: w.silk.id,
  });
  const order = await w.take([{ materials: [w.silkLine(2000), { stockItemId: thread.id, quantity: 3000 }] }]);
  await w.use(order.garments[0]);
  // One metre sold over the counter.
  const blank = (await w.ops.agent.post('/v1/billing/invoices').send({ customerId: w.customerId })).body.invoice;
  const draft = await w.ops.agent.put(`/v1/billing/invoices/${blank.id}`).send({
    version: blank.version, invoiceDiscount: null, notes: '',
    lines: [{ key: 'm1', source: 'manual', itemId: material.id, garmentId: null, stageEventId: null, description: 'Silk', quantity: 1, rate: 150000, discount: 0, discountReason: '' }],
  });
  ok(draft, 200);
  ok(await issue(w.ops, draft.body.invoice));

  const rows = await stockItemProfit(w.branchId, { from: today(), to: today() });
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  expect(byName.Silk).toEqual({ stockItemId: w.silk.id, name: 'Silk', quantity: 3000, cost: 300000, sales: 450000, profit: 150000 });
  expect(byName.Thread).toEqual({ stockItemId: thread.id, name: 'Thread', quantity: 3000, cost: 6000, sales: null, profit: null });
});

test('material cost and stock value for a date range', async () => {
  const w = await world();
  const order = await w.take([{ materials: [w.silkLine(2000)] }, { materials: [w.silkLine(1000)] }]);
  await w.use(order.garments[0]);
  expect(await materialCostTotal(w.branchId, { from: today(), to: today() })).toBe(200000);
  expect(await materialCostTotal(w.branchId, { from: addDaysYmd(today(), 1), to: addDaysYmd(today(), 30) })).toBe(0);
  const valuation = await stockValuation(w.branchId);
  expect(valuation).toMatchObject({ value: 800000, reservedValue: 100000 });
  expect(valuation.items).toEqual([
    expect.objectContaining({ stockItemId: w.silk.id, name: 'Silk', onHand: 8000, reserved: 1000, value: 800000 }),
  ]);
});

test('costing queries use indexes', async () => {
  const w = await world();
  const ids = [new ObjectId()];
  const plans = await Promise.all([
    BillingDocument.find(orderInvoicesFilter(ids[0])).explain('queryPlanner'),
    BillingDocument.find(creditNotesFilter(ids)).explain('queryPlanner'),
    StockMovement.find(garmentConsumeFilter(ids)).explain('queryPlanner'),
    StockMovement.find(movementDateFilter(w.branchId, { from: today(), to: today() })).explain('queryPlanner'),
  ]);
  for (const plan of plans) {
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
  }
});

test("materials sold on the order's bills cost the order what they cost the shelf", async () => {
  const w = await world();
  const material = await w.addItem({
    name: 'Silk by the metre', kind: 'material', supplyType: 'goods', hsnSac: '5007', unit: 'MTR',
    defaultPrice: 150000, gstSlabs: [{ upToUnitPrice: null, rateBp: 500 }], stockItemId: w.silk.id,
  });
  const order = await w.take([{}, {}]);
  const draft = await draftFor(order);
  const keep = ({ key, source, itemId, garmentId, stageEventId, description, quantity, rate, discount, discountReason }) =>
    ({ key, source, itemId, garmentId, stageEventId, description, quantity, rate, discount, discountReason });
  const put = await w.ops.agent.put(`/v1/billing/invoices/${draft.id}`).send({
    version: draft.version, invoiceDiscount: null, notes: '',
    lines: [...draft.lines.map(keep), { key: 'silk', source: 'manual', itemId: material.id, garmentId: null, stageEventId: null, description: 'Silk', quantity: 2, rate: 150000, discount: 0, discountReason: '' }],
  });
  ok(put, 200);
  ok(await issue(w.ops, put.body.invoice));
  // 2 m sold at ₹1,500 cost ₹1,000 a metre from the shelf: ₹3,000 billed, ₹2,000 cost, shared by both blouses.
  const costs = await garmentCosts(w.branchId, order.id);
  expect(costs.garments.map((g) => [g.sharedRevenue, g.sharedMaterial, g.material])).toEqual([[150000, 100000, 100000], [150000, 100000, 100000]]);
  expect(costs.order).toMatchObject({ revenue: 2300000, material: 200000, margin: 2100000 });
});
