import { test, expect } from 'vitest';
import {
  IMPORT_KINDS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  getImportKind,
  matchHeaders,
  parseRow,
  rowKey,
} from '../src/imports/kinds.js';
import { customerSchema } from '../src/schemas/customers.js';
import { importRowsQuery, importStartSchema } from '../src/schemas/imports.js';

const ctx = {
  garmentTypes: [{ key: 'saree_blouse', label: 'Saree blouse' }, { key: 'lehenga', label: 'Lehenga' }],
  designers: [{ id: 'a'.repeat(24), name: 'Meera' }],
};

test('limits match the plan', () => {
  expect(IMPORT_MAX_BYTES).toBe(5242880);
  expect(IMPORT_MAX_ROWS).toBe(5000);
});

test('kinds come in the suggested order', () => {
  expect(IMPORT_KINDS.map((k) => k.kind)).toEqual(['customers', 'vendors', 'workers', 'catalog', 'stock', 'orders', 'opening_balances']);
  expect(getImportKind('orders').needsAsOf).toBe(false);
  expect(getImportKind('opening_balances').needsAsOf).toBe(true);
  expect(() => getImportKind('nope')).toThrow();
});

test('headers match whatever the case, spaces and aliases', () => {
  const result = matchHeaders('customers', ['NAME', 'Mobile ', 'Remarks', 'e-mail', '']);
  expect(result.map).toEqual({ 0: 'name', 1: 'phone', 3: 'email' });
  expect(result.unused).toEqual(['Remarks']);
  expect(result.missing).toEqual([]);
  expect(matchHeaders('customers', ['Email']).missing).toEqual(['Name', 'Phone']);
});

test('a customer row becomes a customer', () => {
  const { data, errors } = parseRow('customers', {
    name: ' Asha Rao ',
    phone: 9876543210,
    email: 'Asha@Example.com',
    type: 'Business',
    state: 'Karnataka',
    line1: '12 MG Road',
    pincode: 560001,
    source: 'Instagram',
    consentWhatsapp: 'Yes',
    consentNote: 'Said yes at the counter',
  }, ctx);
  expect(errors).toEqual([]);
  expect(data).toMatchObject({
    name: 'Asha Rao',
    phone: '+919876543210',
    email: 'asha@example.com',
    type: 'business',
    stateCode: '29',
    billingAddress: { line1: '12 MG Road', line2: '', city: '', pincode: '560001' },
    source: 'instagram',
    consent: { email: false, whatsapp: true, sms: false },
  });
  expect(customerSchema.safeParse({ ...data, phone: '9876543210' }).success).toBe(true);
});

test('cell problems name the column', () => {
  const { data, errors } = parseRow('customers', { name: '', phone: '98765' }, ctx);
  expect(data).toBeNull();
  expect(errors).toEqual([
    { column: 'Name', message: 'Fill this in.' },
    { column: 'Phone', message: "'98765' is not a 10-digit mobile number." },
  ]);
});

test('consent needs a note of how it was given', () => {
  const { errors } = parseRow('customers', { name: 'Asha', phone: '9876543210', consentEmail: 'Yes' }, ctx);
  expect(errors).toEqual([{ column: 'How consent was given', message: 'Say how the customer gave consent.' }]);
});

test('a GSTIN fixes the state', () => {
  const blank = parseRow('customers', { name: 'Asha', phone: '9876543210', gstin: '29abcde1234f1z5' }, ctx);
  expect(blank.errors).toEqual([]);
  expect(blank.data.stateCode).toBe('29');
  expect(blank.data.gstin).toBe('29ABCDE1234F1Z5');
  const clash = parseRow('customers', { name: 'Asha', phone: '9876543210', gstin: '29ABCDE1234F1Z5', state: 'Kerala' }, ctx);
  expect(clash.errors).toEqual([{ column: 'State', message: 'State code must match the GSTIN.' }]);
});

test('a price-list row with two rates makes two slabs', () => {
  const { data, errors } = parseRow('catalog', {
    name: 'Silk saree',
    kind: 'Garment',
    supplyType: 'Goods',
    hsnSac: 5007,
    price: '2,500',
    rate: '5%',
    higherRate: '18',
    higherAbove: '2500',
    garmentTypes: 'Lehenga',
  }, ctx);
  expect(errors).toEqual([]);
  expect(data.gstSlabs).toEqual([{ upToUnitPrice: 250000, rateBp: 500 }, { upToUnitPrice: null, rateBp: 1800 }]);
  expect(data.defaultPrice).toBe(250000);
  expect(data.garmentTypes).toEqual(['lehenga']);
  expect(data.unit).toBe('PCS');

  const single = parseRow('catalog', { name: 'Hemming', kind: 'Stitching service', supplyType: 'Service', hsnSac: '998821', rate: 5 }, ctx);
  expect(single.errors).toEqual([]);
  expect(single.data.gstSlabs).toEqual([{ upToUnitPrice: null, rateBp: 500 }]);

  const half = parseRow('catalog', { name: 'Hemming', kind: 'Stitching service', supplyType: 'Service', hsnSac: '998821', rate: 5, higherRate: 12 }, ctx);
  expect(half.errors).toEqual([{ column: 'Higher rate above price', message: 'Fill this in when there is a higher GST rate.' }]);
});

test('a stock row with stock needs a cost', () => {
  const base = { name: 'Raw silk', usageUnit: 'm', purchaseUnit: 'roll', factor: '25', quantity: '12.5' };
  expect(parseRow('stock', base, ctx).errors).toEqual([{ column: 'Cost per unit', message: 'Fill this in when there is stock.' }]);
  const { data, errors } = parseRow('stock', { ...base, unitCost: '₹410' }, ctx);
  expect(errors).toEqual([]);
  expect(data).toMatchObject({ factor: 25000, opening: { quantity: 12500, unitCost: 41000 } });
  expect(parseRow('stock', { name: 'Thread', usageUnit: 'spool', purchaseUnit: 'box', factor: 10 }, ctx).data.opening).toBeNull();
});

test('an open order row becomes an order line', () => {
  const { data, errors } = parseRow('orders', {
    legacyRef: 1234,
    customerPhone: '98765 43210',
    designer: 'meera',
    pickupDate: '20/12/2026',
    priority: 'Rush',
    garmentType: 'Saree blouse',
    description: 'Boat neck',
    price: '4,500',
    quantity: 2,
    stage: 'Tailors',
  }, ctx);
  expect(errors).toEqual([]);
  expect(data).toMatchObject({
    legacyRef: '1234',
    customerPhone: '+919876543210',
    designerId: 'a'.repeat(24),
    pickupDate: '2026-12-20',
    priority: 'rush',
    stage: 'tailors',
    garment: { type: 'saree_blouse', description: 'Boat neck', agreedPrice: 450000, quantity: 2, dueDate: null },
  });
  const pickedUp = parseRow('orders', { legacyRef: 1, customerPhone: '9876543210', designer: 'Meera', pickupDate: '2026-12-20', garmentType: 'Lehenga', description: 'x', price: 1, stage: 'Picked up' }, ctx);
  expect(pickedUp.errors[0].column).toBe('Stage');
});

test('an opening balance needs an amount', () => {
  expect(parseRow('opening_balances', { customerPhone: '9876543210' }, ctx).errors).toEqual([
    { column: 'Amount owed', message: 'Fill in the amount owed, the advance held, or both.' },
  ]);
  const { data, errors } = parseRow('opening_balances', { customerPhone: '9876543210', advance: '2,000', legacyRef: 'A-17' }, ctx);
  expect(errors).toEqual([]);
  expect(data).toEqual({ customerPhone: '+919876543210', owed: 0, advance: 200000, legacyRef: 'A-17', note: '' });
});

test('natural keys ignore case and extra spaces', () => {
  expect(rowKey('vendors', { name: '  Lakshmi   Dyers ' })).toBe(rowKey('vendors', { name: 'lakshmi dyers' }));
  expect(rowKey('stock', { name: 'Raw Silk', brand: 'Mysore ', colour: 'Red' })).toBe('raw silk|mysore|red');
  expect(rowKey('customers', { phone: '+919876543210' })).toBe('+919876543210');
  expect(rowKey('orders', { legacyRef: ' A 12 ' })).toBe('a 12');
  expect(rowKey('opening_balances', { customerPhone: '+919876543210' })).toBe('+919876543210');
});

test("every kind's columns have a header, help and example", () => {
  for (const kind of IMPORT_KINDS) {
    expect(kind.label).toBeTruthy();
    expect(kind.help).toBeTruthy();
    expect(new Set(kind.columns.map((c) => c.key)).size).toBe(kind.columns.length);
    for (const column of kind.columns) {
      expect(column.header, `${kind.kind}.${column.key}`).toBeTruthy();
      expect(column.help, `${kind.kind}.${column.key}`).toBeTruthy();
      expect(column.example, `${kind.kind}.${column.key}`).not.toBeUndefined();
      expect(typeof column.parse).toBe('function');
    }
  }
});

test('starting an import needs a cut-over date only for opening balances', () => {
  const base = { fileKey: 'b/import_file/x.xlsx', fileName: 'customers.xlsx' };
  expect(importStartSchema.safeParse({ ...base, kind: 'customers' }).success).toBe(true);
  expect(importStartSchema.safeParse({ ...base, kind: 'opening_balances' }).success).toBe(false);
  expect(importStartSchema.safeParse({ ...base, kind: 'opening_balances', asOf: '2026-10-31' }).success).toBe(true);
  expect(importStartSchema.safeParse({ ...base, kind: 'customers', extra: 1 }).success).toBe(false);
  expect(importRowsQuery.parse({ status: 'error', limit: '20' })).toEqual({ status: 'error', limit: 20 });
});
