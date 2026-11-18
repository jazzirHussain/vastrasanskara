// The daily billing checks: overdue reminders to clients and one digest to operations (from
// 10:00 IST), and the owner's collections summary (from the branch's closing time). Run every
// 15 minutes by the worker; the outbox dedupe keys (per bill and reminder number, per day)
// keep every message to once however often it runs.
import { daysBetween, reminderSequence } from '@vs/shared/billing.js';
import { displayDate, istDate, istTime } from '@vs/shared/fy.js';
import { formatINR } from '@vs/shared/money.js';
import { clock } from '../../clock.js';
import { withTransaction } from '../../core/db.js';
import { emit } from '../../core/notify/emit.js';
import { listBranchIds } from '../branches/service.js';
import { getCustomerNames } from '../customers/service.js';
import { readSettings } from '../settings/service.js';
import { Invoice, Receipt, Refund } from './model.js';
import './notifications.js';

const REMINDERS_FROM = '10:00';
const MODE_LABELS = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer' };
const modeLabel = (mode) => MODE_LABELS[mode] ?? mode;
const sum = (rows) => rows.reduce((total, r) => total + r.amount, 0);

async function overdueReminders(branchId, day) {
  const send = (event, args) => withTransaction((session) => emit(event, { branchId, ...args }, { session }));
  const overdue = await Invoice.find({
    branchId,
    type: 'invoice',
    status: 'issued',
    'settlement.balance': { $gt: 0 },
    dueDate: { $lt: day },
  })
    .sort({ dueDate: 1, _id: 1 })
    .lean();
  if (!overdue.length) return 0;

  const names = await getCustomerNames(branchId, [...new Set(overdue.map((b) => String(b.customerId)))]);
  let queued = 0;
  for (const bill of overdue.filter((b) => !b.remindersPaused)) {
    const sequence = reminderSequence(bill.dueDate, day);
    if (sequence === null) continue;
    queued += await send('invoice.overdue', {
      refId: String(bill._id),
      sequence,
      data: { customerId: bill.customerId },
      vars: {
        customerName: names.get(String(bill.customerId)) ?? 'there',
        invoiceNo: bill.number,
        balance: formatINR(bill.settlement.balance),
        dueDate: displayDate(bill.dueDate),
        days: daysBetween(bill.dueDate, day),
      },
    });
  }

  // Operations get one digest a day (paused bills are still overdue, so they are listed).
  const list = overdue
    .map((b) => `${b.number} ${names.get(String(b.customerId)) ?? ''}, ${formatINR(b.settlement.balance)}, ${daysBetween(b.dueDate, day)} days overdue`)
    .join('\n');
  queued += await send('invoice.overdue_digest', {
    refId: `overdue:${day}`,
    vars: {
      count: overdue.length,
      total: formatINR(overdue.reduce((t, b) => t + b.settlement.balance, 0)),
      list,
      link: '/bills?tab=owed&bucket=overdue',
    },
  });
  return queued;
}

/** Payments received on `day` (opening advances were not received that day and are left out). */
export const dayCollectionsFilter = (branchId, day) => ({ branchId, type: 'receipt', status: 'issued', date: day, opening: { $ne: true } });

async function collectionsSummary(branchId, day) {
  const [receipts, refunds] = await Promise.all([
    Receipt.find(dayCollectionsFilter(branchId, day)).lean(),
    Refund.find({ branchId, type: 'refund', status: 'issued', date: day }).lean(),
  ]);
  const modes = Map.groupBy(receipts, (r) => r.mode);
  const byMode = receipts.length
    ? [...modes].map(([mode, rows]) => `${modeLabel(mode)}: ${formatINR(sum(rows))} (${rows.length})`).join('\n')
    : 'No payments today';
  const refundText = refunds.length
    ? refunds.map((r) => `${formatINR(r.amount)} by ${modeLabel(r.mode).toLowerCase()}`).join('\n')
    : 'None';
  return withTransaction((session) =>
    emit(
      'billing.collections_summary',
      {
        branchId,
        refId: `collections:${day}`,
        vars: {
          day: displayDate(day),
          total: formatINR(sum(receipts)),
          count: receipts.length,
          byMode,
          refunds: refundText,
          link: '/bills?tab=payments',
        },
      },
      { session },
    ),
  );
}

/** Runs the checks whose IST time has come for every branch. Returns { branches, queued }. */
export async function runDailyBillingChecks({ now = clock.now() } = {}) {
  const day = istDate(now);
  const time = istTime(now);
  let branches = 0;
  let queued = 0;
  for (const branchId of await listBranchIds()) {
    const settings = await readSettings(branchId);
    const remind = time >= REMINDERS_FROM;
    const summarise = time >= settings.closingTime;
    if (!remind && !summarise) continue;
    branches += 1;
    if (remind) queued += await overdueReminders(branchId, day);
    if (summarise) queued += await collectionsSummary(branchId, day);
  }
  return { branches, queued };
}
