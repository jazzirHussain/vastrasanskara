import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { stockHelpers } from './helpers/stock.js';
import { AuditLog } from '../src/core/audit/model.js';
import { withTransaction } from '../src/core/db.js';
import { Outbox } from '../src/core/notify/models.js';
import { StockItem, StockMovement, StockMovementImmutableError } from '../src/modules/stock/model.js';
import { moveStock } from '../src/modules/stock/ledger.js';
import { itemListFilter, lowStockFilter, movementFilter } from '../src/modules/stock/queries.js';
import { toItemJson } from '../src/modules/stock/json.js';

useTestDb();
const app = buildTestApp();
const { world, item, expectBalanced } = stockHelpers(app);

const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const count = (who, id, body) => who.agent.post(`/v1/stock/items/${id}/count`).send({ reason: 'Shelf count', ...body });
const consume = (branchId, stockItemId, quantity, actor = {}) =>
  withTransaction((session) => moveStock(branchId, { stockItemId, type: 'consume', quantity }, actor, session));
const reserve = (branchId, stockItemId, quantity) =>
  withTransaction((session) => moveStock(branchId, { stockItemId, type: 'reserve', quantity }, {}, session));

test('an item is created with opening stock at its cost', async () => {
  const { ops } = await world();
  // 10 m at ₹250 a metre.
  const created = await item(ops, { brand: 'Kanchi', category: 'Fabric', opening: { quantity: 10000, unitCost: 25000 } });
  expect(created).toMatchObject({
    name: 'Red silk',
    brand: 'Kanchi',
    category: 'Fabric',
    usageUnit: 'm',
    onHand: 10000,
    reserved: 0,
    free: 10000,
    value: 250000,
    avgCost: 25_000_000,
    sellingPrice: null,
    low: false,
    active: true,
    version: 0,
  });
  const movements = await StockMovement.find({ stockItemId: created.id }).lean();
  expect(movements).toHaveLength(1);
  expect(movements[0]).toMatchObject({
    type: 'opening',
    quantity: 10000,
    onHandChange: 10000,
    reservedChange: 0,
    valueChange: 250000,
    onHandAfter: 10000,
    valueAfter: 250000,
  });
  expect(String(movements[0].by)).toBe(String(ops.user._id));
  const stored = await StockItem.findById(created.id).lean();
  expect(stored.hasMovements).toBe(true);
  expect(String(stored.lastValueMovementId)).toBe(String(movements[0]._id));
  const audits = await AuditLog.find({ entityType: 'stock_item', entityId: created.id }).lean();
  expect(audits.map((a) => a.action)).toEqual(['create']);
  expect(audits[0].changes.find((c) => c.path === 'opening').after).toEqual({ quantity: 10000, unitCost: 25000 });
});

test('cached balances always equal the sum of movements', async () => {
  const { ops } = await world();
  // A packet of 144 buttons for ₹100: the average keeps its fraction.
  const buttons = await item(ops, { name: 'Gold buttons', usageUnit: 'pcs', purchaseUnit: 'packet', factor: 144000, opening: { quantity: 144000, unitCost: 69 } });
  await expectBalanced(buttons.id);
  let r = await count(ops, buttons.id, { counted: 200000, expectedOnHand: 144000 });
  ok(r);
  await expectBalanced(buttons.id);
  r = await count(ops, buttons.id, { counted: 7000, expectedOnHand: 200000 });
  ok(r);
  const cached = await expectBalanced(buttons.id);
  expect(cached.onHand).toBe(7000);
  r = await count(ops, buttons.id, { counted: 0, expectedOnHand: 7000 });
  ok(r);
  const empty = await expectBalanced(buttons.id);
  expect(empty).toMatchObject({ onHand: 0, value: 0, avgCost: 0 });
});

test('movements cannot be changed or deleted', async () => {
  const { ops } = await world();
  const silk = await item(ops, { opening: { quantity: 5000, unitCost: 10000 } });
  const doc = await StockMovement.findOne({ stockItemId: silk.id });
  const filter = { _id: doc._id };
  const refused = [
    () => StockMovement.updateOne(filter, { quantity: 1 }),
    () => StockMovement.updateMany(filter, { quantity: 1 }),
    () => StockMovement.deleteOne(filter),
    () => StockMovement.deleteMany(filter),
    () => StockMovement.findOneAndUpdate(filter, { quantity: 1 }),
    () => StockMovement.findOneAndDelete(filter),
    () => StockMovement.replaceOne(filter, { quantity: 1 }),
    () => StockMovement.findOneAndReplace(filter, { quantity: 1 }),
    () => {
      doc.quantity = 1;
      return doc.save();
    },
    () => doc.deleteOne(),
    () => doc.updateOne({ quantity: 1 }),
  ];
  for (const op of refused) await expect(op()).rejects.toThrow(StockMovementImmutableError);
  expect((await StockMovement.findById(doc._id).lean()).quantity).toBe(5000);
});

test('a count records the difference and is audited', async () => {
  const { ops } = await world();
  const silk = await item(ops, { opening: { quantity: 10000, unitCost: 25000 } });
  const r = await count(ops, silk.id, { counted: 8500, expectedOnHand: 10000, reason: 'Two offcuts lost' });
  ok(r);
  expect(r.body.item).toMatchObject({ onHand: 8500, value: 212500, avgCost: 25_000_000 });
  const adjust = await StockMovement.findOne({ stockItemId: silk.id, type: 'adjust' }).lean();
  expect(adjust).toMatchObject({ quantity: -1500, onHandChange: -1500, valueChange: -37500, reason: 'Two offcuts lost' });
  const audit = await AuditLog.findOne({ entityType: 'stock_item', entityId: silk.id, action: 'count' }).lean();
  expect(audit.changes).toEqual(
    expect.arrayContaining([
      { path: 'onHand', before: 10000, after: 8500 },
      { path: 'reason', before: null, after: 'Two offcuts lost' },
      { path: 'valueChange', before: null, after: -37500 },
    ]),
  );
  // The same count again changes nothing.
  const again = await count(ops, silk.id, { counted: 8500, expectedOnHand: 8500 });
  ok(again, 422);
  expect(again.body.error.code).toBe('NOTHING_TO_CHANGE');
  // A count up is valued at the average.
  const up = await count(ops, silk.id, { counted: 9000, expectedOnHand: 8500 });
  ok(up);
  expect(up.body.item).toMatchObject({ onHand: 9000, value: 225000 });
  await expectBalanced(silk.id);
});

test('a count up on an empty item needs a cost per unit', async () => {
  const { ops } = await world();
  const silk = await item(ops);
  const r = await count(ops, silk.id, { counted: 3000, expectedOnHand: 0 });
  ok(r, 400);
  expect(r.body.error.details).toEqual([{ path: 'unitCost', message: 'Enter the cost per unit' }]);
  expect(await StockMovement.countDocuments({ stockItemId: silk.id })).toBe(0);
  const priced = await count(ops, silk.id, { counted: 3000, expectedOnHand: 0, unitCost: 20000 });
  ok(priced);
  expect(priced.body.item).toMatchObject({ onHand: 3000, value: 60000 });
});

test('a count below what is reserved is refused', async () => {
  const { ops, branchId } = await world();
  const silk = await item(ops, { opening: { quantity: 10000, unitCost: 25000 } });
  await reserve(branchId, silk.id, 6000);
  const r = await count(ops, silk.id, { counted: 5000, expectedOnHand: 10000 });
  ok(r, 422);
  expect(r.body.error).toMatchObject({ code: 'STOCK_INSUFFICIENT', details: { stockItemId: silk.id, name: 'Red silk', free: 4000 } });
  const cached = await expectBalanced(silk.id);
  expect(cached).toMatchObject({ onHand: 10000, reserved: 6000 });
  expect(await AuditLog.countDocuments({ entityType: 'stock_item', action: 'count' })).toBe(0);
});

test('a count racing a consumption is refused, not negative', async () => {
  const { ops, branchId } = await world();
  const silk = await item(ops, { opening: { quantity: 2000, unitCost: 25000 } });
  // The screen showed 2 m; a designer used 1.5 m meanwhile.
  await consume(branchId, silk.id, 1500);
  const r = await count(ops, silk.id, { counted: 0, expectedOnHand: 2000 });
  ok(r, 409);
  expect(r.body.error.code).toBe('CONFLICT');
  const cached = await expectBalanced(silk.id);
  expect(cached).toMatchObject({ onHand: 500, value: 12500 });
  // Taking out more than is there is refused, nothing written.
  await expect(consume(branchId, silk.id, 600)).rejects.toMatchObject({ code: 'STOCK_INSUFFICIENT', status: 422 });
  expect((await expectBalanced(silk.id)).onHand).toBe(500);
});

test('the unit cannot change once stock has moved', async () => {
  const { ops } = await world();
  const empty = await item(ops, { name: 'Lining' });
  let r = await ops.agent.patch(`/v1/stock/items/${empty.id}`).send({ version: 0, usageUnit: 'cm', factor: 100000 });
  ok(r);
  expect(r.body.item).toMatchObject({ usageUnit: 'cm', factor: 100000, version: 1 });

  const silk = await item(ops, { opening: { quantity: 1000, unitCost: 100 } });
  r = await ops.agent.patch(`/v1/stock/items/${silk.id}`).send({ version: 0, usageUnit: 'cm' });
  ok(r, 422);
  expect(r.body.error).toMatchObject({ code: 'UNIT_FIXED', message: 'The unit cannot change once stock has moved' });
  r = await ops.agent.patch(`/v1/stock/items/${silk.id}`).send({ version: 0, factor: 2000 });
  ok(r, 422);
  // Everything else stays editable; a stale version is refused.
  r = await ops.agent.patch(`/v1/stock/items/${silk.id}`).send({ version: 0, name: 'Crimson silk', usageUnit: 'm', reorderLevel: 5000 });
  ok(r);
  expect(r.body.item).toMatchObject({ name: 'Crimson silk', reorderLevel: 5000, low: true, version: 1 });
  r = await ops.agent.patch(`/v1/stock/items/${silk.id}`).send({ version: 0, brand: 'X' });
  ok(r, 409);
  // A reorder level set by an edit sends no alert.
  expect(await Outbox.countDocuments({ event: 'stock.low' })).toBe(0);
  const audits = await AuditLog.find({ entityType: 'stock_item', entityId: silk.id, action: 'update' }).lean();
  expect(audits).toHaveLength(1);
});

test('falling below the reorder level alerts operations once per dip', async () => {
  const { ops, branchId } = await world();
  const silk = await item(ops, { reorderLevel: 5000, opening: { quantity: 10000, unitCost: 25000 } });
  const alerts = () => Outbox.find({ event: 'stock.low', channel: 'in_app' }).lean();
  await consume(branchId, silk.id, 6000);
  await consume(branchId, silk.id, 1000);
  let sent = await alerts();
  expect(sent).toHaveLength(1);
  expect(sent[0].recipient.id).toBe(String(ops.user._id));
  expect(sent[0].vars).toMatchObject({ name: 'Red silk', free: '4 m', reorderLevel: '5 m', link: `/stock/items/${silk.id}` });
  expect(await Outbox.countDocuments({ event: 'stock.low', channel: 'email' })).toBe(1);

  ok(await count(ops, silk.id, { counted: 10000, expectedOnHand: 3000 }));
  expect((await StockItem.findById(silk.id).lean()).low).toBe(false);
  await consume(branchId, silk.id, 6000);
  sent = await alerts();
  expect(sent).toHaveLength(2);
  expect((await StockItem.findById(silk.id).lean())).toMatchObject({ low: true, lowSeq: 2 });
});

test('the low list shows only items below their level', async () => {
  const { ops } = await world();
  await item(ops, { name: 'Zari border', reorderLevel: 5000, opening: { quantity: 2000, unitCost: 100 } });
  await item(ops, { name: 'Blue silk', reorderLevel: 5000, opening: { quantity: 9000, unitCost: 100 } });
  await item(ops, { name: 'Amber lining', reorderLevel: 1000 });
  await item(ops, { name: 'Thread', opening: { quantity: 1000, unitCost: 100 } });
  const r = await ops.agent.get('/v1/stock/low');
  ok(r);
  expect(r.body.items.map((i) => i.name)).toEqual(['Amber lining', 'Zari border']);
  const list = await ops.agent.get('/v1/stock/items?low=true');
  ok(list);
  expect(list.body.items.map((i) => i.name)).toEqual(['Amber lining', 'Zari border']);
  const all = await ops.agent.get('/v1/stock/items');
  expect(all.body.items.map((i) => i.name)).toEqual(['Amber lining', 'Blue silk', 'Thread', 'Zari border']);
});

test('movement history pages newest first without repeats', async () => {
  const { ops, branchId } = await world();
  const silk = await item(ops, { opening: { quantity: 10000, unitCost: 100 } });
  for (const q of [1000, 1100, 1200, 1300]) await consume(branchId, silk.id, q, { userId: ops.user._id });
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = await ops.agent.get(`/v1/stock/items/${silk.id}/movements?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    ok(r);
    seen.push(...r.body.items);
    cursor = r.body.nextCursor;
    pages += 1;
  } while (cursor);
  expect(pages).toBe(3);
  expect(seen.map((m) => m.quantity)).toEqual([1300, 1200, 1100, 1000, 10000]);
  expect(new Set(seen.map((m) => m.id)).size).toBe(5);
  expect(seen[0]).toMatchObject({ type: 'consume', onHandChange: -1300, by: { id: String(ops.user._id), name: ops.user.name } });
  expect(seen[0]).toHaveProperty('valueChange');
});

test('a movement outside a transaction is refused', async () => {
  const { ops, branchId } = await world();
  const silk = await item(ops, { opening: { quantity: 1000, unitCost: 100 } });
  await expect(moveStock(branchId, { stockItemId: silk.id, type: 'consume', quantity: 100 }, {})).rejects.toThrow(/transaction/);
  expect(await StockMovement.countDocuments()).toBe(1);
});

test('item JSON without money.view leaves out value, average cost and selling price', async () => {
  const { ops } = await world();
  const silk = await item(ops, { sellingPrice: 40000, opening: { quantity: 1000, unitCost: 100 } });
  const stored = await StockItem.findById(silk.id).lean();
  const blind = toItemJson(stored, { money: false });
  for (const key of ['value', 'avgCost', 'sellingPrice', 'cost', 'price']) expect(blind).not.toHaveProperty(key);
  expect(blind).toMatchObject({ id: silk.id, onHand: 1000, free: 1000 });
  expect(toItemJson(stored, { money: true })).toMatchObject({ value: 100, sellingPrice: 40000 });
  // Designers cannot read stock at all.
  const { designer } = await world();
  ok(await designer.agent.get('/v1/stock/items'), 403);
});

test('stock queries use indexes', async () => {
  const { ops, branchId } = await world();
  const silk = await item(ops, { opening: { quantity: 1000, unitCost: 100 } });
  await StockItem.init();
  await StockMovement.init();
  const plans = await Promise.all([
    StockItem.find(itemListFilter(branchId, {})).sort({ searchName: 1, _id: 1 }).explain('queryPlanner'),
    StockItem.find(itemListFilter(branchId, { q: 'silk', low: true })).sort({ searchName: 1, _id: 1 }).explain('queryPlanner'),
    StockItem.find(lowStockFilter(branchId)).sort({ searchName: 1, _id: 1 }).explain('queryPlanner'),
    StockMovement.find(movementFilter(branchId, silk.id)).sort({ at: -1, _id: -1 }).explain('queryPlanner'),
  ]);
  for (const plan of plans) expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
  expect(JSON.stringify(plans[3].queryPlanner.winningPlan)).toContain('by_item');
});

test('the stock service imports no other business module', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/modules/stock');
  const files = ['service.js', 'ledger.js', 'reservations.js', 'queries.js'].map((f) => path.join(dir, f)).filter(existsSync);
  expect(files.length).toBeGreaterThanOrEqual(3);
  const forbidden = [/modules\/(orders|production|billing|catalog|expenses|costing)/, /'\.\.\/(orders|production|billing|catalog|expenses|costing)\//];
  for (const file of files) {
    const imports = readFileSync(file, 'utf8').split('\n').filter((line) => /^\s*(import|export)\b.*from\s+'/.test(line));
    for (const line of imports) for (const re of forbidden) expect([path.basename(file), line]).not.toEqual([path.basename(file), expect.stringMatching(re)]);
  }
});

test('an item of another branch is not found', async () => {
  const { ops } = await world();
  const id = new mongoose.Types.ObjectId();
  ok(await ops.agent.get(`/v1/stock/items/${id}`), 404);
  ok(await count(ops, id, { counted: 1, expectedOnHand: 0, unitCost: 1 }), 404);
});
