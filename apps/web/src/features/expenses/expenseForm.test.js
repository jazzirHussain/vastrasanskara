import { test, expect } from 'vitest';
import { expenseSchema } from '@vs/shared/schemas/expenses.js';
import { changedFields, emptyExpenseForm, expenseToForm, formToBody, gstFigures } from './expenseForm.js';

const BRANCH = { branchStateCode: '29' };
const filled = (fields = {}) => ({
  ...emptyExpenseForm('2026-10-30'),
  amount: '1180',
  category: 'repairs',
  payee: { vendorId: null, name: 'Sharma Electricals', gstin: null, stateCode: null },
  ...fields,
});
const gstOn = (gst = {}) => ({ gstOpen: true, gst: { ...emptyExpenseForm('x').gst, gstin: '29ABCDE1234F1Z5', billNo: 'A/12', ...gst } });

test('the GST split follows the total and the rate and adds up', () => {
  expect(gstFigures({ totalPaise: 118000, rateBp: 1800, interState: false })).toEqual({ taxable: 100000, cgst: 9000, sgst: 9000, igst: 0 });
  for (const total of [100000, 99999, 12345, 1]) {
    const f = gstFigures({ totalPaise: total, rateBp: 500, interState: false });
    expect(f.taxable + f.cgst + f.sgst + f.igst).toBe(total);
    expect(f.cgst).toBe(f.sgst);
  }
});

test("the payee's state picks CGST/SGST or IGST", () => {
  const same = formToBody(filled({ ...gstOn() }), BRANCH);
  expect(same.gst.igst).toBe(0);
  expect(same.gst.cgst).toBeGreaterThan(0);
  const other = formToBody(filled({ ...gstOn({ gstin: '27ABCDE1234F1Z5' }) }), BRANCH);
  expect(other.gst.cgst).toBe(0);
  expect(other.gst.igst).toBe(18000);
  expect(other.payee.stateCode).toBe('27');
  const forced = formToBody(filled({ ...gstOn({ interState: true }) }), BRANCH);
  expect(forced.gst.igst).toBe(18000);
});

test('typed figures replace the computed ones', () => {
  const edited = { taxable: '1000.50', cgst: '89.75', igst: '' };
  expect(gstFigures({ totalPaise: 118000, rateBp: 1800, interState: false, edited })).toEqual({ taxable: 100050, cgst: 8975, sgst: 8975, igst: 0 });
  const body = formToBody(filled({ ...gstOn({ edited: { taxable: '1000', cgst: '90', igst: '' } }) }), BRANCH);
  expect(body.gst).toMatchObject({ taxable: 100000, cgst: 9000, sgst: 9000, igst: 0 });
  expect(expenseSchema.safeParse(body).success).toBe(true);
});

test('a folded GST section sends no GST', () => {
  const body = formToBody(filled({ gstOpen: false, gst: { ...emptyExpenseForm('x').gst, billNo: 'A/12' } }), BRANCH);
  expect(body.gst).toBeNull();
  expect(body).toMatchObject({ total: 118000, mode: 'cash', reference: '', date: '2026-10-30', link: null, attachments: [] });
});

const original = {
  id: 'e1',
  date: '2026-10-30',
  category: { key: 'repairs', label: 'Repairs' },
  note: '',
  payee: { vendorId: null, name: 'Sharma Electricals', gstin: '29ABCDE1234F1Z5', stateCode: '29' },
  total: 118000,
  mode: 'cash',
  reference: '',
  gst: { billNo: 'A/12', billDate: '2026-10-30', rateBp: 1800, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, interState: false, itcEligible: true },
  attachments: [{ key: 'b1/expense_bill/2026/x.jpg', name: 'bill.jpg', contentType: 'image/jpeg', size: 10 }],
  link: null,
  version: 3,
};

test('an edit sends only what changed', () => {
  const form = expenseToForm(original);
  expect(changedFields(form, original, BRANCH)).toEqual({});
  expect(changedFields({ ...form, note: 'Fan motor' }, original, BRANCH)).toEqual({ note: 'Fan motor' });
  const itc = changedFields({ ...form, gst: { ...form.gst, itcEligible: false } }, original, BRANCH);
  expect(Object.keys(itc)).toEqual(['gst']);
  expect(itc.gst.itcEligible).toBe(false);
  expect(itc.gst.taxable).toBe(100000);
});
