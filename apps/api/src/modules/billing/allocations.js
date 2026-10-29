import { istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { Allocation, CreditNote, Invoice, Receipt, Refund } from './model.js';

// Every function here runs inside the caller's transaction, after guardCustomerMoney, so the
// sums it reads cannot change before the caller commits.
const TAX_HEADS = ['gross', 'taxable', 'cgst', 'sgst', 'igst'];
const RELEASE_REASONS = ['release_cancel', 'release_credit', 'release_receipt_cancel'];

const requireTransaction = (session, name) => {
  if (!session?.inTransaction()) throw new Error(`${name} must be called inside a transaction`);
};

/** Σ allocation rows per receipt id (as a string). */
async function allocatedByReceipt(receiptIds, session) {
  const rows = await Allocation.aggregate([
    { $match: { receiptId: { $in: receiptIds } } },
    { $group: { _id: '$receiptId', amount: { $sum: '$amount' } } },
  ]).session(session);
  return new Map(rows.map((r) => [String(r._id), r.amount]));
}

/**
 * Receipts of the customer with money not yet allocated, as [{ receipt, available }]: the
 * order's receipts first, then (only with includeUnassigned) receipts with no order; oldest first.
 * Another order's receipts are never offered. Cancelled receipts hold nothing.
 */
export async function availableByReceipt(branchId, customerId, { orderId = null, includeUnassigned = false } = {}, session) {
  requireTransaction(session, 'availableByReceipt');
  const groups = [];
  if (orderId) groups.push(orderId);
  if (includeUnassigned) groups.push(null);
  const result = [];
  for (const group of groups) {
    const receipts = await Receipt.find({ branchId, customerId, status: 'issued', orderId: group })
      .sort({ date: 1, _id: 1 })
      .session(session)
      .lean();
    const allocated = await allocatedByReceipt(receipts.map((r) => r._id), session);
    for (const receipt of receipts) {
      const available = receipt.amount - (allocated.get(String(receipt._id)) ?? 0);
      if (available > 0) result.push({ receipt, available });
    }
  }
  return result;
}

/** Appends one signed allocation row. */
export async function allocate({ branchId, customerId, receiptId, invoiceId = null, refundId = null, amount, reason, date, by }, session) {
  requireTransaction(session, 'allocate');
  if (!Number.isSafeInteger(amount) || amount === 0) throw new RangeError(`Invalid allocation amount: ${amount}`);
  const [row] = await Allocation.create(
    [{ branchId, customerId, receiptId, invoiceId, refundId, amount, reason, date, at: clock.now(), by }],
    { session },
  );
  return row.toObject();
}

/**
 * Takes `amount` paise of payments back off a bill, newest allocations first, as negative rows
 * (the money becomes advance on its receipts again). Returns the rows written.
 */
export async function releaseInvoice(invoice, amount, reason, actor, session) {
  requireTransaction(session, 'releaseInvoice');
  if (!RELEASE_REASONS.includes(reason)) throw new Error(`Not a release reason: ${reason}`);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError(`Invalid release amount: ${amount}`);

  const rows = await Allocation.find({ invoiceId: invoice._id }).sort({ at: 1, _id: 1 }).session(session).lean();
  // Net held per receipt, and receipts ordered by their newest money-in row.
  const net = new Map();
  const newest = new Map();
  rows.forEach((row, i) => {
    const key = String(row.receiptId);
    net.set(key, (net.get(key) ?? 0) + row.amount);
    if (row.amount > 0) newest.set(key, { i, receiptId: row.receiptId });
  });
  const order = [...newest.values()].sort((a, b) => b.i - a.i);
  const held = order.reduce((sum, { receiptId }) => sum + Math.max(0, net.get(String(receiptId))), 0);
  if (amount > held) throw new RangeError(`Cannot release ${amount}: only ${held} is allocated to the bill`);

  const date = istDate(clock.now());
  const written = [];
  let remaining = amount;
  for (const { receiptId } of order) {
    if (remaining === 0) break;
    const take = Math.min(remaining, net.get(String(receiptId)));
    if (take <= 0) continue;
    written.push(
      await allocate(
        {
          branchId: invoice.branchId,
          customerId: invoice.customerId,
          receiptId,
          invoiceId: invoice._id,
          amount: -take,
          reason,
          date,
          by: actor.userId,
        },
        session,
      ),
    );
    remaining -= take;
  }
  return written;
}

/**
 * Recomputes the bill's settlement cache from its allocations and issued credit notes (never
 * incremented) and saves it. Returns { advanceApplied, paid, credited, balance }.
 */
export async function recomputeSettlement(invoiceId, session) {
  requireTransaction(session, 'recomputeSettlement');
  const invoice = await Invoice.findById(invoiceId).session(session);
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
  const rows = await Allocation.find({ invoiceId }, { amount: 1, reason: 1 }).session(session).lean();
  const notes = await CreditNote.find({ invoiceId, status: 'issued' }, { 'totals.total': 1 }).session(session).lean();

  const advanceApplied = rows.filter((r) => r.reason === 'advance_applied').reduce((s, r) => s + r.amount, 0);
  const paid = rows.reduce((s, r) => s + r.amount, 0);
  const credited = notes.reduce((s, n) => s + n.totals.total, 0);
  const settlement = { advanceApplied, paid, credited, balance: invoice.totals.total - paid - credited };

  invoice.settlement = settlement;
  await invoice.save({ session });
  return settlement;
}

/**
 * What a receipt voucher has not yet adjusted: its figures less the adjustments on issued bills
 * and the reversals of refunds paid from its receipt, as { gross, taxable, cgst, sgst, igst }.
 */
export async function voucherRemaining(rv, session) {
  requireTransaction(session, 'voucherRemaining');
  const bills = await Invoice.find({ status: 'issued', 'advanceAdjustments.receiptVoucherId': rv._id }, { advanceAdjustments: 1 })
    .session(session)
    .lean();
  const used = bills.flatMap((b) => b.advanceAdjustments.filter((a) => String(a.receiptVoucherId) === String(rv._id)));
  const refundIds = await Allocation.distinct('refundId', { receiptId: rv.receiptId, refundId: { $ne: null } }).session(session);
  if (refundIds.length) {
    const refunds = await Refund.find({ _id: { $in: refundIds }, status: 'issued' }, { rvReversal: 1 }).session(session).lean();
    used.push(...refunds.map((r) => r.rvReversal).filter(Boolean));
  }
  return Object.fromEntries(TAX_HEADS.map((h) => [h, (rv[h] ?? 0) - used.reduce((s, u) => s + (u[h] ?? 0), 0)]));
}
