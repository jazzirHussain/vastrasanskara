// GST report builders: the GSTR-1 workbook (offline tool layout) and the GSTR-3B summary. Both go
// by document date (IST), so a locked month always gives the same rows.
import { gstr1Sheets } from '@vs/shared/reports/gstr1.js';
import { gstr3bSummary } from '@vs/shared/reports/gstr3b.js';
import { monthName } from '@vs/shared/reports/catalog.js';
import { addDaysYmd } from '@vs/shared/fy.js';
import { billingDocumentsInRange, documentSeries } from '../../billing/service.js';
import { getBranch } from '../../branches/service.js';
import { inputTaxSummary } from '../../expenses/service.js';
import { readSettings } from '../../settings/service.js';
import { REPORT_MAX_ROWS, checkRowLimit } from '../writers.js';
import { registerBuilder } from './index.js';

const GST_TYPES = ['invoice', 'credit_note', 'receipt_voucher', 'refund'];

/** First and last day of 'YYYY-MM'. */
export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from: `${month}-01`, to: addDaysYmd(next, -1) };
}

/** The month's GST documents (issued and cancelled) as views, and its document series. */
export async function gstMonthDocs(branchId, month, { maxRows = REPORT_MAX_ROWS } = {}) {
  const range = monthRange(month);
  const docs = [];
  for await (const view of billingDocumentsInRange(branchId, { types: GST_TYPES, ...range })) {
    docs.push(view);
    checkRowLimit(docs.length, maxRows);
  }
  return { docs, series: await documentSeries(branchId, range) };
}

registerBuilder('gstr1', async (branchId, { month }, { maxRows }) => {
  const [{ docs, series }, settings] = await Promise.all([gstMonthDocs(branchId, month, { maxRows }), readSettings(branchId)]);
  const { sheets } = gstr1Sheets({ docs, series, b2clThreshold: settings.b2clThreshold, month });
  return { files: [{ sheets }] };
});

const money = (key, label) => ({ key, label, kind: 'money' });
export const GSTR3B_COLUMNS = Object.freeze([
  { key: 'section', label: 'Table', kind: 'text' },
  { key: 'description', label: 'Details', kind: 'text' },
  money('taxable', 'Taxable value'),
  money('igst', 'Integrated tax'),
  money('cgst', 'Central tax'),
  money('sgst', 'State/UT tax'),
]);

/** The GSTR-3B summary rows: 3.1(a), 3.1(c), 3.2 per state, 4(A)(5), ITC not claimable, then what is left to pay. */
export function gstr3bRows(summary, { gstin, month }) {
  const heads = (h) => ({ igst: h.igst, cgst: h.cgst, sgst: h.sgst });
  return [
    { section: '', description: `GSTR-3B for ${monthName(month)} · GSTIN ${gstin ?? ''}` },
    { section: '3.1(a)', description: 'Outward taxable supplies', taxable: summary.outward.taxable, ...heads(summary.outward) },
    { section: '3.1(c)', description: 'Nil-rated and exempt supplies', taxable: summary.nilRated.taxable },
    ...summary.interStateUnregistered.map((s) => ({
      section: '3.2', description: `Supplies to unregistered persons in ${s.placeOfSupply}`, taxable: s.taxable, igst: s.igst,
    })),
    { section: '4(A)(5)', description: 'Input tax credit (all other ITC)', ...heads(summary.itc) },
    { section: '4(D)', description: 'ITC not claimable (information)', ...heads(summary.ineligible) },
    { section: '', description: 'Tax to pay in cash', ...heads(summary.setOff.cash) },
    { section: '', description: 'Credit carried forward', ...heads(summary.setOff.carriedForward) },
    { section: '', description: 'Estimate. Your accountant confirms before filing.' },
  ];
}

registerBuilder('gstr3b', async (branchId, { month }, { maxRows }) => {
  const [{ docs }, itc, branch] = await Promise.all([
    gstMonthDocs(branchId, month, { maxRows }),
    inputTaxSummary(branchId, monthRange(month)),
    getBranch(branchId),
  ]);
  const rows = gstr3bRows(gstr3bSummary({ docs, itc }), { gstin: branch.gstin, month });
  return { files: [{ sheets: [{ name: 'GSTR-3B summary', columns: GSTR3B_COLUMNS, rows }] }] };
});
