import mongoose from 'mongoose';
import { daysBetween } from '@vs/shared/billing.js';
import { istDate } from '@vs/shared/fy.js';
import { GstError, correctionDeadline, creditNoteFigures } from '@vs/shared/gst.js';
import { amountInWords, mulDivRound } from '@vs/shared/money.js';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, notFound } from '../../core/errors.js';
import { getBranch } from '../branches/service.js';
import { getOrderForBilling } from '../orders/service.js';
import { assertPeriodOpen } from '../periods/service.js';
import { allocate, availableByReceipt, recomputeSettlement, releaseInvoice, voucherShare } from './allocations.js';
import { customerSnapshot, guardCustomerMoney, newPdfKey, sellerSnapshot, takeDocumentNumber, toImmutableError } from './documents.js';
import { getInvoice } from './invoices.js';
import { Allocation, CreditNote, Receipt, Refund } from './model.js';
import { customerFor, orderFor } from './payments.js';

const HEADS = ['gross', 'taxable', 'cgst', 'sgst', 'igst'];
const NEAR_DEADLINE_DAYS = 30;

const pdfFor = (branchId, now) => ({ key: newPdfKey(branchId, now), status: 'pending', attempts: 0, nextAttemptAt: now });
const sumOf = (rows, key) => rows.reduce((s, r) => s + (r[key] ?? 0), 0);

// --- Credit notes ------------------------------------------------------------------------------

/** The bill's printed lines in the shape creditNoteFigures takes. */
const originalLinesOf = (invoice) =>
  (invoice.snapshot?.lines ?? []).map((l) => ({
    key: l.key,
    description: l.description,
    hsnSac: l.item?.hsnSac ?? null,
    taxable: l.taxable,
    rateBp: l.gstRateBp,
    cgst: l.cgst,
    sgst: l.sgst,
    igst: l.igst,
    total: l.total,
  }));

/** The bill's earlier credit notes in the shape creditNoteFigures takes. */
const earlierOf = (notes) => notes.map((n) => ({ lines: n.snapshot?.lines ?? [], total: n.totals.total }));

/** The credit note's lines and totals, worked out by creditNoteFigures (shared with the screen's preview). */
function creditFigures(invoice, earlier, input) {
  const originalLines = originalLinesOf(invoice);
  let calc;
  try {
    calc = creditNoteFigures({
      originalLines,
      credits: input.lines,
      earlier: earlierOf(earlier),
      invoiceTotal: invoice.totals.total,
      interState: invoice.interState,
      full: input.full,
    });
  } catch (err) {
    if (err instanceof GstError) throw businessRule('CREDIT_EXCEEDS_INVOICE', 'This is more than is left on the bill');
    if (err instanceof RangeError) throw businessRule('INVALID_AMOUNT', err.message);
    throw err;
  }

  const byKey = new Map(originalLines.map((l) => [l.key, l]));
  const lines = calc.lines.map((c) => ({
    key: c.key,
    description: byKey.get(c.key).description,
    hsnSac: c.hsnSac,
    taxable: c.taxable,
    gstRateBp: c.rateBp,
    cgst: c.cgst,
    sgst: c.sgst,
    igst: c.igst,
    total: c.total,
  }));
  const { taxable, cgst, sgst, igst, tax, roundOff, total } = calc.totals;
  return { lines, totals: { gross: taxable, discount: 0, taxable, cgst, sgst, igst, tax, roundOff, total } };
}

function deadlineWarnings(invoiceDate, today) {
  const deadline = correctionDeadline(invoiceDate);
  if (today > deadline) return [{ code: 'CORRECTION_DEADLINE_PASSED', deadline }];
  if (daysBetween(today, deadline) <= NEAR_DEADLINE_DAYS) return [{ code: 'CORRECTION_DEADLINE_NEAR', deadline }];
  return [];
}

/**
 * Reduces an issued bill with a credit note (admin), dated today: the whole bill, or chosen
 * amounts of its lines at their original rates. Money paid beyond what the bill now asks for
 * comes off the bill and becomes refundable advance. Returns { creditNote, warnings }.
 */
export async function issueCreditNote(branchId, invoiceId, input, actor) {
  try {
    return await withTransaction(async (session) => {
      const now = clock.now();
      const date = istDate(now);
      await assertPeriodOpen(branchId, date, session);
      const invoice = await getInvoice(branchId, invoiceId, session);
      if (invoice.status !== 'issued') throw businessRule('INVALID_STATUS', 'Only an issued bill can be reduced');
      await guardCustomerMoney(branchId, invoice.customerId, session);

      const earlier = await CreditNote.find({ invoiceId: invoice._id, status: 'issued' }).sort({ date: 1, _id: 1 }).session(session).lean();
      const { lines, totals } = creditFigures(invoice, earlier, input);
      const branch = await getBranch(branchId, session);
      if (!branch.gstin) throw businessRule('BRANCH_GSTIN_MISSING', 'Add the shop GSTIN before issuing bills');
      const warnings = deadlineWarnings(invoice.date, date);

      const { number, fyCode } = await takeDocumentNumber({ branchId, docType: 'credit_note', now }, session);
      const [note] = await CreditNote.create(
        [
          {
            branchId,
            customerId: invoice.customerId,
            orderId: invoice.orderId ?? null,
            invoiceId: invoice._id,
            status: 'issued',
            number,
            fyCode,
            date,
            month: date.slice(0, 7),
            totals,
            reason: input.reason,
            lineCredits: lines.map((l) => ({ key: l.key, taxable: l.taxable })),
            snapshot: {
              docType: 'credit_note',
              title: 'Credit note',
              number,
              date,
              seller: sellerSnapshot(branch),
              customer: invoice.snapshot.customer,
              placeOfSupply: invoice.snapshot.placeOfSupply,
              original: { number: invoice.number, date: invoice.date },
              reason: input.reason,
              lines,
              totals,
              amountInWords: amountInWords(totals.total),
            },
            pdf: pdfFor(branchId, now),
            issuedAt: now,
            issuedBy: actor.userId,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          },
        ],
        { session },
      );

      // Money paid beyond what the bill now asks for comes off it (newest payments first).
      const settlement = await recomputeSettlement(invoice._id, session);
      const excess = Math.min(-settlement.balance, settlement.paid);
      const released = excess > 0 ? await releaseInvoice(invoice, excess, 'release_credit', actor, session) : [];
      if (released.length) await recomputeSettlement(invoice._id, session);

      await recordAudit(
        {
          branchId,
          entityType: 'credit_note',
          entityId: note._id,
          action: 'create',
          after: {
            number,
            date,
            invoiceId: invoice._id,
            reason: input.reason,
            full: input.full,
            lines: lines.map((l) => ({ key: l.key, taxable: l.taxable })),
            totals,
            released: excess > 0 ? excess : 0,
          },
          actor,
        },
        session,
      );
      return { creditNote: await CreditNote.findById(note._id).session(session).lean(), warnings };
    });
  } catch (err) {
    throw toImmutableError(err);
  }
}

/** A credit note of the branch, lean; 404 otherwise. */
export async function getCreditNote(branchId, id, session) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const note = await CreditNote.findOne({ _id: id, branchId }).session(session ?? null).lean();
  if (!note) throw notFound();
  return note;
}

// --- Refunds -----------------------------------------------------------------------------------

/**
 * Pays money held back to the customer (admin) as a refund voucher dated today: from the order's
 * advance, or (with no order) from advance held with no order; newest receipts first. GST on
 * the receipt vouchers of the receipts drawn is reversed in proportion.
 */
export async function issueRefund(branchId, input, actor) {
  try {
    return await withTransaction(async (session) => {
      const now = clock.now();
      const date = istDate(now);
      await assertPeriodOpen(branchId, date, session);
      const customer = await customerFor(branchId, input.customerId, session);
      const loaded = input.orderId ? await orderFor(branchId, input.orderId, customer, session) : null;
      const order = loaded?.order ?? null;
      await guardCustomerMoney(branchId, customer._id, session);

      const held = await availableByReceipt(
        branchId,
        customer._id,
        { orderId: order?._id ?? null, includeUnassigned: !order },
        session,
      );
      const available = sumOf(held, 'available');
      if (input.amount > available) {
        throw businessRule('REFUND_EXCEEDS_BALANCE', 'This is more than the advance held', { available });
      }

      // Newest receipts first; each receipt's voucher gives back its share of the GST.
      const sources = [];
      const reversals = [];
      let remaining = input.amount;
      for (const { receipt, available: left } of [...held].reverse()) {
        if (remaining === 0) break;
        const take = Math.min(left, remaining);
        sources.push({ receipt, amount: take });
        remaining -= take;
        const share = await voucherShare(receipt, take, session);
        if (share) reversals.push(share);
      }
      const rvReversal = reversals.length ? Object.fromEntries(HEADS.map((h) => [h, sumOf(reversals, h)])) : null;

      const branch = await getBranch(branchId, session);
      const { number, fyCode } = await takeDocumentNumber({ branchId, docType: 'refund', now }, session);
      const [refund] = await Refund.create(
        [
          {
            branchId,
            customerId: customer._id,
            orderId: order?._id ?? null,
            status: 'issued',
            number,
            fyCode,
            date,
            month: date.slice(0, 7),
            amount: input.amount,
            mode: input.mode,
            reference: input.reference ?? '',
            reason: input.reason,
            rvReversal,
            snapshot: {
              docType: 'refund',
              title: 'Refund voucher',
              number,
              date,
              seller: sellerSnapshot(branch),
              customer: customerSnapshot(customer),
              amount: input.amount,
              amountInWords: amountInWords(input.amount),
              mode: input.mode,
              reference: input.reference ?? '',
              reason: input.reason,
              against: order ? { orderNo: order.orderNo } : null,
              rvReversal,
            },
            pdf: pdfFor(branchId, now),
            issuedAt: now,
            issuedBy: actor.userId,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          },
        ],
        { session },
      );
      for (const { receipt, amount } of sources) {
        await allocate(
          {
            branchId,
            customerId: customer._id,
            receiptId: receipt._id,
            refundId: refund._id,
            amount,
            reason: 'refund',
            date,
            by: actor.userId,
          },
          session,
        );
      }

      await recordAudit(
        {
          branchId,
          entityType: 'refund',
          entityId: refund._id,
          action: 'create',
          after: {
            number,
            date,
            customerId: customer._id,
            orderId: order?._id ?? null,
            amount: input.amount,
            mode: input.mode,
            reason: input.reason,
            sources: sources.map((s) => ({ receiptId: s.receipt._id, amount: s.amount })),
            rvReversal,
          },
          actor,
        },
        session,
      );
      return Refund.findById(refund._id).session(session).lean();
    });
  } catch (err) {
    throw toImmutableError(err);
  }
}

/** A refund of the branch, lean; 404 otherwise. */
export async function getRefund(branchId, id, session) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const refund = await Refund.findOne({ _id: id, branchId }).session(session ?? null).lean();
  if (!refund) throw notFound();
  return refund;
}

/** A refund as shown: the receipts it was paid from (newest first, as drawn). */
export async function refundView(refund, session) {
  const s = session ?? null;
  const rows = await Allocation.find({ refundId: refund._id }).sort({ _id: 1 }).session(s).lean();
  const receipts = await Receipt.find({ _id: { $in: rows.map((r) => r.receiptId) } }, { number: 1 }).session(s).lean();
  const numbers = new Map(receipts.map((r) => [String(r._id), r.number]));
  return {
    refund,
    sources: rows.map((r) => ({ receiptId: String(r.receiptId), number: numbers.get(String(r.receiptId)) ?? null, amount: r.amount })),
  };
}

/**
 * For a cancelled order, the refund its cancellation schedule suggests: the advance still held
 * for it × the refund percent recorded when it was cancelled. Null for any other order.
 */
export async function suggestedRefund(branchId, orderId) {
  const { order } = await getOrderForBilling(branchId, orderId);
  if (order.status !== 'cancelled') return null;
  const refundPercent = order.cancellation?.refundPercent ?? 0;
  const held = await withTransaction(async (session) =>
    sumOf(await availableByReceipt(branchId, order.customerId, { orderId: order._id }, session), 'available'),
  );
  return { held, refundPercent, suggested: mulDivRound(held, refundPercent, 100) };
}
