// GSTR-3B summary and the ITC set-off (Decision 15). Pure; all values are integer paise.
import { gstPlace, reversalParts } from './gstr1.js';

const HEADS = ['igst', 'cgst', 'sgst'];

function heads(obj) {
  return { igst: obj.igst, cgst: obj.cgst, sgst: obj.sgst };
}

/**
 * Sets input tax credit off against output tax. IGST credit goes first (IGST, then CGST, then SGST);
 * CGST credit then pays CGST, then IGST; SGST credit pays SGST, then IGST. CGST credit never pays
 * SGST and vice versa. Negative liability (credit notes above sales) is treated as zero.
 */
export function gstSetOff({ liability, credit }) {
  const due = Object.fromEntries(HEADS.map((h) => [h, Math.max(0, liability[h] ?? 0)]));
  const left = Object.fromEntries(HEADS.map((h) => [h, Math.max(0, credit[h] ?? 0)]));
  const creditUsed = { igst: { igst: 0, cgst: 0, sgst: 0 }, cgst: { cgst: 0, igst: 0 }, sgst: { sgst: 0, igst: 0 } };

  const use = (from, to) => {
    const n = Math.min(left[from], due[to]);
    left[from] -= n;
    due[to] -= n;
    creditUsed[from][to] += n;
  };

  use('igst', 'igst');
  use('igst', 'cgst');
  use('igst', 'sgst');
  use('cgst', 'cgst');
  use('cgst', 'igst');
  use('sgst', 'sgst');
  use('sgst', 'igst');

  return { creditUsed, cash: { ...due }, carriedForward: { ...left } };
}

/**
 * The GSTR-3B figures from issued billing document views and M5's `inputTaxSummary`.
 * Outward (3.1a) = taxed invoice lines − credit notes + receipt voucher advances − advances adjusted
 * on invoices − advances refunded. Zero-rated lines go to nil-rated (3.1c). 3.2 lists taxed
 * inter-state supplies to unregistered persons per place of supply, net of credit notes.
 */
export function gstr3bSummary({ docs, itc }) {
  const outward = { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
  const nilRated = { taxable: 0 };
  const interState = new Map();

  const add = (part, sign) => {
    if (part.gstRateBp === 0) {
      nilRated.taxable += sign * part.taxable;
      return;
    }
    outward.taxable += sign * part.taxable;
    for (const h of HEADS) outward[h] += sign * part[h];
  };
  const addInterState = (stateCode, line, sign) => {
    if (line.gstRateBp === 0) return;
    const r = interState.get(stateCode) ?? { stateCode, taxable: 0, igst: 0 };
    r.taxable += sign * line.taxable;
    r.igst += sign * line.igst;
    interState.set(stateCode, r);
  };

  for (const d of docs) {
    if (d.status !== 'issued') continue;
    if (d.type === 'invoice') {
      for (const l of d.lines) add(l, 1);
      for (const a of d.advanceAdjustments ?? []) add(a, -1);
      if (d.placeOfSupply?.interState && !d.customer.registered) {
        for (const l of d.lines) addInterState(d.placeOfSupply.stateCode, l, 1);
      }
    } else if (d.type === 'credit_note') {
      for (const l of d.lines) add(l, -1);
      if (d.original.interState && !d.original.registered) {
        for (const l of d.lines) addInterState(d.placeOfSupply.stateCode, l, -1);
      }
    } else if (d.type === 'receipt_voucher') {
      for (const l of d.lines) add(l, 1);
    } else if (d.type === 'refund') {
      for (const r of reversalParts(d)) add(r, -1);
    }
  }

  const interStateUnregistered = [...interState.values()]
    .sort((a, b) => (a.stateCode < b.stateCode ? -1 : a.stateCode > b.stateCode ? 1 : 0))
    .map((r) => ({ placeOfSupply: gstPlace(r.stateCode), taxable: r.taxable, igst: r.igst }));

  const credit = heads(itc.itc);
  return {
    outward,
    nilRated,
    interStateUnregistered,
    itc: credit,
    ineligible: heads(itc.ineligible),
    setOff: gstSetOff({ liability: heads(outward), credit }),
  };
}
