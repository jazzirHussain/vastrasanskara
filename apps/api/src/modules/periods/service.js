import { financialYear, periodOf } from '@vs/shared';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule } from '../../core/errors.js';
import { PeriodLock } from './model.js';

const AUDITED = ['month', 'locked', 'note'];
const auditView = (doc) => Object.fromEntries(AUDITED.map((f) => [f, doc[f]]));

/**
 * Throws 422 PERIOD_LOCKED when the month of `ymd` is locked. Must run inside a transaction.
 * For a past month it then bumps the month's guard, so a lock taken meanwhile conflicts with
 * this write: the driver retries the write, which now sees the lock and refuses.
 */
export async function assertPeriodOpen(branchId, ymd, session) {
  if (!session?.inTransaction()) throw new Error('assertPeriodOpen must be called inside a transaction');
  const month = ymd.slice(0, 7);
  // The read comes first: it fixes the transaction snapshot before any lock can commit.
  const lock = await PeriodLock.findOne({ branchId, month }, { locked: 1 }).session(session).lean();
  if (lock?.locked) throw businessRule('PERIOD_LOCKED', 'This month is locked for filing', { month });
  if (month < periodOf(clock.now())) {
    await PeriodLock.updateOne(
      { branchId, month },
      { $inc: { guardSeq: 1 }, $setOnInsert: { branchId, month } },
      { upsert: true, session },
    );
  }
}

/** Whether the month is locked. */
export async function isPeriodLocked(branchId, month, session) {
  const lock = await PeriodLock.findOne({ branchId, month }, { locked: 1 }).session(session ?? null).lean();
  return Boolean(lock?.locked);
}

/** Locks a finished month. */
export function lockPeriod(branchId, month, { note = '' }, actor) {
  return withTransaction(async (session) => {
    const now = clock.now();
    if (month >= periodOf(now)) {
      throw businessRule('PERIOD_NOT_ENDED', 'A month can be locked only after it has ended', { month });
    }
    const current = await PeriodLock.findOne({ branchId, month }).session(session).lean();
    if (current?.locked) throw businessRule('ALREADY_LOCKED', 'This month is already locked', { month });
    const doc = await PeriodLock.findOneAndUpdate(
      { branchId, month },
      {
        $set: { locked: true, lockedBy: actor.userId, lockedAt: now, note, updatedBy: actor.userId },
        $push: { history: { action: 'lock', note, reason: '', by: actor.userId, at: now } },
        $inc: { guardSeq: 1 },
        $setOnInsert: { branchId, month, createdBy: actor.userId },
      },
      { upsert: true, new: true, session },
    ).lean();
    await recordAudit(
      {
        branchId,
        entityType: 'period_lock',
        entityId: doc._id,
        action: 'lock',
        before: auditView(current ?? { month, locked: false, note: '' }),
        after: auditView(doc),
        actor,
      },
      session,
    );
    return doc;
  });
}

/** Unlocks a locked month; the reason is kept in the history and the audit trail. */
export function unlockPeriod(branchId, month, { reason }, actor) {
  return withTransaction(async (session) => {
    const current = await PeriodLock.findOne({ branchId, month }).session(session).lean();
    if (!current?.locked) throw businessRule('NOT_LOCKED', 'This month is not locked', { month });
    const doc = await PeriodLock.findOneAndUpdate(
      { _id: current._id },
      {
        $set: { locked: false, lockedBy: null, lockedAt: null, note: '', updatedBy: actor.userId },
        $push: { history: { action: 'unlock', note: current.note, reason, by: actor.userId, at: clock.now() } },
        $inc: { guardSeq: 1 },
      },
      { new: true, session },
    ).lean();
    await recordAudit(
      {
        branchId,
        entityType: 'period_lock',
        entityId: doc._id,
        action: 'unlock',
        before: auditView(current),
        after: { ...auditView(doc), reason },
        actor,
      },
      session,
    );
    return doc;
  });
}

// One month's state (an unlocked blank when it has no document).
function monthView(month, doc, currentMonth) {
  const locked = Boolean(doc?.locked);
  return {
    month,
    locked,
    lockedAt: locked ? doc.lockedAt : null,
    lockedBy: locked ? doc.lockedBy : null,
    note: locked ? doc.note : '',
    canLock: !locked && month < currentMonth,
    history: doc?.history ?? [],
  };
}

/** One month's state. */
export async function getPeriod(branchId, month) {
  const doc = await PeriodLock.findOne({ branchId, month }).lean();
  return monthView(month, doc, periodOf(clock.now()));
}

/** The 12 months (April to March) of a financial year label such as '2026-27'; default: this year. */
export async function listPeriods(branchId, { fy } = {}) {
  const label = fy ?? financialYear(clock.now()).label;
  const start = Number(label.slice(0, 4));
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    return `${m >= 4 ? start : start + 1}-${String(m).padStart(2, '0')}`;
  });
  const docs = await PeriodLock.find({ branchId, month: { $in: months } }).lean();
  const byMonth = new Map(docs.map((d) => [d.month, d]));
  const currentMonth = periodOf(clock.now());
  return { fy: label, months: months.map((m) => monthView(m, byMonth.get(m), currentMonth)) };
}
