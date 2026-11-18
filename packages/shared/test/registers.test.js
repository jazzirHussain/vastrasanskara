import { test, expect } from 'vitest';
import {
  REGISTER_COLUMNS, collectionsByMode, creditNoteRows, dayBookRows, salesRegisterRows, voucherRows,
} from '../src/reports/registers.js';
import { creditNote, invoice, line, receipt, receiptVoucher, refund } from './gst-views.js';

const KINDS = new Set(['money', 'date', 'number', 'text']);

test('every register column is a Task 1 descriptor with a plain label', () => {
  for (const cols of Object.values(REGISTER_COLUMNS)) {
    for (const c of cols) {
      expect(Object.keys(c).sort()).toEqual(['key', 'kind', 'label']);
      expect(KINDS.has(c.kind)).toBe(true);
    }
  }
  expect(REGISTER_COLUMNS.sales.map((c) => c.label)).toEqual([
    'Bill number', 'Date', 'Customer', 'GSTIN', 'Place of supply', 'Taxable value', 'CGST', 'SGST', 'IGST',
    'Round-off', 'Total', 'Status',
  ]);
});

test('the sales register shows cancelled bills at zero', () => {
  const issued = invoice({ number: 'INV-1', date: '2026-10-02', gstin: '29ABCDE1234F1Z5', name: 'Sri Silks', lines: [line(500, 100000)], total: 105000 });
  const kerala = invoice({ number: 'INV-2', date: '2026-10-03', stateCode: '32', name: 'Mini', lines: [line(1800, 10000, { stateCode: '32' })], total: 11800 });
  const cancelled = invoice({ number: 'INV-3', date: '2026-10-01', status: 'cancelled', lines: [line(500, 100000)] });
  const rows = salesRegisterRows([kerala, cancelled, issued, receipt({ amount: 500 })]);
  expect(rows).toEqual([
    {
      number: 'INV-3', date: '2026-10-01', customer: 'Asha', gstin: '', placeOfSupply: '29-Karnataka',
      taxable: 0, cgst: 0, sgst: 0, igst: 0, roundOff: 0, total: 0, status: 'Cancelled',
    },
    {
      number: 'INV-1', date: '2026-10-02', customer: 'Sri Silks', gstin: '29ABCDE1234F1Z5', placeOfSupply: '29-Karnataka',
      taxable: 100000, cgst: 2500, sgst: 2500, igst: 0, roundOff: 0, total: 105000, status: 'Issued',
    },
    {
      number: 'INV-2', date: '2026-10-03', customer: 'Mini', gstin: '', placeOfSupply: '32-Kerala',
      taxable: 10000, cgst: 0, sgst: 0, igst: 1800, roundOff: 0, total: 11800, status: 'Issued',
    },
  ]);
});

test('credit notes and vouchers list their documents, cancelled ones at zero', () => {
  const bill = invoice({ number: 'INV-1', date: '2026-10-02' });
  const notes = creditNoteRows([creditNote(bill, { number: 'CN-1', date: '2026-10-09', lines: [line(500, 20000)] })]);
  expect(notes).toEqual([
    {
      number: 'CN-1', date: '2026-10-09', originalNumber: 'INV-1', originalDate: '2026-10-02', customer: 'Asha', gstin: '',
      placeOfSupply: '29-Karnataka', taxable: 20000, cgst: 500, sgst: 500, igst: 0, roundOff: 0, total: 21000, status: 'Issued',
    },
  ]);
  expect(REGISTER_COLUMNS.creditNotes.map((c) => c.key)).toEqual(Object.keys(notes[0]));

  const rvs = voucherRows([receiptVoucher({ number: 'RV-1', date: '2026-10-02', lines: [line(500, 40000)] }), receiptVoucher({ number: 'RV-2', status: 'cancelled' })], 'receipt_voucher');
  expect(rvs).toEqual([
    { number: 'RV-1', date: '2026-10-02', customer: 'Asha', placeOfSupply: '29-Karnataka', amount: 42000, taxable: 40000, cgst: 1000, sgst: 1000, igst: 0, status: 'Issued' },
    { number: 'RV-2', date: '2026-10-02', customer: 'Asha', placeOfSupply: '29-Karnataka', amount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, status: 'Cancelled' },
  ]);
  expect(REGISTER_COLUMNS.receiptVouchers.map((c) => c.key)).toEqual(Object.keys(rvs[0]));

  const refunds = voucherRows([
    refund({ number: 'RF-1', date: '2026-10-25', amount: 4200, mode: 'upi', rvReversal: { stateCode: '29', gstRateBp: 500, taxable: 4000, cgst: 100, sgst: 100, igst: 0 } }),
    refund({ number: 'RF-2', date: '2026-10-26', amount: 900 }),
  ], 'refund');
  expect(refunds).toEqual([
    { number: 'RF-1', date: '2026-10-25', customer: 'Asha', mode: 'UPI', amount: 4200, taxable: 4000, cgst: 100, sgst: 100, igst: 0, status: 'Issued' },
    { number: 'RF-2', date: '2026-10-26', customer: 'Asha', mode: 'Cash', amount: 900, taxable: 0, cgst: 0, sgst: 0, igst: 0, status: 'Issued' },
  ]);
  expect(REGISTER_COLUMNS.refunds.map((c) => c.key)).toEqual(Object.keys(refunds[0]));
  expect(() => voucherRows([], 'invoice')).toThrow(RangeError);
});

test('collections by mode net refunds per day', () => {
  const rows = collectionsByMode([
    receipt({ date: '2026-10-02', amount: 50000, mode: 'upi' }),
    receipt({ date: '2026-10-02', amount: 20000, mode: 'cash' }),
    receipt({ date: '2026-10-02', amount: 30000, mode: 'upi' }),
    refund({ date: '2026-10-02', amount: 5000, mode: 'upi' }),
    refund({ date: '2026-10-03', amount: 7000, mode: 'cash' }),
    receipt({ date: '2026-10-03', amount: 99900, mode: 'card', status: 'cancelled' }),
    invoice({ date: '2026-10-02' }),
  ]);
  expect(rows).toEqual([
    { date: '2026-10-02', mode: 'Cash', receipts: 20000, refunds: 0, net: 20000 },
    { date: '2026-10-02', mode: 'UPI', receipts: 80000, refunds: 5000, net: 75000 },
    { date: '2026-10-03', mode: 'Cash', receipts: 0, refunds: 7000, net: -7000 },
  ]);
  expect(REGISTER_COLUMNS.collections.map((c) => c.key)).toEqual(Object.keys(rows[0]));
});

test('the day book interleaves bills, payments and expenses by date', () => {
  const bill = invoice({ number: 'INV-1', date: '2026-10-02', name: 'Asha', lines: [line(500, 100000)] });
  const rows = dayBookRows({
    billing: [
      receipt({ number: 'RC-2', date: '2026-10-03', amount: 105000, name: 'Asha' }),
      bill,
      creditNote(bill, { number: 'CN-1', date: '2026-10-04', lines: [line(500, 20000)] }),
      refund({ number: 'RF-1', date: '2026-10-04', amount: 21000, name: 'Asha' }),
      receiptVoucher({ number: 'RV-1', date: '2026-10-03' }),
      invoice({ number: 'INV-9', date: '2026-10-02', status: 'cancelled' }),
    ],
    expenses: [
      { number: 'EXP-2', date: '2026-10-03', payee: { name: 'Thread shop' }, total: 4000, status: 'active' },
      { number: 'EXP-1', date: '2026-10-01', payee: { name: 'Electricity' }, total: 150000, status: 'active' },
      { number: 'EXP-3', date: '2026-10-02', payee: { name: 'Voided' }, total: 1, status: 'voided' },
    ],
  });
  expect(rows).toEqual([
    { date: '2026-10-01', kind: 'Expense', number: 'EXP-1', party: 'Electricity', in: 0, out: 150000 },
    { date: '2026-10-02', kind: 'Bill', number: 'INV-1', party: 'Asha', in: 105000, out: 0 },
    { date: '2026-10-03', kind: 'Payment', number: 'RC-2', party: 'Asha', in: 105000, out: 0 },
    { date: '2026-10-03', kind: 'Expense', number: 'EXP-2', party: 'Thread shop', in: 0, out: 4000 },
    { date: '2026-10-04', kind: 'Credit note', number: 'CN-1', party: 'Asha', in: 0, out: 21000 },
    { date: '2026-10-04', kind: 'Refund', number: 'RF-1', party: 'Asha', in: 0, out: 21000 },
  ]);
  expect(REGISTER_COLUMNS.dayBook.map((c) => c.key)).toEqual(Object.keys(rows[0]));
});
