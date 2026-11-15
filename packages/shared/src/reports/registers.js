// Register row builders over billing document views, with plain column labels. Pure.
import { PAYMENT_MODES } from '../schemas/billing.js';
import { gstPlace } from './gstr1.js';

const col = (key, label, kind = 'text') => ({ key, label, kind });

const TAX_COLUMNS = [
  col('taxable', 'Taxable value', 'money'),
  col('cgst', 'CGST', 'money'),
  col('sgst', 'SGST', 'money'),
  col('igst', 'IGST', 'money'),
];

/** Register name → column descriptors; each builder's row keys follow its columns in order. */
export const REGISTER_COLUMNS = Object.freeze({
  sales: [
    col('number', 'Bill number'),
    col('date', 'Date', 'date'),
    col('customer', 'Customer'),
    col('gstin', 'GSTIN'),
    col('placeOfSupply', 'Place of supply'),
    ...TAX_COLUMNS,
    col('roundOff', 'Round-off', 'money'),
    col('total', 'Total', 'money'),
    col('status', 'Status'),
  ],
  creditNotes: [
    col('number', 'Credit note number'),
    col('date', 'Date', 'date'),
    col('originalNumber', 'Against bill'),
    col('originalDate', 'Bill date', 'date'),
    col('customer', 'Customer'),
    col('gstin', 'GSTIN'),
    col('placeOfSupply', 'Place of supply'),
    ...TAX_COLUMNS,
    col('roundOff', 'Round-off', 'money'),
    col('total', 'Total', 'money'),
    col('status', 'Status'),
  ],
  receiptVouchers: [
    col('number', 'Voucher number'),
    col('date', 'Date', 'date'),
    col('customer', 'Customer'),
    col('placeOfSupply', 'Place of supply'),
    col('amount', 'Advance received', 'money'),
    ...TAX_COLUMNS,
    col('status', 'Status'),
  ],
  refunds: [
    col('number', 'Refund number'),
    col('date', 'Date', 'date'),
    col('customer', 'Customer'),
    col('mode', 'Mode'),
    col('amount', 'Amount refunded', 'money'),
    ...TAX_COLUMNS,
    col('status', 'Status'),
  ],
  collections: [
    col('date', 'Date', 'date'),
    col('mode', 'Mode'),
    col('receipts', 'Received', 'money'),
    col('refunds', 'Refunded', 'money'),
    col('net', 'Net', 'money'),
  ],
  dayBook: [
    col('date', 'Date', 'date'),
    col('kind', 'Type'),
    col('number', 'Number'),
    col('party', 'Party'),
    col('in', 'Money in', 'money'),
    col('out', 'Money out', 'money'),
  ],
});

const MODE_LABELS = Object.freeze({ cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer' });
const modeLabel = (mode) => MODE_LABELS[mode] ?? String(mode ?? '');

const byNumber = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const byDateNumber = (a, b) => (a.date === b.date ? byNumber(a.number, b.number) : a.date < b.date ? -1 : 1);
const statusLabel = (v) => (v.status === 'cancelled' ? 'Cancelled' : 'Issued');
const place = (v) => (v.placeOfSupply ? gstPlace(v.placeOfSupply.stateCode) : '');

/** Totals, or zeros for a cancelled document (cancelled rows stay in the register at zero value). */
function figures(v) {
  const t = v.status === 'cancelled' || !v.totals ? null : v.totals;
  return {
    taxable: t?.taxable ?? 0,
    cgst: t?.cgst ?? 0,
    sgst: t?.sgst ?? 0,
    igst: t?.igst ?? 0,
    roundOff: t?.roundOff ?? 0,
    total: t?.total ?? 0,
  };
}

const ofType = (views, type) => views.filter((v) => v.type === type).sort(byDateNumber);

/** One row per bill, by date then number. */
export function salesRegisterRows(views) {
  return ofType(views, 'invoice').map((v) => {
    const f = figures(v);
    return {
      number: v.number, date: v.date, customer: v.customer.name, gstin: v.customer.gstin ?? '', placeOfSupply: place(v),
      taxable: f.taxable, cgst: f.cgst, sgst: f.sgst, igst: f.igst, roundOff: f.roundOff, total: f.total, status: statusLabel(v),
    };
  });
}

/** One row per credit note, with the bill it is against. */
export function creditNoteRows(views) {
  return ofType(views, 'credit_note').map((v) => {
    const f = figures(v);
    return {
      number: v.number, date: v.date, originalNumber: v.original?.number ?? '', originalDate: v.original?.date ?? '',
      customer: v.customer.name, gstin: v.customer.gstin ?? '', placeOfSupply: place(v),
      taxable: f.taxable, cgst: f.cgst, sgst: f.sgst, igst: f.igst, roundOff: f.roundOff, total: f.total, status: statusLabel(v),
    };
  });
}

/** One row per receipt voucher (`type` 'receipt_voucher') or refund (`type` 'refund'). */
export function voucherRows(views, type) {
  if (type === 'receipt_voucher') {
    return ofType(views, type).map((v) => {
      const f = figures(v);
      return {
        number: v.number, date: v.date, customer: v.customer.name, placeOfSupply: place(v), amount: f.total,
        taxable: f.taxable, cgst: f.cgst, sgst: f.sgst, igst: f.igst, status: statusLabel(v),
      };
    });
  }
  if (type === 'refund') {
    return ofType(views, type).map((v) => {
      const live = v.status !== 'cancelled';
      const r = live ? v.rvReversal : null;
      return {
        number: v.number, date: v.date, customer: v.customer.name, mode: modeLabel(v.mode), amount: live ? v.amount : 0,
        taxable: r?.taxable ?? 0, cgst: r?.cgst ?? 0, sgst: r?.sgst ?? 0, igst: r?.igst ?? 0, status: statusLabel(v),
      };
    });
  }
  throw new RangeError(`No voucher register for type: ${type}`);
}

/** Issued receipts and refunds summed per date × mode, with the net; by date, then mode order. */
export function collectionsByMode(views) {
  const m = new Map();
  for (const v of views) {
    if (v.status !== 'issued' || (v.type !== 'receipt' && v.type !== 'refund')) continue;
    const key = `${v.date}|${v.mode}`;
    const r = m.get(key) ?? { date: v.date, modeKey: v.mode, receipts: 0, refunds: 0 };
    if (v.type === 'receipt') r.receipts += v.amount;
    else r.refunds += v.amount;
    m.set(key, r);
  }
  const rank = (mode) => {
    const i = PAYMENT_MODES.indexOf(mode);
    return i === -1 ? PAYMENT_MODES.length : i;
  };
  return [...m.values()]
    .sort((a, b) => (a.date === b.date ? rank(a.modeKey) - rank(b.modeKey) : a.date < b.date ? -1 : 1))
    .map((r) => ({ date: r.date, mode: modeLabel(r.modeKey), receipts: r.receipts, refunds: r.refunds, net: r.receipts - r.refunds }));
}

const DAY_BOOK_KINDS = ['Bill', 'Credit note', 'Payment', 'Refund', 'Expense'];

/**
 * Money in and out by date: bills and payments in, credit notes, refunds and expenses out.
 * Receipt vouchers are tax documents for a payment already listed, so they are left out;
 * cancelled documents and voided expenses are skipped.
 */
export function dayBookRows({ billing, expenses }) {
  const rows = [];
  for (const v of billing) {
    if (v.status !== 'issued') continue;
    const party = v.customer?.name ?? '';
    if (v.type === 'invoice') rows.push({ date: v.date, kind: 'Bill', number: v.number, party, in: v.totals.total, out: 0 });
    else if (v.type === 'receipt') rows.push({ date: v.date, kind: 'Payment', number: v.number, party, in: v.amount, out: 0 });
    else if (v.type === 'credit_note') rows.push({ date: v.date, kind: 'Credit note', number: v.number, party, in: 0, out: v.totals.total });
    else if (v.type === 'refund') rows.push({ date: v.date, kind: 'Refund', number: v.number, party, in: 0, out: v.amount });
  }
  for (const e of expenses) {
    if (e.status !== 'active') continue;
    rows.push({ date: e.date, kind: 'Expense', number: e.number, party: e.payee?.name ?? '', in: 0, out: e.total });
  }
  return rows.sort(
    (a, b) =>
      (a.date === b.date ? 0 : a.date < b.date ? -1 : 1) ||
      DAY_BOOK_KINDS.indexOf(a.kind) - DAY_BOOK_KINDS.indexOf(b.kind) ||
      byNumber(a.number, b.number),
  );
}
