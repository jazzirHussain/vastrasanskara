// The reports the admin can ask for: their plain names, groups, parameters and file formats.
import { daysBetween } from '../billing.js';

const report = (kind, label, group, params, formats, sheets) =>
  Object.freeze({ kind, label, group, params, formats: Object.freeze(formats), ...(sheets ? { sheets } : {}) });

const SHEET = ['xlsx', 'csv'];

/** Multi-sheet kinds (`sheets: 'multi'`) are Excel only: a CSV file holds one table. */
export const REPORTS = Object.freeze([
  report('gstr1', 'GST return file (GSTR-1)', 'GST', 'month', ['xlsx'], 'multi'),
  report('gstr3b', 'GST summary (GSTR-3B)', 'GST', 'month', SHEET),
  report('gst_pack', 'All GST files for a month', 'GST', 'month', ['xlsx'], 'multi'),
  report('sales_register', 'Sales register', 'Registers', 'range', SHEET),
  report('credit_note_register', 'Credit note register', 'Registers', 'range', SHEET),
  report('receipt_voucher_register', 'Receipt voucher register', 'Registers', 'range', SHEET),
  report('refund_register', 'Refund register', 'Registers', 'range', SHEET),
  report('collections_by_mode', 'Collections by payment mode', 'Registers', 'range', SHEET),
  report('advances_held', 'Advances held', 'Registers', 'none', SHEET),
  report('expense_register', 'Expenses by category with GST', 'Registers', 'range', ['xlsx'], 'multi'),
  report('stock_movements', 'Stock movements', 'Registers', 'range', SHEET),
  report('stock_valuation', 'Stock valuation', 'Registers', 'none', SHEET),
  report('customer_statement', 'Customer statement', 'Ledgers', 'customer', ['pdf', 'xlsx']),
  report('receivables_ageing', 'Who owes what', 'Ledgers', 'none', SHEET),
  report('day_book', 'Day book', 'Ledgers', 'range', SHEET),
  report('order_profitability', 'Profit by order', 'Business', 'range', SHEET),
  report('on_time', 'On time by designer and vendor', 'Business', 'range', ['xlsx'], 'multi'),
  report('enquiry_conversion', 'Enquiries that became orders', 'Business', 'range', SHEET),
  report('stock_item_profit', 'Profit by stock item', 'Business', 'range', SHEET),
]);

const BY_KIND = new Map(REPORTS.map((r) => [r.kind, r]));
export const reportByKind = (kind) => BY_KIND.get(kind);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const monthName = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** Light reports (a month, a range of up to 31 days, one customer, or none) may run at once. */
export function isLight({ kind, params }) {
  const def = BY_KIND.get(kind);
  if (!def) throw new RangeError(`Unknown report: ${kind}`);
  if (def.params === 'range') return daysBetween(params.from, params.to) + 1 <= 31;
  return true;
}

const FILE_NAMES = { gstr1: 'GSTR-1', gstr3b: 'GSTR-3B', gst_pack: 'GST files', customer_statement: 'Statement' };
const cleanName = (name) =>
  String(name ?? '').replace(/[\\/:*?"<>|]/g, '').replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim();

/** 'GSTR-1 October 2026.xlsx', 'Sales register 2026-04-01 to 2026-04-30.xlsx'. */
export function reportFilename({ kind, params, format }, { customerName } = {}) {
  const def = BY_KIND.get(kind);
  if (!def) throw new RangeError(`Unknown report: ${kind}`);
  const parts = [FILE_NAMES[kind] ?? def.label];
  if (def.params === 'customer') parts.push(cleanName(customerName));
  if (def.params === 'month') parts.push(monthName(params.month));
  if (def.params === 'range' || def.params === 'customer') parts.push(`${params.from} to ${params.to}`);
  return `${parts.filter(Boolean).join(' ')}.${format}`;
}

