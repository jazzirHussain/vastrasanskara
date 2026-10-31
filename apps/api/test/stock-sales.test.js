import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { stockHelpers } from './helpers/stock.js';
import { Invoice } from '../src/modules/billing/model.js';
import { StockItem, StockMovement } from '../src/modules/stock/model.js';

useTestDb();
const app = buildTestApp();
const { world, issue } = billingHelpers(app);
const { item, expectBalanced } = stockHelpers(app);

const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const GOODS_SLABS = [{ upToUnitPrice: null, rateBp: 500 }];

// A branch with 10 m of silk at 250 rupees a metre in stock and a material price-list item linked to it.
async function silkWorld() {
  const w = await world();
  const silk = await item(w.ops, { name: 'Silk', opening: { quantity: 10000, unitCost: 25000 } });
  const material = await w.addItem({
    name: 'Silk by the metre', kind: 'material', supplyType: 'goods', hsnSac: '5007', unit: 'MTR',
    defaultPrice: 40000, gstSlabs: GOODS_SLABS, stockItemId: silk.id,
  });
  return { ...w, silk, material };
}

const line = (key, over) => ({
  key, source: 'manual', itemId: null, garmentId: null, stageEventId: null, description: 'Line', quantity: 1, rate: 40000,
  discount: 0, discountReason: '', ...over,
});

// A blank draft for the customer holding the given lines.
async function draftWith(w, lines) {
  const blank = (await w.ops.agent.post('/v1/billing/invoices').send({ customerId: w.customerId })).body.invoice;
  const r = await w.ops.agent.put(`/v1/billing/invoices/${blank.id}`).send({
    version: blank.version, lines, invoiceDiscount: null, notes: '',
  });
  ok(r, 200);
  return r.body.invoice;
}
const cancel = (who, bill) => who.agent.post(`/v1/billing/invoices/${bill.id}/cancel`).send({ reason: 'Billed by mistake' });

test('a material sold on a bill leaves stock at average cost', async () => {
  const w = await silkWorld();
  const draft = await draftWith(w, [line('m1', { itemId: w.material.id, quantity: 2.5, description: 'Silk' })]);
  const r = await issue(w.ops, draft);
  ok(r);
  expect(await StockItem.findById(w.silk.id).lean()).toMatchObject({ onHand: 7500, value: 187500 });
  const sale = await StockMovement.findOne({ stockItemId: w.silk.id, type: 'sale' }).lean();
  expect(sale).toMatchObject({ quantity: 2500, onHandChange: -2500, valueChange: -62500 });
  expect(String(sale.invoiceId)).toBe(r.body.invoice.id);
  await expectBalanced(w.silk.id);
});

test('a garment line moves no stock', async () => {
  const w = await silkWorld();
  const order = await w.takeOrder();
  const draft = (await w.ops.agent.post('/v1/billing/invoices/from-order').send({ orderId: order.id })).body.invoice;
  ok(await issue(w.ops, draft));
  expect(await StockMovement.countDocuments({ type: 'sale' })).toBe(0);
  expect((await StockItem.findById(w.silk.id).lean()).onHand).toBe(10000);
});

test('not enough stock refuses the bill and takes no number', async () => {
  const w = await silkWorld();
  const draft = await draftWith(w, [line('m1', { itemId: w.material.id, quantity: 10.001 })]);
  const r = await issue(w.ops, draft);
  expect([r.status, r.body.error.code]).toEqual([422, 'STOCK_INSUFFICIENT']);
  const stored = await Invoice.findById(draft.id).lean();
  expect(stored.status).toBe('draft');
  expect(stored.number ?? null).toBeNull();
  expect(await mongoose.connection.collection('counters').countDocuments({ _id: /:invoice:/ })).toBe(0);
  expect(await StockMovement.countDocuments({ type: 'sale' })).toBe(0);
  expect((await StockItem.findById(w.silk.id).lean()).onHand).toBe(10000);
});

test('cancelling the bill puts the stock back at the same cost', async () => {
  const w = await silkWorld();
  const draft = await draftWith(w, [line('m1', { itemId: w.material.id, quantity: 4, description: 'Silk' })]);
  const bill = (await issue(w.ops, draft)).body.invoice;
  expect(await StockItem.findById(w.silk.id).lean()).toMatchObject({ onHand: 6000, value: 150000 });
  ok(await cancel(w.admin, bill), 200);
  expect(await StockItem.findById(w.silk.id).lean()).toMatchObject({ onHand: 10000, value: 250000 });
  const sales = await StockMovement.find({ stockItemId: w.silk.id, type: 'sale' }).sort({ at: 1, _id: 1 }).lean();
  expect(sales.map((s) => [s.quantity, s.valueChange])).toEqual([[4000, -100000], [-4000, 100000]]);
  expect(sales.every((s) => String(s.invoiceId) === bill.id)).toBe(true);
  await expectBalanced(w.silk.id);
});

test('a credit note moves no stock', async () => {
  const w = await silkWorld();
  const draft = await draftWith(w, [line('m1', { itemId: w.material.id, quantity: 2, description: 'Silk' })]);
  const bill = (await issue(w.ops, draft)).body.invoice;
  const r = await w.admin.agent
    .post(`/v1/billing/invoices/${bill.id}/credit-notes`)
    .set('Idempotency-Key', 'cn-1')
    .send({ reason: 'Returned', full: true, lines: [] });
  ok(r);
  expect(await StockMovement.countDocuments({ type: 'sale' })).toBe(1);
  expect((await StockItem.findById(w.silk.id).lean()).onHand).toBe(8000);
});
