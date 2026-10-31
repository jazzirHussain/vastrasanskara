import { test, expect } from 'vitest';
import {
  DOC_TYPES, PREFIX_FIELD, MAX_DOC_NUMBER_LENGTH, formatDocumentNumber, daysBetween, payStatus,
  reminderSequence, ageingBucket,
} from '../src/billing.js';
import { GST_STATES, stateName } from '../src/states.js';
import { financialYear } from '../src/fy.js';

test('document numbers look like INV/2627/0001', () => {
  expect(formatDocumentNumber('INV', '2627', 1)).toBe('INV/2627/0001');
  expect(formatDocumentNumber('CN', '2627', 123)).toBe('CN/2627/0123');
  expect(DOC_TYPES).toEqual(['invoice', 'credit_note', 'receipt', 'receipt_voucher', 'refund']);
  expect(PREFIX_FIELD.credit_note).toBe('creditNote');
  expect(PREFIX_FIELD.receipt_voucher).toBe('receiptVoucher');
  expect(MAX_DOC_NUMBER_LENGTH).toBe(16);
});

test('numbers past 9999 keep growing', () => {
  expect(formatDocumentNumber('INV', '2627', 10000)).toBe('INV/2627/10000');
});

test('a number over 16 characters is refused', () => {
  expect(formatDocumentNumber('ABCDEF', '2627', 1)).toBe('ABCDEF/2627/0001');
  expect(() => formatDocumentNumber('ABCDEF', '2627', 10000)).toThrow(RangeError);
  expect(() => formatDocumentNumber('INV', '2627', 0)).toThrow(RangeError);
});

test('the financial year flips at midnight IST on 1 April', () => {
  const before = financialYear(new Date('2027-03-31T18:29:59Z')).code;
  const after = financialYear(new Date('2027-03-31T18:30:00Z')).code;
  expect(formatDocumentNumber('INV', before, 9)).toBe('INV/2627/0009');
  expect(formatDocumentNumber('INV', after, 1)).toBe('INV/2728/0001');
});

test('pay status', () => {
  expect(payStatus({ total: 1000, balance: 0 })).toBe('paid');
  expect(payStatus({ total: 1000, balance: 400 })).toBe('part_paid');
  expect(payStatus({ total: 1000, balance: 1000 })).toBe('unpaid');
});

test('days between', () => {
  expect(daysBetween('2027-02-28', '2027-03-02')).toBe(2);
  expect(daysBetween('2027-03-02', '2027-02-28')).toBe(-2);
});

test('reminders the day after due, then weekly, four at most', () => {
  const due = '2027-01-10';
  expect(reminderSequence(due, '2027-01-10')).toBeNull();
  expect(reminderSequence(due, '2027-01-11')).toBe(1);
  expect(reminderSequence(due, '2027-01-17')).toBe(1);
  expect(reminderSequence(due, '2027-01-18')).toBe(2);
  expect(reminderSequence(due, '2027-01-25')).toBe(3);
  expect(reminderSequence(due, '2027-02-01')).toBe(4);
  expect(reminderSequence(due, '2027-02-07')).toBe(4);
  expect(reminderSequence(due, '2027-02-08')).toBeNull();
});

test('ageing buckets by days past due', () => {
  const due = '2027-01-01';
  const at = (n) => ageingBucket(due, new Date(Date.UTC(2027, 0, 1 + n)).toISOString().slice(0, 10));
  expect(at(-5)).toBe('not_due');
  expect(at(0)).toBe('not_due');
  expect(at(1)).toBe('d0_30');
  expect(at(30)).toBe('d0_30');
  expect(at(31)).toBe('d31_60');
  expect(at(60)).toBe('d31_60');
  expect(at(61)).toBe('d61_90');
  expect(at(90)).toBe('d61_90');
  expect(at(91)).toBe('d90_plus');
});

test('every GST state code has a name', () => {
  for (let i = 1; i <= 38; i++) {
    const code = String(i).padStart(2, '0');
    expect(stateName(code), code).toBeTruthy();
  }
  expect(stateName('29')).toBe('Karnataka');
  expect(stateName('97')).toBe('Other Territory');
  expect(() => stateName('99')).toThrow();
  expect(Object.isFrozen(GST_STATES)).toBe(true);
});
