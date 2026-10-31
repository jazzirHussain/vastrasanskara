import { istDayBounds } from './fy.js';

export const DOC_TYPES = ['invoice', 'credit_note', 'receipt', 'receipt_voucher', 'refund'];
export const PREFIX_FIELD = {
  invoice: 'invoice',
  credit_note: 'creditNote',
  receipt: 'receipt',
  receipt_voucher: 'receiptVoucher',
  refund: 'refund',
};
export const MAX_DOC_NUMBER_LENGTH = 16;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'INV', '2627', 1 → 'INV/2627/0001'. Longer than 16 characters is refused (GST limit). */
export function formatDocumentNumber(prefix, fyCode, n) {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`Invalid document sequence: ${n}`);
  const number = `${prefix}/${fyCode}/${String(n).padStart(4, '0')}`;
  if (number.length > MAX_DOC_NUMBER_LENGTH) {
    throw new RangeError(`Document number longer than ${MAX_DOC_NUMBER_LENGTH} characters`);
  }
  return number;
}

/** Whole calendar days from one 'YYYY-MM-DD' to another (negative when `to` is earlier). */
export function daysBetween(fromYmd, toYmd) {
  return Math.round((istDayBounds(toYmd).start - istDayBounds(fromYmd).start) / DAY_MS);
}

export function payStatus({ total, balance }) {
  if (balance <= 0) return 'paid';
  if (balance >= total) return 'unpaid';
  return 'part_paid';
}

/** Overdue reminder number: 1 the day after due, then every 7 days, 4 at most; else null. */
export function reminderSequence(dueDate, today) {
  const d = daysBetween(dueDate, today);
  if (d < 1) return null;
  const n = 1 + Math.floor((d - 1) / 7);
  return n <= 4 ? n : null;
}

export function ageingBucket(dueDate, today) {
  const d = daysBetween(dueDate, today);
  if (d <= 0) return 'not_due';
  if (d <= 30) return 'd0_30';
  if (d <= 60) return 'd31_60';
  if (d <= 90) return 'd61_90';
  return 'd90_plus';
}
