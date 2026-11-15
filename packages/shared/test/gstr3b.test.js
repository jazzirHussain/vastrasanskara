import { test, expect } from 'vitest';
import { gstSetOff, gstr3bSummary } from '../src/reports/gstr3b.js';
import { creditNote, invoice, line, receiptVoucher, refund } from './gst-views.js';

const NO_ITC = {
  count: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0,
  itc: { cgst: 0, sgst: 0, igst: 0 },
  ineligible: { cgst: 0, sgst: 0, igst: 0 },
};

test('outward supplies are bills less credit notes plus net advances', () => {
  const local = invoice({
    lines: [line(500, 100000), line(0, 30000)],
    advanceAdjustments: [{ stateCode: '29', gstRateBp: 500, taxable: 10000, cgst: 250, sgst: 250, igst: 0 }],
  });
  const kerala = invoice({ stateCode: '32', lines: [line(1800, 200000, { stateCode: '32' })] });
  const docs = [
    local,
    kerala,
    creditNote(local, { lines: [line(500, 20000), line(0, 5000)] }),
    receiptVoucher({ lines: [line(500, 40000)] }),
    refund({ amount: 4200, rvReversal: { stateCode: '29', gstRateBp: 500, taxable: 4000, cgst: 100, sgst: 100, igst: 0 } }),
    invoice({ status: 'cancelled', lines: [line(1800, 999900)] }),
    receiptVoucher({ status: 'cancelled', lines: [line(500, 888800)] }),
  ];
  const out = gstr3bSummary({ docs, itc: NO_ITC });
  expect(out.outward).toEqual({ taxable: 306000, igst: 36000, cgst: 2650, sgst: 2650 });
});

test('zero-rated lines go to nil-rated', () => {
  const bill = invoice({ lines: [line(500, 100000), line(0, 30000)] });
  const out = gstr3bSummary({
    docs: [bill, creditNote(bill, { lines: [line(0, 5000)] }), invoice({ lines: [line(0, 12000)] })],
    itc: NO_ITC,
  });
  expect(out.nilRated).toEqual({ taxable: 37000 });
  expect(out.outward.taxable).toBe(100000);
});

test('inter-state supplies to unregistered persons are listed by state', () => {
  const kerala = invoice({ stateCode: '32', lines: [line(1800, 200000, { stateCode: '32' })] });
  const docs = [
    kerala,
    invoice({ stateCode: '33', lines: [line(1200, 50000, { stateCode: '33' })] }),
    invoice({ stateCode: '32', lines: [line(500, 10000, { stateCode: '32' }), line(0, 7000, { stateCode: '32' })] }),
    invoice({ stateCode: '27', gstin: '27AAACB1234C1Z2', lines: [line(1800, 500000, { stateCode: '27' })] }),
    invoice({ lines: [line(500, 100000)] }),
    creditNote(kerala, { lines: [line(1800, 50000, { stateCode: '32' })] }),
  ];
  expect(gstr3bSummary({ docs, itc: NO_ITC }).interStateUnregistered).toEqual([
    { placeOfSupply: '32-Kerala', taxable: 160000, igst: 27500 },
    { placeOfSupply: '33-Tamil Nadu', taxable: 50000, igst: 6000 },
  ]);
});

test('input tax credit comes from the expenses summary and pays the outward tax', () => {
  const itc = {
    count: 3, taxable: 300000, cgst: 4000, sgst: 4000, igst: 1000,
    itc: { cgst: 3000, sgst: 3000, igst: 1000 },
    ineligible: { cgst: 1000, sgst: 1000, igst: 0 },
  };
  const out = gstr3bSummary({ docs: [invoice({ lines: [line(500, 200000)] })], itc });
  expect(out.itc).toEqual({ igst: 1000, cgst: 3000, sgst: 3000 });
  expect(out.ineligible).toEqual({ igst: 0, cgst: 1000, sgst: 1000 });
  // Liability 5000 / 5000; IGST credit 1000 goes to CGST first.
  expect(out.setOff.cash).toEqual({ igst: 0, cgst: 1000, sgst: 2000 });
  expect(out.setOff.creditUsed.igst).toEqual({ igst: 0, cgst: 1000, sgst: 0 });
});

const zero = { igst: 0, cgst: 0, sgst: 0 };

test.each([
  {
    name: 'IGST credit pays IGST, then CGST',
    liability: { igst: 10000, cgst: 5000, sgst: 5000 },
    credit: { igst: 12000, cgst: 1000, sgst: 1000 },
    creditUsed: { igst: { igst: 10000, cgst: 2000, sgst: 0 }, cgst: { cgst: 1000, igst: 0 }, sgst: { sgst: 1000, igst: 0 } },
    cash: { igst: 0, cgst: 2000, sgst: 4000 },
    carriedForward: zero,
  },
  {
    name: 'IGST credit spills from CGST into SGST',
    liability: { igst: 0, cgst: 3000, sgst: 3000 },
    credit: { igst: 4000, cgst: 0, sgst: 0 },
    creditUsed: { igst: { igst: 0, cgst: 3000, sgst: 1000 }, cgst: { cgst: 0, igst: 0 }, sgst: { sgst: 0, igst: 0 } },
    cash: { igst: 0, cgst: 0, sgst: 2000 },
    carriedForward: zero,
  },
  {
    name: 'CGST and SGST credit pay their own head, then IGST',
    liability: { igst: 5000, cgst: 1000, sgst: 1000 },
    credit: { igst: 0, cgst: 4000, sgst: 500 },
    creditUsed: { igst: { igst: 0, cgst: 0, sgst: 0 }, cgst: { cgst: 1000, igst: 3000 }, sgst: { sgst: 500, igst: 0 } },
    cash: { igst: 2000, cgst: 0, sgst: 500 },
    carriedForward: zero,
  },
  {
    name: 'leftover credit is carried forward',
    liability: { igst: 1000, cgst: 1000, sgst: 1000 },
    credit: { igst: 500, cgst: 5000, sgst: 5000 },
    creditUsed: { igst: { igst: 500, cgst: 0, sgst: 0 }, cgst: { cgst: 1000, igst: 500 }, sgst: { sgst: 1000, igst: 0 } },
    cash: zero,
    carriedForward: { igst: 0, cgst: 3500, sgst: 4000 },
  },
])('IGST credit is used first, then CGST and SGST credit: $name', ({ liability, credit, creditUsed, cash, carriedForward }) => {
  const out = gstSetOff({ liability, credit });
  expect(out).toEqual({ creditUsed, cash, carriedForward });
  const values = [
    ...Object.values(out.creditUsed).flatMap((h) => Object.values(h)),
    ...Object.values(out.cash),
    ...Object.values(out.carriedForward),
  ];
  for (const v of values) expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
  // Every paisa of liability is paid by credit or cash; every paisa of credit is used or carried.
  for (const head of ['igst', 'cgst', 'sgst']) {
    const paidByCredit = Object.values(out.creditUsed).reduce((a, used) => a + (used[head] ?? 0), 0);
    expect(paidByCredit + out.cash[head]).toBe(liability[head]);
    const used = Object.values(out.creditUsed[head]).reduce((a, v) => a + v, 0);
    expect(used + out.carriedForward[head]).toBe(credit[head]);
  }
});

test('CGST credit never pays SGST', () => {
  const out = gstSetOff({ liability: { igst: 0, cgst: 0, sgst: 5000 }, credit: { igst: 0, cgst: 9000, sgst: 0 } });
  expect(out.cash).toEqual({ igst: 0, cgst: 0, sgst: 5000 });
  expect(out.carriedForward).toEqual({ igst: 0, cgst: 9000, sgst: 0 });
  expect(out.creditUsed.cgst).toEqual({ cgst: 0, igst: 0 });
});

test('a month where credit notes exceed sales owes nothing and goes negative nowhere', () => {
  const out = gstSetOff({ liability: { igst: -500, cgst: -100, sgst: 0 }, credit: { igst: 300, cgst: 0, sgst: 0 } });
  expect(out.cash).toEqual(zero);
  expect(out.carriedForward).toEqual({ igst: 300, cgst: 0, sgst: 0 });
});

test('a refund drawn on a two-rate voucher reduces outward tax by every part', () => {
  const parts = [
    { stateCode: '29', gstRateBp: 500, taxable: 30000, cgst: 750, sgst: 750, igst: 0 },
    { stateCode: '29', gstRateBp: 0, taxable: 5000, cgst: 0, sgst: 0, igst: 0 },
  ];
  const r = refund({ amount: 36500, rvReversal: { taxable: 35000, cgst: 750, sgst: 750, igst: 0, gstRateBp: null, stateCode: null } });
  const out = gstr3bSummary({ docs: [{ ...r, rvReversalParts: parts }], itc: NO_ITC });
  expect(out.outward).toEqual({ taxable: -30000, igst: 0, cgst: -750, sgst: -750 });
  expect(out.nilRated).toEqual({ taxable: -5000 });
});
