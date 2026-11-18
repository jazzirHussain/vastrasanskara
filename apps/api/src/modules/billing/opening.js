// Opening balances: what customers owed, and advances the shop held, on the cut-over date, brought
// in from earlier records. Each is a billing document of its own (Decision 11): an
// `opening_balance` (owed, payable like a bill) and an opening advance (a receipt marked
// `opening`, used by later bills like any advance). Neither takes a GST number or reaches GST
// figures, money collected or the payments list.
import mongoose from 'mongoose';
import { displayDate, financialYear, istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { AppError, businessRule, conflict, notFound, validationError } from '../../core/errors.js';
import { nextDocumentNumber } from '../../core/numbering.js';
import { getCustomer } from '../customers/service.js';
import { getOrderForBilling } from '../orders/service.js';
import { assertPeriodOpen } from '../periods/service.js';
import { guardCustomerMoney } from './documents.js';
import { Allocation, BillingDocument, OpeningBalance, Receipt } from './model.js';

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const pad = (n) => String(n).padStart(4, '0');
const openingExists = () => new AppError(409, 'OPENING_EXISTS', 'This customer already has an opening balance');
const inUse = () => businessRule('OPENING_IN_USE', 'Payments are already set against this balance');

/** The live opening documents of a customer: { openingBalance, receipt } (each lean or null). */
async function liveOpening(branchId, customerId, session) {
  const base = { branchId: oid(branchId), customerId: oid(customerId), status: 'issued' };
  const [openingBalance, receipt] = await Promise.all([
    OpeningBalance.findOne(base).session(session ?? null).lean(),
    Receipt.findOne({ ...base, opening: true }).session(session ?? null).lean(),
  ]);
  return { openingBalance, receipt };
}

/** Whether the customer already has an opening balance or opening advance. */
export async function hasOpeningBalance(branchId, customerId) {
  const { openingBalance, receipt } = await liveOpening(branchId, customerId);
  return Boolean(openingBalance || receipt);
}

// A number of an opening series, in the financial year of the cut-over date.
async function openingNumber(branchId, docType, prefix, asOf, session) {
  const at = new Date(`${asOf}T06:30:00Z`); // midday IST of the cut-over date
  const { number, fy } = await nextDocumentNumber({ branchId, docType, now: at }, session);
  return { number: `${prefix}/${fy.code}/${pad(number)}`, fyCode: financialYear(at).code };
}

/**
 * Records a customer's opening balance as of the cut-over date `asOf` (its month must be open):
 * `owed` paise as an opening balance due on that day, and `advance` paise as an opening advance
 * (optionally for one of the customer's orders). One per customer.
 */
export async function recordOpeningBalance(branchId, { customerId, owed = 0, advance = 0, asOf, note = '', orderId = null, legacyRef = null }, actor) {
  if (!(owed > 0) && !(advance > 0)) throw validationError([{ path: 'owed', message: 'Fill in the amount owed, the advance held, or both' }]);
  if (asOf > istDate(clock.now())) throw businessRule('DATE_IN_FUTURE', 'The cut-over date cannot be in the future');
  const customer = await getCustomer(branchId, customerId);
  if (orderId) {
    const loaded = await getOrderForBilling(branchId, orderId).catch(() => null);
    if (!loaded || String(loaded.order.customerId) !== String(customer._id)) {
      throw validationError([{ path: 'orderId', message: "This is not one of the customer's orders" }]);
    }
  }
  return withTransaction(async (session) => {
    await assertPeriodOpen(branchId, asOf, session);
    await guardCustomerMoney(branchId, customer._id, session);
    const live = await liveOpening(branchId, customer._id, session);
    if (live.openingBalance || live.receipt) throw openingExists();
    const now = clock.now();
    const common = {
      branchId,
      customerId: customer._id,
      status: 'issued',
      date: asOf,
      month: asOf.slice(0, 7),
      issuedAt: now,
      issuedBy: actor.userId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    };
    let openingBalance = null;
    let receipt = null;
    if (owed > 0) {
      const { number, fyCode } = await openingNumber(branchId, 'opening_balance', 'OB', asOf, session);
      [openingBalance] = await OpeningBalance.create(
        [
          {
            ...common,
            number,
            fyCode,
            amount: owed,
            dueDate: asOf,
            totals: { total: owed },
            settlement: { advanceApplied: 0, paid: 0, credited: 0, balance: owed },
            note,
            legacyRef,
          },
        ],
        { session },
      );
    }
    if (advance > 0) {
      const { number, fyCode } = await openingNumber(branchId, 'opening_advance', 'OA', asOf, session);
      [receipt] = await Receipt.create(
        [{ ...common, number, fyCode, orderId: orderId ? oid(orderId) : null, amount: advance, opening: true, mode: null, note }],
        { session },
      );
    }
    await recordAudit(
      {
        branchId,
        entityType: 'opening_balance',
        entityId: (openingBalance ?? receipt)._id,
        action: 'create',
        after: {
          customerId: String(customer._id),
          owed,
          advance,
          asOf,
          orderId: orderId ? String(orderId) : null,
          numbers: [openingBalance?.number, receipt?.number].filter(Boolean),
        },
        actor,
      },
      session,
    );
    return { openingBalance: openingBalance?.toObject() ?? null, receipt: receipt?.toObject() ?? null };
  });
}

/**
 * Cancels a customer's opening balance and opening advance together (named by either id), so the
 * right figures can be brought in again. Refused once a payment or a bill has used either.
 */
export async function cancelOpeningBalance(branchId, id, { version, patch: { reason } }, actor) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  return withTransaction(async (session) => {
    const named = await BillingDocument.findOne({ _id: id, branchId: oid(branchId) }).session(session);
    const isOpening = named && (named.type === 'opening_balance' || (named.type === 'receipt' && named.opening));
    if (!isOpening) throw notFound();
    if (named.__v !== version) throw conflict();
    if (named.status !== 'issued') throw businessRule('INVALID_STATUS', 'This opening balance is already cancelled');
    await guardCustomerMoney(branchId, named.customerId, session);
    const live = await liveOpening(branchId, named.customerId, session);
    const ids = [live.openingBalance?._id, live.receipt?._id].filter(Boolean);
    if (await Allocation.exists({ $or: [{ invoiceId: { $in: ids } }, { receiptId: { $in: ids } }] }).session(session)) throw inUse();
    const now = clock.now();
    const cancelled = [];
    for (const docId of ids) {
      const doc = await BillingDocument.findById(docId).session(session);
      await assertPeriodOpen(branchId, doc.date, session);
      doc.status = 'cancelled';
      doc.cancellation = { reason, at: now, by: actor.userId };
      if (doc.type === 'opening_balance') doc.settlement = { advanceApplied: 0, paid: 0, credited: 0, balance: 0 };
      doc.updatedBy = actor.userId;
      doc.increment();
      await doc.save({ session });
      cancelled.push(doc);
    }
    await recordAudit(
      {
        branchId,
        entityType: 'opening_balance',
        entityId: named._id,
        action: 'cancel',
        after: { customerId: String(named.customerId), reason, numbers: cancelled.map((d) => d.number) },
        actor,
      },
      session,
    );
    return (cancelled.find((d) => String(d._id) === String(named._id)) ?? named).toObject();
  });
}

/** Ledger words for an opening document: "Owed before 5 Nov 2026 (opening balance)". */
export function openingLabel(doc) {
  const day = displayDate(doc.date);
  const base = doc.type === 'opening_balance' ? `Owed before ${day} (opening balance)` : `Advance held before ${day} (opening balance)`;
  return doc.status === 'cancelled' ? `${base}, cancelled` : base;
}
