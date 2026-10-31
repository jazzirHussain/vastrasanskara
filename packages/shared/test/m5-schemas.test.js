import { test, expect } from 'vitest';
import {
  expenseSchema, expensePatchSchema, expenseVoidSchema, expenseListQuery, expenseSummaryQuery, payeesQuery,
} from '../src/schemas/expenses.js';

const id = (n) => String(n).padStart(24, 'a');
const base = { date: '2026-10-30', category: 'rent', total: 500000, mode: 'cash', payee: { name: 'Landlord' } };
const ok = (o) => expenseSchema.safeParse({ ...base, ...o }).success;
const issues = (o) => {
  const r = expenseSchema.safeParse({ ...base, ...o });
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};
const gstOk = { billNo: 'B-12', billDate: '2026-10-29', rateBp: 1800, taxable: 423700, cgst: 38150, sgst: 38150, igst: 0 };

test('an expense needs an amount, a category, a payee and a mode', () => {
  expect(ok({})).toBe(true);
  for (const k of ['date', 'category', 'total', 'mode', 'payee']) {
    const rest = { ...base };
    delete rest[k];
    expect(expenseSchema.safeParse(rest).success).toBe(false);
  }
  expect(ok({ total: 0 })).toBe(false);
  expect(ok({ mode: 'cheque' })).toBe(false);
  expect(ok({ category: 'Rent' })).toBe(false);
  const parsed = expenseSchema.parse(base);
  expect(parsed).toMatchObject({
    note: '', reference: '', gst: null, attachments: [], link: null,
    payee: { vendorId: null, name: 'Landlord', gstin: null, stateCode: null },
  });
});

test('a vendor or a name is enough for the payee', () => {
  expect(ok({ payee: { vendorId: id(1) } })).toBe(true);
  expect(ok({ payee: { name: 'Tea stall' } })).toBe(true);
  expect(issues({ payee: {} })).toContain('payee.name');
  expect(issues({ payee: { name: '   ' } })).toContain('payee.name');
});

test('a GSTIN fixes the payee state', () => {
  expect(ok({ payee: { name: 'X', gstin: '29AAPFU0939F1ZV', stateCode: '29' } })).toBe(true);
  expect(issues({ payee: { name: 'X', gstin: '29AAPFU0939F1ZV', stateCode: '27' } })).toContain('payee.stateCode');
});

test('GST figures must add up to the total', () => {
  const total = 423700 + 76300;
  expect(ok({ total, gst: gstOk })).toBe(true);
  expect(ok({ total: total + 1, gst: gstOk })).toBe(false);
  expect(issues({ total: total + 1, gst: gstOk })).toContain('gst.taxable');
  expect(ok({ total, gst: { ...gstOk, itcEligible: false } })).toBe(true);
  expect(expenseSchema.parse({ ...base, total, gst: gstOk }).gst.itcEligible).toBe(true);
  expect(ok({ total, gst: { ...gstOk, cgst: 0, sgst: 0, igst: 76300, rateBp: null } })).toBe(true);
  expect(ok({ total: 423700 + 76300 + 76300, gst: { ...gstOk, igst: 76300, rateBp: null } })).toBe(false);
});

test('a GST bill number is at most 16 characters', () => {
  const total = 500000;
  expect(ok({ total, gst: { ...gstOk, billNo: 'A'.repeat(16) } })).toBe(true);
  expect(ok({ total, gst: { ...gstOk, billNo: 'A'.repeat(17) } })).toBe(false);
  expect(ok({ total, gst: { ...gstOk, billNo: 'A B' } })).toBe(false);
  expect(ok({ total, gst: { ...gstOk, billNo: '' } })).toBe(false);
});

test('the bill date cannot be after the payment date', () => {
  expect(issues({ total: 500000, gst: { ...gstOk, billDate: '2026-10-31' } })).toContain('gst.billDate');
  expect(ok({ total: 500000, gst: { ...gstOk, billDate: '2026-10-30' } })).toBe(true);
});

test('at most five photos, no repeats', () => {
  const photos = (n) => Array.from({ length: n }, (_, i) => ({ key: `k/${i}`, name: `p${i}.jpg` }));
  expect(ok({ attachments: photos(5) })).toBe(true);
  expect(ok({ attachments: photos(6) })).toBe(false);
  expect(ok({ attachments: [{ key: 'a', name: 'x' }, { key: 'a', name: 'y' }] })).toBe(false);
});

test('a link is a garment, batch or order', () => {
  for (const kind of ['garment', 'batch', 'order']) expect(ok({ link: { kind, id: id(2) } })).toBe(true);
  expect(ok({ link: { kind: 'customer', id: id(2) } })).toBe(false);
  expect(ok({ link: { kind: 'order', id: 'nope' } })).toBe(false);
  expect(ok({ link: null })).toBe(true);
});

test('unknown keys are refused', () => {
  expect(ok({ colour: 'red' })).toBe(false);
  expect(ok({ payee: { name: 'X', phone: '1' } })).toBe(false);
  expect(expensePatchSchema.safeParse({ colour: 'red' }).success).toBe(false);
});

test('a patch is never filled with defaults and cannot be empty', () => {
  expect(expensePatchSchema.safeParse({}).success).toBe(false);
  expect(expensePatchSchema.parse({ total: 100 })).toEqual({ total: 100 });
  const payee = { vendorId: null, name: 'X', gstin: null, stateCode: null };
  expect(expensePatchSchema.parse({ payee })).toEqual({ payee });
  expect(expensePatchSchema.safeParse({ total: 0 }).success).toBe(false);
  expect(expenseVoidSchema.safeParse({ reason: '  ' }).success).toBe(false);
  expect(expenseVoidSchema.parse({ reason: ' Duplicate ' })).toEqual({ reason: 'Duplicate' });
});

test('the list takes a month or a date range, not both', () => {
  expect(expenseListQuery.parse({})).toEqual({ status: 'active' });
  expect(expenseListQuery.safeParse({ month: '2026-10' }).success).toBe(true);
  expect(expenseListQuery.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(true);
  expect(expenseListQuery.safeParse({ month: '2026-10', from: '2026-10-01' }).success).toBe(false);
  expect(expenseListQuery.safeParse({ month: '2026-13' }).success).toBe(false);
  expect(expenseListQuery.parse({ noBill: 'true', limit: '20' })).toMatchObject({ noBill: true, limit: 20 });
  expect(expenseListQuery.safeParse({ limit: '101' }).success).toBe(false);
  expect(expenseListQuery.safeParse({ status: 'gone' }).success).toBe(false);
  expect(expenseSummaryQuery.safeParse({}).success).toBe(false);
  expect(expenseSummaryQuery.safeParse({ month: '2026-10' }).success).toBe(true);
  expect(payeesQuery.parse({ q: ' ab ' })).toEqual({ q: 'ab' });
  expect(payeesQuery.parse({})).toEqual({});
});
