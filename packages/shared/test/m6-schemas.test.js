import { test, expect } from 'vitest';
import {
  qty, stockItemSchema, stockItemPatchSchema, stockCountSchema, materialLinesSchema, materialsUsedSchema,
  materialChangeSchema, purchaseRequestSchema, purchaseOrderSchema, receiveSchema, stockListQuery,
  movementsQuery, requestsQuery, pickerQuery,
} from '../src/schemas/stock.js';
import { stageActionSchema } from '../src/schemas/production.js';
import { catalogItemSchema, catalogItemPatchSchema } from '../src/schemas/catalog.js';
import { garmentInputSchema } from '../src/schemas/orders.js';

const id = (n) => String(n).padStart(24, 'a');
const item = { name: 'Red silk', usageUnit: 'm', purchaseUnit: 'roll', factor: 20000 };

test('an item needs a name and units; the step defaults to one unit', () => {
  const r = stockItemSchema.parse(item);
  expect(r.step).toBe(1000);
  expect(r.reorderLevel).toBe(0);
  expect(r.sellingPrice).toBeNull();
  expect(r.opening).toBeNull();
  expect(r.brand).toBe('');
  for (const k of ['name', 'usageUnit', 'purchaseUnit', 'factor']) {
    const rest = { ...item };
    delete rest[k];
    expect(stockItemSchema.safeParse(rest).success).toBe(false);
  }
  expect(stockItemSchema.safeParse({ ...item, extra: 1 }).success).toBe(false);
  expect(stockItemSchema.safeParse({ ...item, opening: { quantity: 5000, unitCost: 25000 } }).success).toBe(true);
  expect(stockItemPatchSchema.safeParse({}).success).toBe(false);
  expect(stockItemPatchSchema.safeParse({ active: false }).success).toBe(true);
  expect(stockItemPatchSchema.safeParse({ opening: null }).success).toBe(false);
});

test('quantities are whole milli-units', () => {
  expect(qty.safeParse(2500).success).toBe(true);
  for (const bad of [0, -1, 2.5, 1_000_000_001, '5']) expect(qty.safeParse(bad).success).toBe(false);
  expect(stockItemSchema.safeParse({ ...item, factor: 1.5 }).success).toBe(false);
  expect(stockItemSchema.safeParse({ ...item, reorderLevel: 0 }).success).toBe(true);
});

test('a material list names each item once, at most 20', () => {
  expect(materialLinesSchema.safeParse([{ stockItemId: id(1), quantity: 2500 }]).success).toBe(true);
  expect(materialLinesSchema.safeParse([{ stockItemId: id(1), quantity: 1 }, { stockItemId: id(1), quantity: 2 }]).success).toBe(false);
  const many = Array.from({ length: 21 }, (_, i) => ({ stockItemId: id(i + 1), quantity: 1 }));
  expect(materialLinesSchema.safeParse(many).success).toBe(false);
  expect(materialLinesSchema.safeParse(many.slice(0, 20)).success).toBe(true);
  expect(materialLinesSchema.safeParse([{ stockItemId: id(1), quantity: 0 }]).success).toBe(false);
});

const stageBase = { action: 'complete', stage: 'materials_ready', garments: [{ id: id(1), version: 0 }] };
const used = [{ garmentId: id(1), stockItemId: id(5), quantity: 0 }];

test('materials used is only for completing or skipping Materials ready', () => {
  expect(materialsUsedSchema.safeParse(used).success).toBe(true);
  expect(materialsUsedSchema.safeParse([{ ...used[0], quantity: -1 }]).success).toBe(false);
  expect(stageActionSchema.safeParse({ ...stageBase, materialsUsed: used }).success).toBe(true);
  expect(stageActionSchema.safeParse({ ...stageBase, action: 'skip', reason: 'none needed', materialsUsed: used }).success).toBe(true);
  expect(stageActionSchema.safeParse(stageBase).success).toBe(true);
  expect(stageActionSchema.safeParse({ ...stageBase, stage: 'cutting', materialsUsed: used }).success).toBe(false);
  expect(stageActionSchema.safeParse({ ...stageBase, action: 'start', materialsUsed: used }).success).toBe(false);
  expect(stageActionSchema.safeParse({ ...stageBase, materialsUsed: [{ ...used[0], garmentId: id(9) }] }).success).toBe(false);
});

test('a count needs a reason', () => {
  const c = { counted: 12000, expectedOnHand: 15000, reason: 'Shelf check' };
  expect(stockCountSchema.safeParse(c).success).toBe(true);
  expect(stockCountSchema.safeParse({ ...c, reason: '' }).success).toBe(false);
  expect(stockCountSchema.safeParse({ ...c, counted: -1 }).success).toBe(false);
  expect(stockCountSchema.safeParse({ ...c, unitCost: 500 }).success).toBe(true);
});

const receive = { quantity: 20000, total: 500000, mode: 'cash', payee: { name: 'Fabric House' } };

test('receiving checks GST like an expense', () => {
  expect(receiveSchema.safeParse(receive).success).toBe(true);
  expect(receiveSchema.safeParse({ ...receive, total: 0 }).success).toBe(false);
  expect(receiveSchema.safeParse({ ...receive, payee: {} }).success).toBe(false);
  const gst = { billNo: 'B-1', billDate: '2026-10-29', rateBp: 500, taxable: 476200, cgst: 11900, sgst: 11900, igst: 0 };
  expect(receiveSchema.safeParse({ ...receive, gst }).success).toBe(true);
  expect(receiveSchema.safeParse({ ...receive, gst: { ...gst, taxable: 1 } }).success).toBe(false);
  expect(receiveSchema.safeParse({ ...receive, date: '2026-10-28', gst }).success).toBe(false);
});

const catalog = {
  name: 'Lining', kind: 'material', supplyType: 'goods', hsnSac: '5407', unit: 'MTR',
  gstSlabs: [{ upToUnitPrice: null, rateBp: 500 }],
};

test('only material price-list items can name a stock item', () => {
  expect(catalogItemSchema.parse(catalog).stockItemId).toBeNull();
  expect(catalogItemSchema.safeParse({ ...catalog, stockItemId: id(3) }).success).toBe(true);
  expect(catalogItemSchema.safeParse({ ...catalog, kind: 'garment', stockItemId: id(3) }).success).toBe(false);
  expect(catalogItemPatchSchema.safeParse({ stockItemId: null }).success).toBe(true);
  expect(catalogItemPatchSchema.safeParse({ stockItemId: id(3) }).success).toBe(true);
});

test('order garment lines may carry materials', () => {
  const line = { type: 'blouse', description: 'Silk blouse', agreedPrice: 100000 };
  expect(garmentInputSchema.parse(line).materials).toEqual([]);
  expect(garmentInputSchema.safeParse({ ...line, materials: [{ stockItemId: id(1), quantity: 1500 }] }).success).toBe(true);
});

test('the other stock bodies and queries', () => {
  expect(materialChangeSchema.safeParse({ changes: [{ stockItemId: id(1), change: -500 }], note: '' }).success).toBe(true);
  expect(materialChangeSchema.safeParse({ changes: [{ stockItemId: id(1), change: 0 }] }).success).toBe(false);
  expect(materialChangeSchema.safeParse({ changes: [] }).success).toBe(false);
  expect(purchaseRequestSchema.parse({ stockItemId: id(1), quantity: 1000, reason: 'manual' }).note).toBe('');
  expect(purchaseRequestSchema.safeParse({ stockItemId: id(1), quantity: 1000, reason: 'other' }).success).toBe(false);
  expect(purchaseOrderSchema.safeParse({ vendorId: null, note: 'x' }).success).toBe(true);
  expect(stockListQuery.parse({ low: 'true', limit: '20' })).toMatchObject({ low: true, limit: 20 });
  expect(movementsQuery.safeParse({ limit: '10' }).success).toBe(true);
  expect(requestsQuery.safeParse({ status: 'open' }).success).toBe(true);
  expect(requestsQuery.safeParse({ status: 'nope' }).success).toBe(false);
  expect(pickerQuery.safeParse({ q: 'x'.repeat(41) }).success).toBe(false);
});

test('costs are bounded amounts', () => {
  const huge = Number.MAX_SAFE_INTEGER;
  expect(stockItemSchema.safeParse({ ...item, opening: { quantity: 5000, unitCost: huge } }).success).toBe(false);
  expect(stockCountSchema.safeParse({ counted: 1, expectedOnHand: 0, unitCost: huge, reason: 'x' }).success).toBe(false);
  expect(stockItemSchema.safeParse({ ...item, opening: { quantity: 5000, unitCost: 1_000_000_000 } }).success).toBe(true);
});
