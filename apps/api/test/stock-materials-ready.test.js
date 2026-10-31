import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { addDaysYmd, istDate } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { stockHelpers } from './helpers/stock.js';
import { clock } from '../src/clock.js';
import { GarmentMaterials, PurchaseRequest, StockItem, StockMovement } from '../src/modules/stock/model.js';

useTestDb();
const app = buildTestApp();
const { world: stockWorld, item, expectBalanced } = stockHelpers(app);

const MONEY_KEYS = ['cost', 'usedCost', 'value', 'valueChange', 'avgCost', 'sellingPrice', 'price', 'total', 'revenue', 'margin', 'profit'];
const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const today = () => istDate(clock.now());
let keys = 0;

async function world() {
  const w = await stockWorld();
  const customerId = (await w.ops.agent.post('/v1/customers').send({ name: 'Asha Rao', phone: '9876543210' })).body.id;
  /** Takes an order for the world's designer; answers its garments. */
  async function take(garments) {
    const r = await w.ops.agent.post('/v1/orders').set('Idempotency-Key', `m${++keys}`).send({
      customerId,
      designerId: String(w.designer.user._id),
      pickupDate: addDaysYmd(today(), 40),
      garments: garments.map((g) => ({ type: 'blouse', description: 'Blouse', agreedPrice: 450000, ...g })),
    });
    ok(r, 201);
    return r.body.garments.map((g) => ({ ...g, orderId: r.body.id }));
  }
  /** A stage action by the designer at the garments' working stage. */
  const act = (garments, body, who = w.designer) =>
    who.agent.post('/v1/production/actions').send({
      stage: 'materials_ready',
      garments: garments.map((g) => ({ id: g.id, version: g.version })),
      ...body,
    });
  return { ...w, take, act };
}

const silkWith = (ops, metres, fields = {}) =>
  item(ops, { ...(metres ? { opening: { quantity: metres * 1000, unitCost: 25000 } } : {}), ...fields });
const buttonsWith = (ops, pieces) =>
  item(ops, { name: 'Gold buttons', usageUnit: 'pcs', opening: { quantity: pieces * 1000, unitCost: 100 } });
const line = (stockItem, quantity) => ({ stockItemId: stockItem.id, quantity });
const usedOf = (garment, stockItem, quantity) => ({ garmentId: garment.id, stockItemId: stockItem.id, quantity });
const stored = (id) => StockItem.findById(id).lean();
const doc = (garmentId) => GarmentMaterials.findOne({ garmentId }).lean();
const lineOf = async (garmentId, stockItem) => (await doc(garmentId)).lines.find((l) => String(l.stockItemId) === stockItem.id);
const view = (who, garmentId) => who.agent.get(`/v1/stock/garments/${garmentId}/materials`);
const plan = (who, garmentId, version, lines) => who.agent.put(`/v1/stock/garments/${garmentId}/materials`).send({ version, lines });
const change = (who, garmentId, version, changes, note) =>
  who.agent.post(`/v1/stock/garments/${garmentId}/materials/used`).send({ version, changes, ...(note && { note }) });
const movements = (id, type) =>
  StockMovement.find({ stockItemId: new mongoose.Types.ObjectId(id), ...(type && { type }) }).sort({ at: 1, _id: 1 }).lean();
const garmentNow = async (ops, garment) =>
  (await ops.agent.get(`/v1/orders/${garment.orderId}`)).body.garments.find((g) => g.id === garment.id);

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

test('completing Materials ready uses the plan and releases the rest', async () => {
  const { ops, take, act } = await world();
  const silk = await silkWith(ops, 10);
  const [a, b] = await take([{ materials: [line(silk, 3000)] }, { description: 'Second', materials: [line(silk, 3000)] }]);
  expect(await stored(silk.id)).toMatchObject({ onHand: 10000, reserved: 6000 });

  let r = await act([a], { action: 'complete' });
  ok(r);
  expect(r.body.garments[0].currentStage).toBe('pattern_making');
  expect(await stored(silk.id)).toMatchObject({ onHand: 7000, reserved: 3000 });
  expect(await lineOf(a.id, silk)).toMatchObject({ planned: 3000, reserved: 0, used: 3000, usedCost: 75000, state: 'used' });
  const [consumed] = await movements(silk.id, 'consume');
  expect(consumed).toMatchObject({ quantity: 3000, onHandChange: -3000, reservedChange: -3000, valueChange: -75000 });
  expect(String(consumed.garmentId)).toBe(a.id);
  expect(String(consumed.orderId)).toBe(a.orderId);

  // The designer corrects 3 m to 2.5 m: 2.5 m used, 0.5 m back to free stock.
  r = await act([b], { action: 'complete', materialsUsed: [usedOf(b, silk, 2500)] });
  ok(r);
  expect(await stored(silk.id)).toMatchObject({ onHand: 4500, reserved: 0 });
  expect(await lineOf(b.id, silk)).toMatchObject({ planned: 3000, reserved: 0, used: 2500, usedCost: 62500, state: 'used' });
  expect((await movements(silk.id)).filter((m) => String(m.garmentId) === b.id).map((m) => [m.type, m.quantity])).toEqual([
    ['reserve', 3000], ['consume', 2500], ['release', 500],
  ]);
  const card = await view(ops, b.id);
  expect(card.body.lines).toEqual([expect.objectContaining({ planned: 3000, reserved: 0, used: 2500, state: 'used', short: 0 })]);
  await expectBalanced(silk.id);
});

test('a used quantity for a material not on the garment is refused', async () => {
  const { ops, take, act } = await world();
  const silk = await silkWith(ops, 10);
  const buttons = await buttonsWith(ops, 100);
  const [g] = await take([{ materials: [line(silk, 3000)] }]);
  const r = await act([g], { action: 'complete', materialsUsed: [usedOf(g, silk, 3000), usedOf(g, buttons, 4000)] });
  ok(r, 400);
  expect(r.body.error.details).toEqual([{ path: 'materialsUsed.1', message: 'This material is not on the garment' }]);
  expect((await garmentNow(ops, g)).currentStage).toBe('order_taken');
  expect(await movements(silk.id, 'consume')).toEqual([]);
});

test('using more than reserved takes from free stock', async () => {
  const { ops, take, act } = await world();
  const silk = await silkWith(ops, 10);
  const [g, other] = await take([{ materials: [line(silk, 3000)] }, { description: 'Other', materials: [line(silk, 2000)] }]);
  ok(await act([g], { action: 'complete', materialsUsed: [usedOf(g, silk, 4000)] }));
  // 3 m from the reservation, 1 m from free stock; the other garment's 2 m stays reserved.
  expect(await stored(silk.id)).toMatchObject({ onHand: 6000, reserved: 2000 });
  const [consumed] = await movements(silk.id, 'consume');
  expect(consumed).toMatchObject({ quantity: 4000, reservedChange: -3000 });
  expect(await lineOf(g.id, silk)).toMatchObject({ used: 4000, reserved: 0 });
  expect(await lineOf(other.id, silk)).toMatchObject({ reserved: 2000, state: 'planned' });
  await expectBalanced(silk.id);
});

test('a corrected quantity larger than the stock refuses the stage action', async () => {
  const { ops, take, act } = await world();
  const silk = await silkWith(ops, 5);
  const [g] = await take([{ materials: [line(silk, 3000)] }, { description: 'Other', materials: [line(silk, 2000)] }]);
  const r = await act([g], { action: 'complete', materialsUsed: [usedOf(g, silk, 4000)] });
  ok(r, 422);
  expect(r.body.error).toMatchObject({ code: 'STOCK_INSUFFICIENT', details: { stockItemId: silk.id, name: 'Red silk', free: 0 } });
  expect((await garmentNow(ops, g)).currentStage).toBe('order_taken');
  expect(await movements(silk.id, 'consume')).toEqual([]);
  expect(await stored(silk.id)).toMatchObject({ onHand: 5000, reserved: 5000 });
  expect(await lineOf(g.id, silk)).toMatchObject({ reserved: 3000, used: 0, state: 'planned' });
});

test('skipping Materials ready also uses the materials', async () => {
  const { ops, take, act } = await world();
  const silk = await silkWith(ops, 10);
  const [g] = await take([{ materials: [line(silk, 2000)] }]);
  ok(await act([g], { action: 'skip', reason: 'Cut from the roll already' }));
  expect(await stored(silk.id)).toMatchObject({ onHand: 8000, reserved: 0 });
  expect(await lineOf(g.id, silk)).toMatchObject({ used: 2000, state: 'used' });
});

test('a corrected quantity of nothing releases the line', async () => {
  const { ops, take, act } = await world();
  const silk = await silkWith(ops, 10);
  const [g] = await take([{ materials: [line(silk, 2000)] }]);
  ok(await act([g], { action: 'complete', materialsUsed: [usedOf(g, silk, 0)] }));
  expect(await stored(silk.id)).toMatchObject({ onHand: 10000, reserved: 0 });
  expect(await movements(silk.id, 'consume')).toEqual([]);
  expect(await lineOf(g.id, silk)).toMatchObject({ used: 0, reserved: 0, state: 'used' });
});

test('a bulk Materials ready is all or nothing', async () => {
  const { ops, take, act } = await world();
  const silk = await silkWith(ops, 5);
  const [a, b] = await take([{ materials: [line(silk, 2000)] }, { description: 'Second', materials: [line(silk, 2000)] }]);
  // 1 m is free: the second garment's 4 m needs 2 m more than its reservation.
  const r = await act([a, b], { action: 'complete', materialsUsed: [usedOf(a, silk, 2000), usedOf(b, silk, 4000)] });
  ok(r, 422);
  expect(r.body.error.code).toBe('STOCK_INSUFFICIENT');
  for (const g of [a, b]) {
    expect((await garmentNow(ops, g)).currentStage).toBe('order_taken');
    expect(await lineOf(g.id, silk)).toMatchObject({ reserved: 2000, used: 0, state: 'planned' });
  }
  expect(await movements(silk.id, 'consume')).toEqual([]);
  expect(await stored(silk.id)).toMatchObject({ onHand: 5000, reserved: 4000 });

  // Both together when there is enough.
  ok(await act([a, b], { action: 'complete', materialsUsed: [usedOf(b, silk, 3000)] }));
  expect(await stored(silk.id)).toMatchObject({ onHand: 0, reserved: 0, value: 0 });
  await expectBalanced(silk.id);
});

test("the garment's open requests are dropped once its materials are used", async () => {
  const { ops, take, act } = await world();
  const silk = await silkWith(ops, 2);
  const [g] = await take([{ materials: [line(silk, 3000)] }]);
  let [request] = await PurchaseRequest.find({ stockItemId: silk.id }).lean();
  expect(request).toMatchObject({ status: 'requested', quantity: 1000 });
  ok(await act([g], { action: 'complete', materialsUsed: [usedOf(g, silk, 2000)] }));
  [request] = await PurchaseRequest.find({ stockItemId: silk.id }).lean();
  expect(request).toMatchObject({ status: 'cancelled', needs: [], cancellation: { reason: 'No longer needed' } });
  expect(await stored(silk.id)).toMatchObject({ onHand: 0, reserved: 0 });
});

/** Takes the garment through Materials ready, then back to it by a rework from Pattern making. */
async function backToMaterialsReady({ act, designer }, g) {
  let r = await act([g], { action: 'complete' });
  ok(r);
  r = await designer.agent.post('/v1/production/actions').send({
    action: 'rework', stage: 'pattern_making', reworkStage: 'materials_ready', garments: [{ id: g.id, version: r.body.garments[0].version }],
  });
  ok(r);
  return r.body.garments[0];
}

test('a rework back to Materials ready uses only what is still planned', async () => {
  const w = await world();
  const { ops, designer, take, act } = w;
  const silk = await silkWith(ops, 10);
  const buttons = await buttonsWith(ops, 100);
  const [g] = await take([{ materials: [line(silk, 2000)] }]);
  const back = await backToMaterialsReady(w, g);
  expect(back.currentStage).toBe('materials_ready');
  const card = (await view(designer, g.id)).body;
  ok(await plan(designer, g.id, card.version, [line(silk, 2000), line(buttons, 6000)]));
  ok(await act([back], { action: 'complete', materialsUsed: [usedOf(g, buttons, 5000)] }));
  expect(await stored(silk.id)).toMatchObject({ onHand: 8000, reserved: 0 });
  expect(await stored(buttons.id)).toMatchObject({ onHand: 95000, reserved: 0 });
  expect(await movements(silk.id, 'consume')).toHaveLength(1);
  expect(await lineOf(g.id, silk)).toMatchObject({ used: 2000, state: 'used' });
  expect(await lineOf(g.id, buttons)).toMatchObject({ planned: 6000, used: 5000, state: 'used' });
  await expectBalanced(silk.id);
  await expectBalanced(buttons.id);
});

test('rejecting a garment with used materials releases only the planned ones', async () => {
  const w = await world();
  const { ops, designer, take } = w;
  const silk = await silkWith(ops, 10);
  const buttons = await buttonsWith(ops, 100);
  // A second garment keeps the order open after the rejection.
  const [g] = await take([{ materials: [line(silk, 2000)] }, { description: 'Other' }]);
  const back = await backToMaterialsReady(w, g);
  const card = (await view(designer, g.id)).body;
  ok(await plan(designer, g.id, card.version, [line(silk, 2000), line(buttons, 6000)]));
  expect((await stored(buttons.id)).reserved).toBe(6000);
  ok(await ops.agent.post('/v1/production/actions').send({
    action: 'rejected', stage: 'materials_ready', reason: 'Refused', resolution: 'refund', garments: [{ id: back.id, version: back.version }],
  }));
  expect(await stored(buttons.id)).toMatchObject({ onHand: 100000, reserved: 0 });
  expect(await stored(silk.id)).toMatchObject({ onHand: 8000, reserved: 0 });
  expect(await lineOf(g.id, silk)).toMatchObject({ used: 2000, usedCost: 50000, state: 'used' });
  expect(await lineOf(g.id, buttons)).toMatchObject({ used: 0, reserved: 0, state: 'released' });
  await expectBalanced(silk.id);
  await expectBalanced(buttons.id);
});

test('material cost of a garment is the value its materials took', async () => {
  const { ops, take, act } = await world();
  // 2 m at ₹200 and 2 m at ₹300: ₹1,000 for 4 m.
  const silk = await item(ops, { opening: { quantity: 2000, unitCost: 20000 } });
  ok(await ops.agent.post(`/v1/stock/items/${silk.id}/count`).send({ counted: 4000, expectedOnHand: 2000, unitCost: 30000, reason: 'Second roll' }));
  expect(await stored(silk.id)).toMatchObject({ onHand: 4000, value: 100000 });
  const [g] = await take([{ materials: [line(silk, 3000)] }]);
  ok(await act([g], { action: 'complete' }));
  expect(await lineOf(g.id, silk)).toMatchObject({ used: 3000, usedCost: 75000 });
  const consumed = await movements(silk.id, 'consume');
  expect(-consumed.reduce((sum, m) => sum + m.valueChange, 0)).toBe(75000);
  expect(await stored(silk.id)).toMatchObject({ onHand: 1000, value: 25000 });
  await expectBalanced(silk.id);
});

test("used more takes from free stock; put back returns at the garment's own cost", async () => {
  const { ops, designer, take, act } = await world();
  const silk = await silkWith(ops, 10);
  const buttons = await buttonsWith(ops, 100);
  const [g] = await take([{ materials: [line(silk, 3000)] }]);

  // Before Materials ready, the plan is changed instead.
  let r = await change(designer, g.id, 0, [{ stockItemId: silk.id, change: 1000 }]);
  ok(r, 422);
  expect(r.body.error).toMatchObject({ code: 'MATERIALS_NOT_USED_YET', message: 'Change the plan instead' });

  ok(await act([g], { action: 'complete' }));
  expect(await stored(silk.id)).toMatchObject({ onHand: 7000, value: 175000 });
  let version = (await view(designer, g.id)).body.version;

  // Used more: 1 m more silk and 4 buttons not planned.
  r = await change(designer, g.id, version, [{ stockItemId: silk.id, change: 1000 }, { stockItemId: buttons.id, change: 4000 }], 'Extra border');
  ok(r);
  expectNoMoney(r.body);
  expect(r.body.lines.map((l) => [l.stockItemId, l.used, l.state])).toEqual([[silk.id, 4000, 'used'], [buttons.id, 4000, 'used']]);
  expect(await lineOf(g.id, silk)).toMatchObject({ used: 4000, usedCost: 100000 });
  expect(await lineOf(g.id, buttons)).toMatchObject({ used: 4000, usedCost: 400 });
  expect(await stored(silk.id)).toMatchObject({ onHand: 6000, value: 150000 });
  expect((await movements(silk.id, 'consume')).at(-1)).toMatchObject({ quantity: 1000, valueChange: -25000, reason: 'Extra border' });

  // A stale version is refused.
  ok(await change(designer, g.id, version, [{ stockItemId: silk.id, change: -1000 }]), 409);
  version = r.body.version;

  // The shelf's average moves (3 m more at ₹400), but put back is valued at the garment's ₹250.
  ok(await ops.agent.post(`/v1/stock/items/${silk.id}/count`).send({ counted: 9000, expectedOnHand: 6000, unitCost: 40000, reason: 'New roll' }));
  expect(await stored(silk.id)).toMatchObject({ onHand: 9000, value: 270000 });
  r = await change(designer, g.id, version, [{ stockItemId: silk.id, change: -2000 }]);
  ok(r);
  expect(await lineOf(g.id, silk)).toMatchObject({ used: 2000, usedCost: 50000 });
  expect(await stored(silk.id)).toMatchObject({ onHand: 11000, value: 320000 });
  expect((await movements(silk.id, 'consume')).at(-1)).toMatchObject({ quantity: -2000, valueChange: 50000 });

  // Putting back more than was used, or something never used, is refused.
  r = await change(designer, g.id, r.body.version, [{ stockItemId: silk.id, change: -3000 }]);
  ok(r, 400);
  expect(r.body.error.details).toEqual([{ path: 'changes.0.change', message: 'More than was used' }]);
  const other = await item(ops, { name: 'Lining', opening: { quantity: 1000, unitCost: 100 } });
  r = await change(designer, g.id, (await view(designer, g.id)).body.version, [{ stockItemId: other.id, change: -500 }]);
  ok(r, 400);
  expect(await stored(silk.id)).toMatchObject({ onHand: 11000, value: 320000 });

  // Used more than the shelf has.
  r = await change(designer, g.id, (await view(designer, g.id)).body.version, [{ stockItemId: buttons.id, change: 97000 }]);
  ok(r, 422);
  expect(r.body.error.code).toBe('STOCK_INSUFFICIENT');
  await expectBalanced(silk.id);
  await expectBalanced(buttons.id);
});

test('used more is only on garments in scope and on open orders', async () => {
  const { ops, admin, take, act } = await world();
  const { loginAs } = await import('./helpers/app.js');
  const stranger = await loginAs(app, { roles: ['designer'], name: 'Nila' });
  const silk = await silkWith(ops, 10);
  const [g] = await take([{ materials: [line(silk, 3000)] }]);
  ok(await act([g], { action: 'complete' }));
  const version = (await view(ops, g.id)).body.version;
  ok(await change(stranger, g.id, version, [{ stockItemId: silk.id, change: 1000 }]), 404);
  const r = await change(admin, g.id, version, [{ stockItemId: silk.id, change: 1000 }]);
  ok(r);
  expect((await stored(silk.id)).onHand).toBe(6000);
  ok(await ops.agent.post(`/v1/orders/${g.orderId}/cancel`).send({ version: 0, reason: 'Called off' }));
  const refused = await change(admin, g.id, r.body.version, [{ stockItemId: silk.id, change: -1000 }]);
  ok(refused, 422);
  expect(refused.body.error.code).toBe('INVALID_STATUS');
  expect((await stored(silk.id)).onHand).toBe(6000);
});

test("a designer's stage action response carries no cost", async () => {
  const { ops, take, act } = await world();
  const silk = await silkWith(ops, 10);
  const [g] = await take([{ materials: [line(silk, 3000)] }]);
  const r = await act([g], { action: 'complete', materialsUsed: [usedOf(g, silk, 2500)] });
  ok(r);
  expectNoMoney(r.body);
  expect((await stored(silk.id)).onHand).toBe(7500);
});
