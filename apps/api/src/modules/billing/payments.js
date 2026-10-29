import mongoose from 'mongoose';
import { financialYear, istDate } from '@vs/shared/fy.js';
import { computeAdvanceTax, computeInvoice, placeOfSupply } from '@vs/shared/gst.js';
import { amountInWords, mulDivRound } from '@vs/shared/money.js';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, notFound, validationError } from '../../core/errors.js';
import { getBranch } from '../branches/service.js';
import { getItemsByIds, itemForGarmentType } from '../catalog/service.js';
import { getCustomer } from '../customers/service.js';
import { getOrderForBilling } from '../orders/service.js';
import { assertPeriodOpen } from '../periods/service.js';
import { allocate, availableByReceipt, recomputeSettlement } from './allocations.js';
import { customerSnapshot, guardCustomerMoney, newPdfKey, sellerSnapshot, takeDocumentNumber, toImmutableError } from './documents.js';
import { Allocation, Invoice, Receipt, ReceiptVoucher } from './model.js';

const NO_SLABS = [{ upToUnitPrice: null, rateBp: 0 }];
const NOT_BILLABLE = new Set(['rejected', 'cancelled']);

const fieldError = (path, message) => validationError([{ path, message }]);

// --- Order estimate ----------------------------------------------------------------------------

/**
 * What the order is expected to bill, before discounts: its billable garments (not rejected or
 * cancelled) at their agreed prices, each as its price-list item (garment.catalogItemId wins,
 * else the garment type's item). Garments without an item count as goods at 0 %.
 * Returns { orderValue, estimatedTotal, serviceGross, goodsGross, parts } where parts are the
 * service lines by HSN/SAC and rate, weighted by their value with GST.
 */
export async function orderEstimate(branchId, order, garments, session) {
  const billable = garments.filter((g) => !NOT_BILLABLE.has(g.status));
  const orderValue = billable.reduce((s, g) => s + g.agreedPrice, 0);
  if (!billable.length) return { orderValue, estimatedTotal: 0, serviceGross: 0, goodsGross: 0, parts: [] };

  const byId = await getItemsByIds(branchId, billable.map((g) => g.catalogItemId).filter(Boolean), session);
  const byType = new Map();
  const itemOf = async (g) => {
    if (g.catalogItemId) return byId.get(String(g.catalogItemId)) ?? null;
    if (!byType.has(g.type)) byType.set(g.type, await itemForGarmentType(branchId, g.type, session));
    return byType.get(g.type);
  };
  const lines = [];
  for (const g of billable) {
    const item = await itemOf(g);
    lines.push({
      key: String(g._id),
      quantity: 1,
      rate: g.agreedPrice,
      discount: 0,
      hsnSac: item?.hsnSac ?? null,
      gstSlabs: item?.gstSlabs ?? NO_SLABS,
      service: item?.supplyType === 'service',
    });
  }
  const customer = await getCustomer(branchId, order.customerId, session);
  const branch = await getBranch(branchId, session);
  const { interState } = placeOfSupply({ branchStateCode: branch.stateCode, customer });
  const calc = computeInvoice({ lines, interState });

  const service = new Set(lines.filter((l) => l.service).map((l) => l.key));
  const parts = new Map();
  let serviceGross = 0;
  for (const c of calc.lines) {
    if (!service.has(c.key)) continue;
    serviceGross += c.total;
    const k = `${c.hsnSac ?? ''}|${c.rateBp}`;
    const part = parts.get(k) ?? { weight: 0, rateBp: c.rateBp, hsnSac: c.hsnSac };
    part.weight += c.total;
    parts.set(k, part);
  }
  const estimatedTotal = calc.totals.total;
  return {
    orderValue,
    estimatedTotal,
    serviceGross,
    goodsGross: estimatedTotal - serviceGross,
    parts: [...parts.values()].filter((p) => p.weight > 0),
  };
}

// --- Recording a payment -----------------------------------------------------------------------

async function customerFor(branchId, customerId, session) {
  try {
    return await getCustomer(branchId, customerId, session);
  } catch {
    throw fieldError('customerId', 'Unknown customer');
  }
}

async function orderFor(branchId, orderId, customer, session) {
  let loaded;
  try {
    loaded = await getOrderForBilling(branchId, orderId, session);
  } catch {
    loaded = null;
  }
  if (!loaded || String(loaded.order.customerId) !== String(customer._id)) {
    throw fieldError('orderId', "This is not one of the customer's orders");
  }
  return loaded;
}

async function invoiceFor(branchId, invoiceId, customer, session) {
  const invoice = mongoose.isValidObjectId(invoiceId)
    ? await Invoice.findOne({ _id: invoiceId, branchId }).session(session).lean()
    : null;
  if (!invoice || invoice.status !== 'issued' || String(invoice.customerId) !== String(customer._id)) {
    throw fieldError('invoiceId', "This is not one of the customer's issued bills");
  }
  return invoice;
}

const receivedSoFar = (held) => held.reduce((s, h) => s + h.available, 0);

/**
 * What the part of an order payment left after its bills needs. The order's garments not on an
 * issued bill are estimated; the money held for the order plus `amount` may not pass that
 * estimate (`paidToBills` is added back into `maxAmount`, which is the most the payment could be).
 * When the order has bills and nothing is left to bill, the money is kept as plain advance (null).
 */
async function advanceFor(branchId, customer, loaded, bills, { amount, paidToBills }, session) {
  const { order, garments } = loaded;
  const billed = new Set(bills.flatMap((b) => (b.garmentIds ?? []).map(String)));
  const unbilled = garments.filter((g) => !billed.has(String(g._id)));
  if (bills.length && !unbilled.some((g) => !NOT_BILLABLE.has(g.status))) return null;
  const estimate = await orderEstimate(branchId, order, unbilled, session);
  const held = receivedSoFar(await availableByReceipt(branchId, customer._id, { orderId: order._id }, session));
  if (held + amount > estimate.estimatedTotal) {
    throw businessRule('ADVANCE_EXCEEDS_TOTAL', 'This is more than the order total', {
      maxAmount: paidToBills + Math.max(0, estimate.estimatedTotal - held),
    });
  }
  const serviceShare = estimate.serviceGross > 0 ? mulDivRound(amount, estimate.serviceGross, estimate.estimatedTotal) : 0;
  return { estimate, serviceShare };
}

/** How much of `amount` each bill takes, oldest first, up to its balance: [{ invoice, amount }]. */
async function planBills(bills, amount, session) {
  const plan = [];
  let remaining = amount;
  for (const invoice of bills) {
    if (remaining === 0) break;
    const { balance } = await recomputeSettlement(invoice._id, session);
    const take = Math.min(remaining, Math.max(0, balance));
    if (take > 0) {
      plan.push({ invoice, amount: take });
      remaining -= take;
    }
  }
  return plan;
}

const pdfFor = (branchId, now) => ({ key: newPdfKey(branchId, now), status: 'pending', attempts: 0, nextAttemptAt: now });

/**
 * Records money received from a customer as a receipt, in one transaction dated today (IST):
 * against a bill (paid up to its balance; the rest stays on the bill's order as advance), for an
 * order (its issued bills first, oldest first; the rest is the order's advance, with a receipt
 * voucher for its service share of what is not yet billed), or as an advance with no order.
 */
export async function recordPayment(branchId, input, actor) {
  try {
    return await withTransaction(async (session) => {
      const now = clock.now();
      const date = istDate(now);
      await assertPeriodOpen(branchId, date, session);

      const customer = await customerFor(branchId, input.customerId, session);
      const loaded = input.orderId ? await orderFor(branchId, input.orderId, customer, session) : null;
      const invoice = input.invoiceId ? await invoiceFor(branchId, input.invoiceId, customer, session) : null;
      if (invoice && loaded && String(invoice.orderId) !== String(loaded.order._id)) {
        throw fieldError('invoiceId', 'This bill is for another order');
      }
      await guardCustomerMoney(branchId, customer._id, session);

      // The money pays the named bill, or else the order's issued bills (oldest first), up to
      // their balances; what is left is advance for the order (or for the customer).
      const bills = invoice
        ? [invoice]
        : loaded
          ? await Invoice.find({ branchId, orderId: loaded.order._id, status: 'issued' }).sort({ date: 1, _id: 1 }).session(session).lean()
          : [];
      const plan = await planBills(bills, input.amount, session);
      const allocated = plan.reduce((sum, p) => sum + p.amount, 0);
      const left = input.amount - allocated;
      const advance =
        !invoice && loaded && left > 0
          ? await advanceFor(branchId, customer, loaded, bills, { amount: left, paidToBills: allocated }, session)
          : null;
      const invoiceOrder = invoice?.orderId ? await getOrderForBilling(branchId, invoice.orderId, session).catch(() => null) : null;
      const order = loaded?.order ?? invoiceOrder?.order ?? null;

      const branch = await getBranch(branchId, session);
      const seller = sellerSnapshot(branch);
      const customerSnap = customerSnapshot(customer);
      const fyCode = financialYear(now).code;
      const month = date.slice(0, 7);
      const withVoucher = advance && advance.serviceShare > 0;
      if (withVoucher && !branch.gstin) throw businessRule('BRANCH_GSTIN_MISSING', 'Add the shop GSTIN before issuing bills');
      const rvId = withVoucher ? new mongoose.Types.ObjectId() : null;

      const { number } = await takeDocumentNumber({ branchId, docType: 'receipt', now }, session);
      const against = invoice ? { invoiceNo: invoice.number } : order ? { orderNo: order.orderNo } : null;
      const [receipt] = await Receipt.create(
        [
          {
            branchId,
            customerId: customer._id,
            orderId: order?._id ?? null,
            status: 'issued',
            number,
            fyCode,
            date,
            month,
            amount: input.amount,
            mode: input.mode,
            reference: input.reference ?? '',
            receivedOn: input.receivedOn ?? null,
            note: input.note ?? '',
            receiptVoucherId: rvId,
            snapshot: {
              docType: 'receipt',
              title: 'Payment receipt',
              number,
              date,
              seller,
              customer: customerSnap,
              amount: input.amount,
              amountInWords: amountInWords(input.amount),
              mode: input.mode,
              reference: input.reference ?? '',
              receivedOn: input.receivedOn ?? null,
              against,
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

      for (const { invoice: bill, amount } of plan) {
        await allocate(
          { branchId, customerId: customer._id, receiptId: receipt._id, invoiceId: bill._id, amount, reason: 'payment', date, by: actor.userId },
          session,
        );
        await recomputeSettlement(bill._id, session);
      }

      await recordAudit(
        {
          branchId,
          entityType: 'receipt',
          entityId: receipt._id,
          action: 'create',
          after: {
            number,
            date,
            customerId: customer._id,
            orderId: order?._id ?? null,
            invoiceId: invoice?._id ?? null,
            amount: input.amount,
            mode: input.mode,
            allocated,
            allocations: plan.map((p) => ({ invoiceId: p.invoice._id, amount: p.amount })),
          },
          actor,
        },
        session,
      );

      if (withVoucher) {
        const supply = placeOfSupply({ branchStateCode: branch.stateCode, customer });
        const tax = computeAdvanceTax({ amount: advance.serviceShare, parts: advance.estimate.parts, interState: supply.interState });
        const lines = tax.lines.map((l, i) => ({ hsnSac: advance.estimate.parts[i].hsnSac ?? null, ...l }));
        const figures = { gross: tax.gross, taxable: tax.taxable, cgst: tax.cgst, sgst: tax.sgst, igst: tax.igst };
        const rv = await takeDocumentNumber({ branchId, docType: 'receipt_voucher', now }, session);
        await ReceiptVoucher.create(
          [
            {
              _id: rvId,
              branchId,
              customerId: customer._id,
              orderId: order._id,
              receiptId: receipt._id,
              status: 'issued',
              number: rv.number,
              fyCode,
              date,
              month,
              ...figures,
              snapshot: {
                docType: 'receipt_voucher',
                title: 'Receipt voucher',
                number: rv.number,
                date,
                seller,
                customer: customerSnap,
                placeOfSupply: { stateCode: supply.stateCode, stateName: supply.stateName, interState: supply.interState },
                lines,
                totals: { ...figures, tax: tax.tax },
                amountInWords: amountInWords(tax.gross),
                against: { orderNo: order.orderNo },
                receiptNo: number,
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
        await recordAudit(
          {
            branchId,
            entityType: 'receipt_voucher',
            entityId: rvId,
            action: 'create',
            after: { number: rv.number, date, receiptId: receipt._id, ...figures },
            actor,
          },
          session,
        );
      }
      return Receipt.findById(receipt._id).session(session).lean();
    });
  } catch (err) {
    throw toImmutableError(err);
  }
}

// --- Cancelling a receipt ----------------------------------------------------------------------

async function loadReceipt(branchId, id, session) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const receipt = await Receipt.findOne({ _id: id, branchId }).session(session ?? null);
  if (!receipt) throw notFound();
  return receipt;
}

/** Net allocated by the receipt per bill id (only bills it still holds money on). */
async function heldOnBills(receiptId, session) {
  const rows = await Allocation.aggregate([
    { $match: { receiptId, invoiceId: { $ne: null } } },
    { $group: { _id: '$invoiceId', amount: { $sum: '$amount' } } },
  ]).session(session);
  return rows.filter((r) => r.amount > 0);
}

/**
 * Cancels a receipt (admin): releases the money it put on bills, recomputes those bills and
 * cancels its receipt voucher. Refused when a refund drew on it or its voucher is adjusted on a
 * bill. The numbers stay used.
 */
export async function cancelReceipt(branchId, id, { reason }, actor) {
  try {
    return await withTransaction(async (session) => {
      const now = clock.now();
      const receipt = await loadReceipt(branchId, id, session);
      await assertPeriodOpen(branchId, receipt.date, session);
      if (receipt.status !== 'issued') throw businessRule('ALREADY_CANCELLED', 'This receipt is already cancelled');
      await guardCustomerMoney(branchId, receipt.customerId, session);

      const refunded = await Allocation.exists({ receiptId: receipt._id, refundId: { $ne: null } }).session(session);
      if (refunded) throw businessRule('RECEIPT_REFUNDED', 'Money from this receipt has been refunded; it cannot be cancelled');
      const rv = receipt.receiptVoucherId
        ? await ReceiptVoucher.findOne({ _id: receipt.receiptVoucherId, branchId, status: 'issued' }).session(session)
        : null;
      if (rv) {
        const adjusted = await Invoice.exists({
          branchId,
          status: 'issued',
          'advanceAdjustments.receiptVoucherId': rv._id,
        }).session(session);
        if (adjusted) throw businessRule('VOUCHER_ADJUSTED', 'Cancel the bill first');
      }

      const date = istDate(now);
      const released = [];
      for (const { _id: invoiceId, amount } of await heldOnBills(receipt._id, session)) {
        await allocate(
          {
            branchId,
            customerId: receipt.customerId,
            receiptId: receipt._id,
            invoiceId,
            amount: -amount,
            reason: 'release_receipt_cancel',
            date,
            by: actor.userId,
          },
          session,
        );
        await recomputeSettlement(invoiceId, session);
        released.push({ invoiceId, amount });
      }

      const cancellation = { reason, at: now, by: actor.userId };
      receipt.set({ status: 'cancelled', cancellation, updatedBy: actor.userId });
      await receipt.save({ session });
      await recordAudit(
        {
          branchId,
          entityType: 'receipt',
          entityId: receipt._id,
          action: 'cancel',
          before: { status: 'issued' },
          after: { status: 'cancelled', reason, released },
          actor,
        },
        session,
      );
      if (rv) {
        rv.set({ status: 'cancelled', cancellation, updatedBy: actor.userId });
        await rv.save({ session });
        await recordAudit(
          {
            branchId,
            entityType: 'receipt_voucher',
            entityId: rv._id,
            action: 'cancel',
            before: { status: 'issued' },
            after: { status: 'cancelled', reason },
            actor,
          },
          session,
        );
      }
      return Receipt.findById(receipt._id).session(session).lean();
    });
  } catch (err) {
    throw toImmutableError(err);
  }
}

// --- Reading -----------------------------------------------------------------------------------

/** A receipt of the branch (any status), lean; 404 otherwise. */
export async function getReceipt(branchId, id, session) {
  return (await loadReceipt(branchId, id, session)).toObject();
}

/** A receipt voucher of the branch, lean; 404 otherwise. */
export async function getReceiptVoucher(branchId, id, session) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const rv = await ReceiptVoucher.findOne({ _id: id, branchId }).session(session ?? null).lean();
  if (!rv) throw notFound();
  return rv;
}

/**
 * A receipt as shown: its money on bills (net per bill), what is left unallocated (none once
 * cancelled), its order and its receipt voucher.
 */
export async function receiptView(branchId, receipt, session) {
  const s = session ?? null;
  const rows = await Allocation.find({ receiptId: receipt._id }, { invoiceId: 1, amount: 1 }).session(s).lean();
  const net = new Map();
  for (const r of rows) {
    if (!r.invoiceId) continue;
    const k = String(r.invoiceId);
    net.set(k, (net.get(k) ?? 0) + r.amount);
  }
  const held = [...net].filter(([, amount]) => amount !== 0);
  const bills = held.length
    ? await Invoice.find({ _id: { $in: held.map(([k]) => k) } }, { number: 1 }).session(s).lean()
    : [];
  const numbers = new Map(bills.map((b) => [String(b._id), b.number]));
  const allocated = rows.reduce((sum, r) => sum + r.amount, 0);

  const [order, rv] = await Promise.all([
    receipt.orderId
      ? getOrderForBilling(branchId, receipt.orderId, session)
          .then((o) => ({ id: String(o.order._id), orderNo: o.order.orderNo }))
          .catch(() => null)
      : null,
    receipt.receiptVoucherId ? ReceiptVoucher.findById(receipt.receiptVoucherId).session(s).lean() : null,
  ]);
  return {
    receipt,
    customer: { id: String(receipt.customerId), name: receipt.snapshot?.customer?.name ?? '' },
    order,
    allocations: held.map(([invoiceId, amount]) => ({ invoiceId, number: numbers.get(invoiceId) ?? null, amount })),
    unallocated: receipt.status === 'issued' ? receipt.amount - allocated : 0,
    receiptVoucher: rv,
  };
}
