// Pure GST maths. All amounts are integer paise, rates are integer basis points, quantities are thousandths.
import { allocateProRata, mulDivRound, roundToRupee } from './money.js';
import { financialYear, istDayBounds } from './fy.js';
import { stateName } from './states.js';

export const GST_RATES_BP = [0, 25, 150, 300, 500, 1200, 1800, 2800, 4000];
/** Rule 46: a bill to an unregistered customer above ₹50,000 must show the customer's address. */
export const RULE46_ADDRESS_THRESHOLD = 5000000;

export class GstError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'GstError';
    this.code = code;
  }
}

const isInt = Number.isSafeInteger;

/** Quantity with up to 3 decimals → thousandths, by string parsing (no float multiplication). */
export function toMilli(quantity) {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(quantity).trim());
  if (!match) throw new RangeError(`Invalid quantity: ${quantity}`);
  const milli = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
  if (!isInt(milli)) throw new RangeError(`Quantity out of range: ${quantity}`);
  return milli;
}

function validateSlabs(slabs) {
  if (!Array.isArray(slabs) || slabs.length === 0) throw new GstError('BAD_SLABS');
  let previous = -1;
  slabs.forEach((slab, i) => {
    const last = i === slabs.length - 1;
    if (!slab || !isInt(slab.rateBp) || slab.rateBp < 0) throw new GstError('BAD_SLABS');
    if (last) {
      if (slab.upToUnitPrice !== null) throw new GstError('BAD_SLABS');
    } else {
      if (!isInt(slab.upToUnitPrice) || slab.upToUnitPrice <= previous) throw new GstError('BAD_SLABS');
      previous = slab.upToUnitPrice;
    }
  });
}

/** Rate of the first slab whose per-unit ceiling covers the line (taxable ÷ quantity), by integer compare. */
export function selectSlabRate(gstSlabs, { taxable, qtyMilli }) {
  validateSlabs(gstSlabs);
  const value = BigInt(taxable) * 1000n;
  for (const slab of gstSlabs) {
    if (slab.upToUnitPrice === null || value <= BigInt(slab.upToUnitPrice) * BigInt(qtyMilli)) {
      return slab.rateBp;
    }
  }
  /* c8 ignore next */
  throw new GstError('BAD_SLABS');
}

export function placeOfSupply({ branchStateCode, customer }) {
  const registered = Boolean(customer?.gstin);
  const code = registered
    ? customer.gstin.slice(0, 2)
    : customer?.stateCode || branchStateCode;
  return { stateCode: code, stateName: stateName(code), interState: code !== branchStateCode, registered };
}

function taxHeads(taxable, rateBp, interState) {
  if (interState) return { cgst: 0, sgst: 0, igst: mulDivRound(taxable, rateBp, 10000) };
  const half = mulDivRound(taxable, rateBp, 20000);
  return { cgst: half, sgst: half, igst: 0 };
}

const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0);

export function computeInvoice({ lines, invoiceDiscount = 0, interState }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new GstError('NO_LINES');
  if (!isInt(invoiceDiscount) || invoiceDiscount < 0) throw new RangeError(`Invalid discount: ${invoiceDiscount}`);

  const base = lines.map((l) => {
    const qtyMilli = toMilli(l.quantity);
    if (qtyMilli <= 0) throw new RangeError('Quantity must be more than zero');
    if (!isInt(l.rate) || l.rate < 0) throw new RangeError(`Invalid rate: ${l.rate}`);
    const discount = l.discount ?? 0;
    if (!isInt(discount) || discount < 0) throw new RangeError(`Invalid discount: ${discount}`);
    const gross = mulDivRound(l.rate, qtyMilli, 1000);
    if (discount > gross) throw new GstError('DISCOUNT_EXCEEDS_LINE');
    return { input: l, qtyMilli, gross, discount };
  });

  const weights = base.map((b) => b.gross - b.discount);
  if (invoiceDiscount > weights.reduce((a, w) => a + w, 0)) throw new GstError('DISCOUNT_EXCEEDS_TOTAL');
  const shares = invoiceDiscount === 0 || weights.every((w) => w === 0)
    ? weights.map(() => 0)
    : allocateProRata(invoiceDiscount, weights);

  const out = base.map((b, i) => {
    const invoiceDiscountShare = shares[i];
    const taxable = b.gross - b.discount - invoiceDiscountShare;
    const rateBp = selectSlabRate(b.input.gstSlabs, { taxable, qtyMilli: b.qtyMilli });
    const heads = taxHeads(taxable, rateBp, interState);
    return {
      key: b.input.key,
      hsnSac: b.input.hsnSac,
      qtyMilli: b.qtyMilli,
      gross: b.gross,
      discount: b.discount,
      invoiceDiscountShare,
      taxable,
      rateBp,
      ...heads,
      total: taxable + heads.cgst + heads.sgst + heads.igst,
    };
  });

  const totals = totalsOf(out);
  totals.gross = sum(out, 'gross');
  totals.discount = sum(out, 'discount') + invoiceDiscount;

  const groups = new Map();
  for (const l of out) {
    const k = `${l.hsnSac ?? ''}|${l.rateBp}`;
    const g = groups.get(k) ?? { hsnSac: l.hsnSac, rateBp: l.rateBp, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    g.taxable += l.taxable;
    g.cgst += l.cgst;
    g.sgst += l.sgst;
    g.igst += l.igst;
    groups.set(k, g);
  }
  const taxSummary = [...groups.values()].sort(
    (a, b) => String(a.hsnSac ?? '').localeCompare(String(b.hsnSac ?? '')) || a.rateBp - b.rateBp,
  );

  return { lines: out, totals: orderTotals(totals), taxSummary };
}

function totalsOf(lines) {
  const taxable = sum(lines, 'taxable');
  const cgst = sum(lines, 'cgst');
  const sgst = sum(lines, 'sgst');
  const igst = sum(lines, 'igst');
  const tax = cgst + sgst + igst;
  const subtotal = taxable + tax;
  const { total, roundOff } = roundToRupee(subtotal);
  return { taxable, cgst, sgst, igst, tax, subtotal, roundOff, total };
}

function orderTotals(t) {
  const { gross, discount, taxable, cgst, sgst, igst, tax, subtotal, roundOff, total } = t;
  return { gross, discount, taxable, cgst, sgst, igst, tax, subtotal, roundOff, total };
}

/** Tax backed out of a tax-inclusive advance. Every part sums exactly to its gross. */
export function computeAdvanceTax({ amount, parts, interState }) {
  if (!isInt(amount) || amount < 0) throw new RangeError(`Invalid advance amount: ${amount}`);
  const grosses = allocateProRata(amount, parts.map((p) => p.weight));
  const lines = parts.map((p, i) => {
    const gross = grosses[i];
    const t = mulDivRound(gross, 10000, 10000 + p.rateBp);
    const heads = taxHeads(t, p.rateBp, interState);
    return {
      rateBp: p.rateBp,
      gross,
      taxable: gross - heads.cgst - heads.sgst - heads.igst,
      ...heads,
    };
  });
  const cgst = sum(lines, 'cgst');
  const sgst = sum(lines, 'sgst');
  const igst = sum(lines, 'igst');
  return {
    lines,
    gross: sum(lines, 'gross'),
    taxable: sum(lines, 'taxable'),
    cgst,
    sgst,
    igst,
    tax: cgst + sgst + igst,
  };
}

/** The share `part ÷ whole` of a document's figures; the whole returns the figures exactly. */
export function proportionalTax({ part, whole, of }) {
  if (!isInt(part) || !isInt(whole) || part < 0 || whole <= 0 || part > whole) {
    throw new RangeError(`Invalid part ${part} of ${whole}`);
  }
  if (part === whole) {
    const { gross, taxable, cgst, sgst, igst } = of;
    return { gross, taxable, cgst, sgst, igst };
  }
  const gross = mulDivRound(of.gross, part, whole);
  const cgst = mulDivRound(of.cgst, part, whole);
  const sgst = mulDivRound(of.sgst, part, whole);
  const igst = mulDivRound(of.igst, part, whole);
  return { gross, taxable: gross - cgst - sgst - igst, cgst, sgst, igst };
}

/**
 * Credit note figures. `full` copies every original line (and so the original round-off, which is a
 * pure function of those lines); partial taxes each credited amount at the line's original rate.
 */
export function computeCreditNote({ originalLines, credits, creditedSoFar = {}, interState, full }) {
  if (full) {
    if (Object.values(creditedSoFar).some((v) => v > 0)) throw new GstError('CREDIT_EXCEEDS_LINE');
    const lines = originalLines.map((l) => ({ ...l }));
    return { lines, totals: totalsOf(lines) };
  }
  if (!Array.isArray(credits) || credits.length === 0) throw new GstError('NO_LINES');
  const seen = new Set();
  const lines = credits.map((c) => {
    if (seen.has(c.key)) throw new GstError('CREDIT_EXCEEDS_LINE', `Line credited twice: ${c.key}`);
    seen.add(c.key);
    const original = originalLines.find((l) => l.key === c.key);
    if (!original) throw new GstError('CREDIT_EXCEEDS_LINE', `Unknown line: ${c.key}`);
    if (!isInt(c.taxable) || c.taxable <= 0) throw new RangeError(`Invalid credit: ${c.taxable}`);
    if (c.taxable > original.taxable - (creditedSoFar[c.key] ?? 0)) throw new GstError('CREDIT_EXCEEDS_LINE');
    const heads = taxHeads(c.taxable, original.rateBp, interState);
    return {
      key: c.key,
      hsnSac: original.hsnSac,
      taxable: c.taxable,
      rateBp: original.rateBp,
      ...heads,
      total: c.taxable + heads.cgst + heads.sgst + heads.igst,
    };
  });
  return { lines, totals: totalsOf(lines) };
}

/** 30 November after the end of the invoice's financial year. */
export function correctionDeadline(invoiceDateYmd) {
  const { startYear } = financialYear(istDayBounds(invoiceDateYmd).start);
  return `${startYear + 1}-11-30`;
}
