import { test, expect } from 'vitest';
import {
  DEFAULT_EXPENSE_CATEGORIES,
  formatExpenseNumber,
  splitGstFromTotal,
  taxOnTaxable,
  checkExpenseTax,
  payeeInterState,
  expenseCost,
} from '../src/expenses.js';
import { GST_RATES_BP } from '../src/gst.js';

test('expense numbers look like EXP/2627/0001', () => {
  expect(formatExpenseNumber('EXP', '2627', 1)).toBe('EXP/2627/0001');
  expect(formatExpenseNumber('EXP', '2627', 42)).toBe('EXP/2627/0042');
  expect(() => formatExpenseNumber('EXP', '2627', 0)).toThrow(RangeError);
});

test('long prefixes and numbers past 9999 are allowed', () => {
  expect(formatExpenseNumber('EXPENSE', '2627', 12345)).toBe('EXPENSE/2627/12345');
});

test('the split from a total always adds up', () => {
  expect(splitGstFromTotal({ total: 118000, rateBp: 1800, interState: false })).toMatchObject({
    taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, tax: 18000,
  });
  const five = splitGstFromTotal({ total: 100000, rateBp: 500, interState: false });
  expect(five.taxable + five.tax).toBe(100000);
  for (const rateBp of GST_RATES_BP) {
    for (let total = 1; total <= 2000; total += 1) {
      const s = splitGstFromTotal({ total, rateBp, interState: false });
      expect(s.taxable + s.tax).toBe(total);
      expect(s.cgst).toBe(s.sgst);
    }
  }
});

test('an inter-state split is IGST', () => {
  const s = splitGstFromTotal({ total: 118000, rateBp: 1800, interState: true });
  expect(s).toMatchObject({ taxable: 100000, cgst: 0, sgst: 0, igst: 18000, tax: 18000 });
});

test('tax on a before-GST amount', () => {
  expect(taxOnTaxable({ taxable: 100000, rateBp: 1800, interState: false })).toEqual({
    cgst: 9000, sgst: 9000, igst: 0, tax: 18000, total: 118000,
  });
  expect(taxOnTaxable({ taxable: 100000, rateBp: 500, interState: true })).toMatchObject({ igst: 5000, total: 105000 });
});

test('a zero rate has no tax', () => {
  expect(splitGstFromTotal({ total: 5000, rateBp: 0, interState: false })).toMatchObject({ taxable: 5000, tax: 0 });
  expect(taxOnTaxable({ taxable: 5000, rateBp: 0, interState: false }).tax).toBe(0);
});

const gst = (o) => ({ rateBp: 1800, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, ...o });

test('checkExpenseTax accepts a matching bill and no bill', () => {
  expect(checkExpenseTax({ total: 118000, gst: gst() })).toEqual([]);
  expect(checkExpenseTax({ total: 118000, gst: null })).toEqual([]);
});

test('tax must add up to the total', () => {
  const issues = checkExpenseTax({ total: 118100, gst: gst() });
  expect(issues).toEqual([{ path: 'gst.taxable', message: 'Before-GST amount and tax must add up to the total' }]);
});

test('CGST/SGST and IGST together are refused', () => {
  const issues = checkExpenseTax({ total: 127000, gst: gst({ igst: 9000, rateBp: null }) });
  expect(issues.map((i) => i.path)).toContain('gst.igst');
});

test('CGST and SGST must be equal', () => {
  const issues = checkExpenseTax({ total: 118000, gst: gst({ cgst: 8000, sgst: 10000, rateBp: null }) });
  expect(issues.map((i) => i.path)).toEqual(['gst.sgst']);
});

test('a head more than ₹1 off the rate is refused; within ₹1 is accepted', () => {
  // taxable 100000 at 18% = 9000 each; 9100 is exactly ₹1 off, 9101 is more
  expect(checkExpenseTax({ total: 118200, gst: gst({ cgst: 9100, sgst: 9100 }) })).toEqual([]);
  const issues = checkExpenseTax({ total: 118202, gst: gst({ cgst: 9101, sgst: 9101 }) });
  expect(issues.map((i) => i.path)).toEqual(['gst.cgst', 'gst.sgst']);
  expect(issues[0].message).toBe('This tax does not match the rate. Check the bill.');
  const inter = checkExpenseTax({ total: 118000 + 500, gst: gst({ cgst: 0, sgst: 0, igst: 18500 }) });
  expect(inter.map((i) => i.path)).toEqual(['gst.igst']);
});

test('mixed rates skip the rate check', () => {
  expect(checkExpenseTax({ total: 110000, gst: gst({ rateBp: null, cgst: 5000, sgst: 5000, taxable: 100000 }) })).toEqual([]);
});

test("the payee's state decides the default tax type", () => {
  const base = { branchStateCode: '29' };
  expect(payeeInterState({ ...base, payee: { gstin: null, stateCode: '29' } })).toBe(false);
  expect(payeeInterState({ ...base, payee: { gstin: '27AAPFU0939F1ZV', stateCode: null } })).toBe(true);
  expect(payeeInterState({ ...base, payee: { gstin: null, stateCode: null } })).toBe(false);
});

test('cost is the before-GST amount when GST can be claimed', () => {
  const e = { status: 'active', total: 118000, gst: gst({ itcEligible: true }) };
  expect(expenseCost(e)).toBe(100000);
  expect(expenseCost({ status: 'active', total: 5000, gst: null })).toBe(5000);
});

test('cost includes GST when it cannot', () => {
  expect(expenseCost({ status: 'active', total: 118000, gst: gst({ itcEligible: false }) })).toBe(118000);
});

test('a voided expense costs nothing', () => {
  expect(expenseCost({ status: 'voided', total: 5000, gst: null })).toBe(0);
});

test('default categories have unique keys and include material_purchase', () => {
  const keys = DEFAULT_EXPENSE_CATEGORIES.map((c) => c.key);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys).toContain('material_purchase');
  expect(keys).toHaveLength(15);
  expect(DEFAULT_EXPENSE_CATEGORIES.every((c) => c.active)).toBe(true);
  expect(Object.isFrozen(DEFAULT_EXPENSE_CATEGORIES)).toBe(true);
});
