import { test, expect } from 'vitest';
import { catalogItemSchema, catalogItemPatchSchema } from '../src/schemas/catalog.js';
import {
  invoiceLineSchema, invoiceDraftSchema, paymentSchema, creditNoteSchema, issueSchema,
} from '../src/schemas/billing.js';
import { branchPatchSchema } from '../src/schemas/branch.js';

const id = (n) => String(n).padStart(24, 'a');
const slabs = [{ upToUnitPrice: 100000, rateBp: 500 }, { upToUnitPrice: null, rateBp: 1200 }];
const item = { name: 'Blouse', kind: 'garment', supplyType: 'goods', hsnSac: '6211', gstSlabs: slabs };
const okItem = (o) => catalogItemSchema.safeParse({ ...item, ...o }).success;
const line = { key: 'a', itemId: id(1), description: 'Blouse', quantity: 1, rate: 100000 };
const okLine = (o) => invoiceLineSchema.safeParse({ ...line, ...o }).success;
const pay = { customerId: id(1), amount: 100, mode: 'cash' };

test('an item needs a valid HSN or SAC', () => {
  expect(okItem({})).toBe(true);
  expect(okItem({ hsnSac: '62' })).toBe(false);
  expect(okItem({ hsnSac: '62111' })).toBe(false);
  expect(okItem({ hsnSac: '621112' })).toBe(true);
  expect(okItem({ hsnSac: '62111234' })).toBe(true);
  expect(okItem({ hsnSac: '62A1' })).toBe(false);
});

test('services use SAC codes starting 99', () => {
  expect(okItem({ kind: 'stitching_service', supplyType: 'service', hsnSac: '9988' })).toBe(true);
  expect(okItem({ kind: 'stitching_service', supplyType: 'service', hsnSac: '6211' })).toBe(false);
  expect(okItem({ supplyType: 'goods', hsnSac: '9988' })).toBe(false);
  const r = catalogItemSchema.safeParse({ ...item, hsnSac: '9988' });
  expect(r.error.issues[0].message).toBe('SAC codes start with 99; goods use HSN codes');
});

test('slabs end with one open slab, in order', () => {
  expect(okItem({ gstSlabs: [{ upToUnitPrice: null, rateBp: 500 }] })).toBe(true);
  expect(okItem({ gstSlabs: [{ upToUnitPrice: 100, rateBp: 500 }] })).toBe(false);
  expect(okItem({ gstSlabs: [{ upToUnitPrice: null, rateBp: 500 }, { upToUnitPrice: null, rateBp: 1200 }] })).toBe(false);
  expect(okItem({ gstSlabs: [{ upToUnitPrice: 200, rateBp: 500 }, { upToUnitPrice: 100, rateBp: 1200 }, { upToUnitPrice: null, rateBp: 1800 }] })).toBe(false);
  expect(okItem({ gstSlabs: [{ upToUnitPrice: 100, rateBp: 500 }, { upToUnitPrice: 100, rateBp: 1200 }, { upToUnitPrice: null, rateBp: 1800 }] })).toBe(false);
  expect(okItem({ gstSlabs: [{ upToUnitPrice: null, rateBp: 700 }] })).toBe(false);
  expect(okItem({ gstSlabs: [] })).toBe(false);
});

test('garment types only on garments and stitching', () => {
  expect(okItem({ garmentTypes: ['blouse'] })).toBe(true);
  expect(okItem({ kind: 'material', garmentTypes: ['blouse'] })).toBe(false);
  expect(okItem({ kind: 'extra_charge', supplyType: 'service', hsnSac: '9988', garmentTypes: ['blouse'] })).toBe(false);
});

test('charge type only on extra charges', () => {
  expect(okItem({ kind: 'extra_charge', supplyType: 'service', hsnSac: '9988', chargeFor: 'rush' })).toBe(true);
  expect(okItem({ chargeFor: 'rush' })).toBe(false);
  expect(catalogItemSchema.parse(item)).toMatchObject({ unit: 'PCS', defaultPrice: 0, garmentTypes: [], chargeFor: null, active: true });
  expect(catalogItemPatchSchema.safeParse({}).success).toBe(false);
  expect(catalogItemPatchSchema.parse({ active: false })).toEqual({ active: false });
});

test('a discount needs a reason', () => {
  expect(okLine({ discount: 500 })).toBe(false);
  expect(okLine({ discount: 500, discountReason: '   ' })).toBe(false);
  expect(okLine({ discount: 500, discountReason: 'Regular customer' })).toBe(true);
  expect(okLine({})).toBe(true);
});

test('line keys are unique', () => {
  expect(invoiceDraftSchema.safeParse({ lines: [line, { ...line, key: 'b' }] }).success).toBe(true);
  expect(invoiceDraftSchema.safeParse({ lines: [line, line] }).success).toBe(false);
  expect(invoiceDraftSchema.parse({ lines: [] })).toEqual({ lines: [], invoiceDiscount: null, notes: '' });
});

test('quantity allows three decimals', () => {
  expect(okLine({ quantity: 2.5 })).toBe(true);
  expect(okLine({ quantity: 1.125 })).toBe(true);
  expect(okLine({ quantity: 1.1234 })).toBe(false);
  expect(okLine({ quantity: 0 })).toBe(false);
  expect(okLine({ quantity: 10000 })).toBe(false);
});

test('a payment needs a positive amount and a known mode', () => {
  expect(paymentSchema.safeParse(pay).success).toBe(true);
  expect(paymentSchema.safeParse({ ...pay, amount: 0 }).success).toBe(false);
  expect(paymentSchema.safeParse({ ...pay, mode: 'cheque' }).success).toBe(false);
  expect(paymentSchema.safeParse({ ...pay, amount: 1.5 }).success).toBe(false);
});

test('a credit note is the whole bill or some lines', () => {
  const l = [{ key: 'a', taxable: 100 }];
  expect(creditNoteSchema.safeParse({ reason: 'x', full: true, lines: [] }).success).toBe(true);
  expect(creditNoteSchema.safeParse({ reason: 'x', lines: l }).success).toBe(true);
  expect(creditNoteSchema.safeParse({ reason: 'x', full: true, lines: l }).success).toBe(false);
  expect(creditNoteSchema.safeParse({ reason: 'x', lines: [] }).success).toBe(false);
});

test('unknown keys are refused', () => {
  expect(okItem({ extra: 1 })).toBe(false);
  expect(okLine({ extra: 1 })).toBe(false);
  expect(paymentSchema.safeParse({ ...pay, extra: 1 }).success).toBe(false);
  expect(issueSchema.safeParse({ version: 0, extra: 1 }).success).toBe(false);
});

test('document prefixes are at most six characters', () => {
  const p = (prefixes) => branchPatchSchema.safeParse({ prefixes }).success;
  const all = { invoice: 'INV', creditNote: 'CN', receiptVoucher: 'RV', receipt: 'RC', refund: 'RF', expense: 'EXPENSE123', order: 'ORDER12345' };
  expect(p(all)).toBe(true);
  expect(p({ ...all, invoice: 'ABCDEFG' })).toBe(false);
  expect(p({ ...all, receipt: 'rc' })).toBe(false);
  expect(p({ ...all, refund: 'A/B' })).toBe(false);
  expect(p({ ...all, expense: 'x'.repeat(11) })).toBe(false);
});
