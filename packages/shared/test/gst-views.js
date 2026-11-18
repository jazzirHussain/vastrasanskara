// Hand-built billing document views (the Task 3 `billingDocumentsInRange` shape) for the GST tests.
import { taxHeads } from '../src/gst.js';

const STATES = { '29': false };
const isInter = (stateCode) => !(stateCode in STATES);

/** A line at `rateBp` worth `taxable` paise, taxed as the place of supply says. */
export function line(rateBp, taxable, { stateCode = '29', hsnSac = '6204', unit = 'PCS', quantity = 1, supplyType = 'goods', description = 'Kurta' } = {}) {
  return { hsnSac, description, supplyType, unit, quantity, gstRateBp: rateBp, taxable, ...taxHeads(taxable, rateBp, isInter(stateCode)) };
}

function totalsOf(lines, total) {
  const sum = (k) => lines.reduce((a, l) => a + l[k], 0);
  const taxable = sum('taxable');
  const cgst = sum('cgst');
  const sgst = sum('sgst');
  const igst = sum('igst');
  const tax = cgst + sgst + igst;
  const exact = taxable + tax;
  const t = total ?? exact;
  return { taxable, cgst, sgst, igst, tax, roundOff: t - exact, total: t };
}

let seq = 0;

/** An invoice; `gstin` makes the customer registered, `stateCode` sets the place of supply. */
export function invoice({ number = `INV-${++seq}`, date = '2026-10-05', stateCode = '29', gstin = null, name = 'Asha', lines, total, status = 'issued', advanceAdjustments = [] } = {}) {
  const ls = lines ?? [line(500, 100000, { stateCode })];
  return {
    id: `id-${number}`,
    type: 'invoice',
    status,
    number,
    date,
    customer: { id: `c-${name}`, name, gstin, stateCode, registered: Boolean(gstin) },
    placeOfSupply: { stateCode, interState: isInter(stateCode) },
    totals: totalsOf(ls, total),
    lines: ls,
    original: null,
    advanceAdjustments,
    rvReversal: null,
  };
}

/** A credit note against `of` (an invoice view) crediting `lines`. */
export function creditNote(of, { number = `CN-${++seq}`, date = '2026-10-20', lines, status = 'issued' } = {}) {
  return {
    id: `id-${number}`,
    type: 'credit_note',
    status,
    number,
    date,
    customer: of.customer,
    placeOfSupply: of.placeOfSupply,
    totals: totalsOf(lines),
    lines,
    original: {
      id: of.id,
      number: of.number,
      date: of.date,
      total: of.totals.total,
      registered: of.customer.registered,
      interState: of.placeOfSupply.interState,
    },
    advanceAdjustments: [],
    rvReversal: null,
  };
}

/** A receipt voucher taxing an advance. */
export function receiptVoucher({ number = `RV-${++seq}`, date = '2026-10-02', stateCode = '29', lines, status = 'issued', name = 'Asha' } = {}) {
  const ls = lines ?? [line(500, 100000, { stateCode })];
  return {
    id: `id-${number}`,
    type: 'receipt_voucher',
    status,
    number,
    date,
    customer: { id: `c-${name}`, name, gstin: null, stateCode, registered: false },
    placeOfSupply: { stateCode, interState: isInter(stateCode) },
    totals: totalsOf(ls),
    lines: ls,
    original: null,
    advanceAdjustments: [],
    rvReversal: null,
  };
}

/** A payment receipt. */
export function receipt({ number = `RC-${++seq}`, date = '2026-10-02', amount, mode = 'cash', status = 'issued', name = 'Asha' } = {}) {
  return {
    id: `id-${number}`,
    type: 'receipt',
    status,
    number,
    date,
    customer: { id: `c-${name}`, name, gstin: null, stateCode: '29', registered: false },
    placeOfSupply: null,
    totals: null,
    lines: [],
    original: null,
    amount,
    mode,
    advanceAdjustments: [],
    rvReversal: null,
  };
}

/** A refund, optionally reversing receipt voucher tax. */
export function refund({ number = `RF-${++seq}`, date = '2026-10-25', amount, mode = 'cash', status = 'issued', name = 'Asha', rvReversal = null } = {}) {
  return { ...receipt({ number, date, amount, mode, status, name }), id: `id-${number}`, type: 'refund', rvReversal };
}
