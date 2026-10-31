// Pure expense rules: GST split, tax checks, cost value, numbers and default categories. Paise throughout.
import { computeAdvanceTax, placeOfSupply, taxHeads } from './gst.js';

export const EXPENSE_LINK_KINDS = ['garment', 'batch', 'order'];
export const MAX_EXPENSE_ATTACHMENTS = 5;
/** A typed tax head may differ from the rate's figure by this much (a bill rounded per line). */
export const GST_TOLERANCE_PAISE = 100;

export const DEFAULT_EXPENSE_CATEGORIES = Object.freeze(
  [
    ['rent', 'Rent'],
    ['electricity', 'Electricity'],
    ['salaries', 'Salaries and wages'],
    ['material_purchase', 'Materials and fabric'],
    ['vendor_work', 'Outside workshops'],
    ['courier', 'Courier and delivery'],
    ['transport', 'Travel and transport'],
    ['repairs', 'Repairs and maintenance'],
    ['phone_internet', 'Phone and internet'],
    ['marketing', 'Marketing'],
    ['packaging', 'Packaging'],
    ['staff_welfare', 'Tea, food and staff'],
    ['professional_fees', 'Accountant and professional fees'],
    ['bank_charges', 'Bank and card charges'],
    ['other', 'Other'],
  ].map(([key, label]) => Object.freeze({ key, label, active: true })),
);

/** 'EXP/2627/0001'. Internal series, so there is no length cap. */
export function formatExpenseNumber(prefix, fyCode, n) {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`Invalid expense number: ${n}`);
  return `${prefix}/${fyCode}/${String(n).padStart(4, '0')}`;
}

/** Back the tax out of the total paid. `taxable + tax === total` always. */
export function splitGstFromTotal({ total, rateBp, interState }) {
  const r = computeAdvanceTax({ amount: total, parts: [{ weight: 1, rateBp }], interState });
  return { taxable: r.taxable, cgst: r.cgst, sgst: r.sgst, igst: r.igst, tax: r.tax };
}

/** Tax on a before-GST amount. */
export function taxOnTaxable({ taxable, rateBp, interState }) {
  const heads = taxHeads(taxable, rateBp, interState);
  const tax = heads.cgst + heads.sgst + heads.igst;
  return { ...heads, tax, total: taxable + tax };
}

/** Problems with a bill's tax figures, as [{ path, message }]; none when there is no GST bill. */
export function checkExpenseTax({ total, gst }) {
  if (!gst) return [];
  const issues = [];
  if (gst.taxable + gst.cgst + gst.sgst + gst.igst !== total) {
    issues.push({ path: 'gst.taxable', message: 'Before-GST amount and tax must add up to the total' });
  }
  if (gst.igst > 0 && (gst.cgst > 0 || gst.sgst > 0)) {
    issues.push({ path: 'gst.igst', message: 'A bill has CGST and SGST, or IGST, not both' });
  }
  if (gst.cgst !== gst.sgst) {
    issues.push({ path: 'gst.sgst', message: 'CGST and SGST must be equal' });
  }
  if (gst.rateBp !== null && gst.rateBp !== undefined) {
    const expected = taxHeads(gst.taxable, gst.rateBp, gst.igst > 0);
    for (const head of ['cgst', 'sgst', 'igst']) {
      if (Math.abs(gst[head] - expected[head]) > GST_TOLERANCE_PAISE) {
        issues.push({ path: `gst.${head}`, message: 'This tax does not match the rate. Check the bill.' });
      }
    }
  }
  return issues;
}

/** Whether a bill from this payee defaults to IGST (payee GSTIN state, else payee state, else the branch's). */
export function payeeInterState({ branchStateCode, payee }) {
  return placeOfSupply({ branchStateCode, customer: payee }).interState;
}

/** What the expense adds to a garment's cost: the before-GST amount, plus GST that cannot be claimed back. */
export function expenseCost(expense) {
  if (expense.status === 'voided') return 0;
  const { gst } = expense;
  if (!gst) return expense.total;
  return gst.taxable + (gst.itcEligible ? 0 : gst.cgst + gst.sgst + gst.igst);
}
