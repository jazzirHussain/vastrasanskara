import { test, expect } from 'vitest';
import {
  GST_RATES_BP, RULE46_ADDRESS_THRESHOLD, GstError, selectSlabRate, placeOfSupply, toMilli,
  computeInvoice, computeAdvanceTax, proportionalTax, computeCreditNote, correctionDeadline,
} from '../src/gst.js';

const CLOTHING = [
  { upToUnitPrice: 250000, rateBp: 500 },
  { upToUnitPrice: null, rateBp: 1800 },
];
const flat = (rateBp) => [{ upToUnitPrice: null, rateBp }];
const line = (o) => ({ key: 'a', quantity: 1, rate: 100000, gstSlabs: flat(500), ...o });

test('constants', () => {
  expect(GST_RATES_BP).toEqual([0, 25, 150, 300, 500, 1200, 1800, 2800, 4000]);
  expect(RULE46_ADDRESS_THRESHOLD).toBe(5000000);
});

test('clothing slab: 5% up to ₹2,500 a piece, 18% above', () => {
  expect(selectSlabRate(CLOTHING, { taxable: 250000, qtyMilli: 1000 })).toBe(500);
  expect(selectSlabRate(CLOTHING, { taxable: 250001, qtyMilli: 1000 })).toBe(1800);
});

test('a single-rate item ignores the price', () => {
  expect(selectSlabRate(flat(1200), { taxable: 99999999, qtyMilli: 1000 })).toBe(1200);
});

test('the slab uses the value per piece on a multi-piece line', () => {
  expect(selectSlabRate(CLOTHING, { taxable: 500000, qtyMilli: 2000 })).toBe(500);
  expect(selectSlabRate(CLOTHING, { taxable: 500002, qtyMilli: 2000 })).toBe(1800);
});

test('the slab follows the value after a line discount', () => {
  const r = computeInvoice({
    lines: [line({ rate: 260000, discount: 20000, gstSlabs: CLOTHING })], interState: false,
  });
  expect(r.lines[0].taxable).toBe(240000);
  expect(r.lines[0].rateBp).toBe(500);
});

test('the slab follows the share of a bill discount', () => {
  const r = computeInvoice({
    lines: [line({ rate: 260000, gstSlabs: CLOTHING })], invoiceDiscount: 10000, interState: false,
  });
  expect(r.lines[0].invoiceDiscountShare).toBe(10000);
  expect(r.lines[0].rateBp).toBe(500);
});

test('slabs must end with one open slab', () => {
  const bad = (slabs) => () => selectSlabRate(slabs, { taxable: 1, qtyMilli: 1000 });
  expect(bad([{ upToUnitPrice: 100, rateBp: 500 }])).toThrow(GstError);
  expect(bad([])).toThrow(GstError);
  expect(bad([{ upToUnitPrice: null, rateBp: 500 }, { upToUnitPrice: null, rateBp: 1800 }])).toThrow(GstError);
  expect(bad([{ upToUnitPrice: null, rateBp: 500 }, { upToUnitPrice: 100, rateBp: 1800 }])).toThrow(GstError);
  expect(bad([
    { upToUnitPrice: 200, rateBp: 500 }, { upToUnitPrice: 100, rateBp: 1800 }, { upToUnitPrice: null, rateBp: 1800 },
  ])).toThrow(GstError);
  expect(bad([])).toThrow(expect.objectContaining({ code: 'BAD_SLABS' }));
});

test('place of supply is the GSTIN state for a registered customer', () => {
  expect(placeOfSupply({
    branchStateCode: '29', customer: { gstin: '27AAPFU0939F1ZV', stateCode: '29' },
  })).toEqual({ stateCode: '27', stateName: 'Maharashtra', interState: true, registered: true });
});

test("place of supply is the customer's state when unregistered", () => {
  expect(placeOfSupply({
    branchStateCode: '29', customer: { gstin: null, stateCode: '33' },
  })).toEqual({ stateCode: '33', stateName: 'Tamil Nadu', interState: true, registered: false });
});

test('place of supply falls back to the branch state', () => {
  expect(placeOfSupply({
    branchStateCode: '29', customer: { gstin: null, stateCode: null },
  })).toEqual({ stateCode: '29', stateName: 'Karnataka', interState: false, registered: false });
});

test('toMilli parses by string', () => {
  expect(toMilli(1)).toBe(1000);
  expect(toMilli(2.5)).toBe(2500);
  expect(toMilli('0.125')).toBe(125);
  expect(() => toMilli(1.2345)).toThrow(RangeError);
});

test('same state splits CGST and SGST equally', () => {
  const r = computeInvoice({ lines: [line()], interState: false });
  expect(r.lines[0]).toMatchObject({ taxable: 100000, cgst: 2500, sgst: 2500, igst: 0, total: 105000 });
  expect(r.totals).toMatchObject({ cgst: 2500, sgst: 2500, igst: 0, tax: 5000, total: 105000, roundOff: 0 });
});

test('another state charges IGST', () => {
  const r = computeInvoice({ lines: [line()], interState: true });
  expect(r.lines[0]).toMatchObject({ cgst: 0, sgst: 0, igst: 5000, total: 105000 });
});

test('tax rounds half up per line in paise', () => {
  const inter = computeInvoice({ lines: [line({ rate: 1050 })], interState: true });
  expect(inter.lines[0].igst).toBe(53);
  const intra = computeInvoice({ lines: [line({ rate: 1050 })], interState: false });
  expect([intra.lines[0].cgst, intra.lines[0].sgst]).toEqual([26, 26]);
});

test('a bill discount is shared pro rata before tax and sums exactly', () => {
  const r = computeInvoice({
    lines: [line({ key: 'a', rate: 33333 }), line({ key: 'b', rate: 33333 }), line({ key: 'c', rate: 33334 })],
    invoiceDiscount: 10001, interState: false,
  });
  expect(r.lines.map((l) => l.invoiceDiscountShare)).toEqual([3334, 3333, 3334]);
  expect(r.totals.taxable).toBe(100000 - 10001);
  expect(r.totals.discount).toBe(10001);
  r.lines.forEach((l) => expect(l.taxable).toBe(l.gross - l.discount - l.invoiceDiscountShare));
});

test('a discount larger than its line is refused', () => {
  expect(() => computeInvoice({ lines: [line({ discount: 100001 })], interState: false }))
    .toThrow(expect.objectContaining({ code: 'DISCOUNT_EXCEEDS_LINE' }));
});

test('a bill discount larger than the bill is refused', () => {
  expect(() => computeInvoice({ lines: [line()], invoiceDiscount: 100001, interState: false }))
    .toThrow(expect.objectContaining({ code: 'DISCOUNT_EXCEEDS_TOTAL' }));
});

test('the total rounds to the rupee with a round-off', () => {
  const mk = (rate) => computeInvoice({ lines: [line({ rate, gstSlabs: flat(0) })], interState: false });
  expect(mk(1049).totals).toMatchObject({ subtotal: 1049, total: 1000, roundOff: -49 });
  expect(mk(1050).totals).toMatchObject({ subtotal: 1050, total: 1100, roundOff: 50 });
  expect(mk(1051).totals).toMatchObject({ total: 1100, roundOff: 49 });
});

test('fractional quantities', () => {
  const r = computeInvoice({
    lines: [line({ quantity: 2.5, rate: 18033, gstSlabs: flat(0) })], interState: false,
  });
  expect(r.lines[0].qtyMilli).toBe(2500);
  expect(r.lines[0].gross).toBe(45083);
});

test('zero-rated lines carry no tax', () => {
  const r = computeInvoice({ lines: [line({ gstSlabs: flat(0) })], interState: true });
  expect(r.totals).toMatchObject({ tax: 0, igst: 0, total: 100000 });
});

test('tax summary groups by HSN and rate', () => {
  const r = computeInvoice({
    lines: [
      line({ key: 'a', hsnSac: '9988', gstSlabs: flat(500) }),
      line({ key: 'b', hsnSac: '9988', gstSlabs: flat(500) }),
      line({ key: 'c', hsnSac: '9988', gstSlabs: flat(1800) }),
      line({ key: 'd', hsnSac: '6204', gstSlabs: flat(500) }),
    ],
    interState: false,
  });
  expect(r.taxSummary).toEqual([
    { hsnSac: '6204', rateBp: 500, taxable: 100000, cgst: 2500, sgst: 2500, igst: 0 },
    { hsnSac: '9988', rateBp: 500, taxable: 200000, cgst: 5000, sgst: 5000, igst: 0 },
    { hsnSac: '9988', rateBp: 1800, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0 },
  ]);
});

test('no lines is refused', () => {
  expect(() => computeInvoice({ lines: [], interState: false }))
    .toThrow(expect.objectContaining({ code: 'NO_LINES' }));
});

test('advance tax is backed out of the amount received', () => {
  const r = computeAdvanceTax({ amount: 118000, parts: [{ weight: 1, rateBp: 1800 }], interState: false });
  expect(r.lines).toEqual([{ rateBp: 1800, gross: 118000, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0 }]);
  expect(r).toMatchObject({ gross: 118000, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, tax: 18000 });
});

test('an advance over two rates splits pro rata and sums exactly', () => {
  const r = computeAdvanceTax({
    amount: 100001, parts: [{ weight: 1, rateBp: 500 }, { weight: 2, rateBp: 1800 }], interState: false,
  });
  expect(r.lines.reduce((a, l) => a + l.gross, 0)).toBe(100001);
  r.lines.forEach((l) => expect(l.taxable + l.cgst + l.sgst + l.igst).toBe(l.gross));
  expect(r.taxable + r.tax).toBe(100001);
});

test('an inter-state advance is IGST', () => {
  const r = computeAdvanceTax({ amount: 118000, parts: [{ weight: 1, rateBp: 1800 }], interState: true });
  expect(r).toMatchObject({ taxable: 100000, cgst: 0, sgst: 0, igst: 18000, tax: 18000 });
});

test('a part of a voucher is exact when it is the whole', () => {
  const of = { gross: 118001, taxable: 100001, cgst: 9000, sgst: 9000, igst: 0 };
  expect(proportionalTax({ part: 5000, whole: 5000, of })).toEqual(of);
  const half = proportionalTax({ part: 1, whole: 2, of });
  expect(half.taxable + half.cgst + half.sgst + half.igst).toBe(half.gross);
  expect(half.gross).toBe(59001);
});

test('a credit note taxes at the original rate', () => {
  const inv = computeInvoice({ lines: [line({ gstSlabs: flat(1800) })], interState: false });
  const cn = computeCreditNote({
    originalLines: inv.lines, credits: [{ key: 'a', taxable: 40000 }], creditedSoFar: {}, interState: false, full: false,
  });
  expect(cn.lines[0]).toMatchObject({ key: 'a', taxable: 40000, rateBp: 1800, cgst: 3600, sgst: 3600, total: 47200 });
  expect(cn.totals).toMatchObject({ taxable: 40000, tax: 7200, subtotal: 47200, total: 47200, roundOff: 0 });
});

test('a full credit note copies the bill exactly', () => {
  const inv = computeInvoice({
    lines: [line({ key: 'a', rate: 33333 }), line({ key: 'b', rate: 10049, gstSlabs: flat(1800) })], interState: false,
  });
  const cn = computeCreditNote({ originalLines: inv.lines, credits: [], creditedSoFar: {}, interState: false, full: true });
  expect(cn.lines).toEqual(inv.lines);
  expect(cn.totals.roundOff).toBe(inv.totals.roundOff);
  expect(cn.totals.total).toBe(inv.totals.total);
  expect(() => computeCreditNote({
    originalLines: inv.lines, credits: [], creditedSoFar: { a: 1 }, interState: false, full: true,
  })).toThrow(expect.objectContaining({ code: 'CREDIT_EXCEEDS_LINE' }));
});

test('credit beyond what is left on a line is refused', () => {
  const inv = computeInvoice({ lines: [line()], interState: false });
  const go = (taxable, so) => () => computeCreditNote({
    originalLines: inv.lines, credits: [{ key: 'a', taxable }], creditedSoFar: { a: so }, interState: false, full: false,
  });
  expect(go(60001, 40000)).toThrow(expect.objectContaining({ code: 'CREDIT_EXCEEDS_LINE' }));
  expect(go(60000, 40000)).not.toThrow();
});

test('the correction deadline is 30 November after the year ends', () => {
  expect(correctionDeadline('2027-03-31')).toBe('2027-11-30');
  expect(correctionDeadline('2027-04-01')).toBe('2028-11-30');
  expect(correctionDeadline('2026-12-15')).toBe('2027-11-30');
});

test('duplicate credit keys cannot exceed the line', () => {
  const inv = computeInvoice({ lines: [line()], interState: false });
  expect(() => computeCreditNote({
    originalLines: inv.lines,
    credits: [{ key: 'a', taxable: 40000 }, { key: 'a', taxable: 40000 }],
    creditedSoFar: { a: 40000 },
    interState: false,
    full: false,
  })).toThrow(expect.objectContaining({ code: 'CREDIT_EXCEEDS_LINE' }));
});

test('a voucher part must lie within the whole', () => {
  const of = { gross: 1000, taxable: 900, cgst: 50, sgst: 50, igst: 0 };
  expect(() => proportionalTax({ part: -1, whole: 10, of })).toThrow(RangeError);
  expect(() => proportionalTax({ part: 11, whole: 10, of })).toThrow(RangeError);
});

test('an advance amount must be a non-negative integer', () => {
  const parts = [{ weight: 1, rateBp: 500 }];
  expect(() => computeAdvanceTax({ amount: -1, parts, interState: false })).toThrow(RangeError);
  expect(() => computeAdvanceTax({ amount: 10.5, parts, interState: false })).toThrow(RangeError);
});
