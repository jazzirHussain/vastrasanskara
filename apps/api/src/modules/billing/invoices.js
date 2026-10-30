import mongoose from 'mongoose';
import { payStatus } from '@vs/shared/billing.js';
import { addDaysYmd, displayDate, istDate } from '@vs/shared/fy.js';
import { GstError, RULE46_ADDRESS_THRESHOLD, computeInvoice, placeOfSupply } from '@vs/shared/gst.js';
import { amountInWords, formatINR } from '@vs/shared/money.js';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { emit } from '../../core/notify/emit.js';
import { businessRule, conflict, forbidden, notFound, validationError } from '../../core/errors.js';
import { getBranch } from '../branches/service.js';
import { getItemsByIds, itemForCharge, itemForGarmentType } from '../catalog/service.js';
import { getCustomer } from '../customers/service.js';
import { getOrderForBilling } from '../orders/service.js';
import { assertPeriodOpen, isPeriodLocked } from '../periods/service.js';
import { listChargeableEvents } from '../production/service.js';
import { readSettings } from '../settings/service.js';
import './notifications.js';
import { allocate, availableByReceipt, recomputeSettlement, releaseInvoice, voucherShare } from './allocations.js';
import {
  customerSnapshot,
  guardCustomerMoney,
  newPdfKey,
  sellerSnapshot,
  takeDocumentNumber,
  toImmutableError,
} from './documents.js';
import { CreditNote, Invoice } from './model.js';

const NO_SLABS = [{ upToUnitPrice: null, rateBp: 0 }];
const NOT_BILLABLE = new Set(['rejected', 'cancelled']);

const immutable = () => businessRule('DOCUMENT_IMMUTABLE', 'Issued documents cannot be changed');

// --- What can still be billed on an order ------------------------------------------------------

/**
 * The order's garments and chargeable stage events that no issued bill carries yet:
 * { garments (billable), events (unbilled, of billable or picked-up garments), hasRushBilled }.
 */
async function billableFor(branchId, order, garments, session) {
  const s = session ?? null;
  const garmentIds = garments.map((g) => g._id);
  const billedOn = await Invoice.find({ garmentIds: { $in: garmentIds }, status: 'issued' }, { garmentIds: 1 }).session(s).lean();
  const billedGarments = new Set(billedOn.flatMap((i) => i.garmentIds.map(String)));

  const billable = garments.filter((g) => !NOT_BILLABLE.has(g.status) && !billedGarments.has(String(g._id)));
  const pool = garments.filter((g) => g.status === 'picked_up' || billable.includes(g));
  const proposed = await listChargeableEvents(branchId, pool.map((g) => g._id), session);
  const billedEventDocs = proposed.length
    ? await Invoice.find({ stageEventIds: { $in: proposed.map((e) => e.id) }, status: 'issued' }, { stageEventIds: 1 }).session(s).lean()
    : [];
  const billedEvents = new Set(billedEventDocs.flatMap((i) => i.stageEventIds.map(String)));
  const events = proposed.filter((e) => !billedEvents.has(String(e.id)));

  const issuedForOrder = await Invoice.find({ branchId, orderId: order._id, status: 'issued' }, { snapshot: 1 }).session(s).lean();
  const hasRushBilled = issuedForOrder.some((i) => (i.snapshot?.lines ?? []).some((l) => l.source === 'rush'));
  return { garments: billable, events, hasRushBilled };
}

// --- Creating drafts ---------------------------------------------------------------------------

const newLine = (fields) => ({ garmentId: null, stageEventId: null, quantity: 1, discount: 0, discountReason: '', ...fields });

/**
 * Whether a new bill would have anything on it: the same rule as proposeLines, answered from the
 * first billable garment, charge or rush fee without looking up any price-list items.
 */
export async function hasUnbilled(branchId, order, garments) {
  const { garments: billable, events, hasRushBilled } = await billableFor(branchId, order, garments);
  if (billable.length || events.length) return true;
  return order.priority === 'rush' && !hasRushBilled && Boolean(await itemForCharge(branchId, 'rush'));
}

async function proposeLines(branchId, order, allGarments, session) {
  const settings = await readSettings(branchId, session);
  const label = (type) => settings.garmentTypes.find((t) => t.key === type)?.label ?? type;
  const { garments, events, hasRushBilled } = await billableFor(branchId, order, allGarments, session);
  const byId = new Map(allGarments.map((g) => [String(g._id), g]));
  const lines = [];

  for (const g of garments) {
    const item = g.catalogItemId ? null : await itemForGarmentType(branchId, g.type, session);
    lines.push(
      newLine({
        key: `g-${g._id}`,
        source: 'garment',
        garmentId: g._id,
        itemId: g.catalogItemId ?? item?._id ?? null,
        description: `${label(g.type)} — ${g.description} (${g.garmentNo})`,
        rate: g.agreedPrice,
      }),
    );
  }
  const chargeItems = {};
  for (const e of events) {
    const kind = e.action === 'alteration' ? 'alteration' : 'rework';
    if (!(kind in chargeItems)) chargeItems[kind] = await itemForCharge(branchId, kind, session);
    const item = chargeItems[kind];
    const g = byId.get(String(e.garmentId));
    lines.push(
      newLine({
        key: `e-${e.id}`,
        source: 'charge',
        stageEventId: e.id,
        itemId: item?._id ?? null,
        description: `${kind === 'alteration' ? 'Alteration' : 'Rework'} — ${g.description} (${g.garmentNo})`,
        rate: e.chargeAmount ?? item?.defaultPrice ?? 0,
      }),
    );
  }
  if (order.priority === 'rush' && !hasRushBilled) {
    const item = await itemForCharge(branchId, 'rush', session);
    if (item) {
      lines.push(newLine({ key: 'rush', source: 'rush', itemId: item._id, description: item.name, rate: item.defaultPrice }));
    }
  }
  return lines;
}

const existingDraftOf = (branchId, orderId, session) =>
  Invoice.findOne({ branchId, orderId, status: 'draft' }).session(session ?? null).lean();

/** Opens the order's draft bill, or makes it from the garments, charges and rush fee not yet billed. */
export async function createDraftFromOrder(branchId, orderId, actor) {
  const existing = mongoose.isValidObjectId(orderId) && (await existingDraftOf(branchId, orderId));
  if (existing) return { invoice: existing, created: false };
  try {
    return await withTransaction(async (session) => {
      const { order, garments } = await getOrderForBilling(branchId, orderId, session);
      if (order.status === 'cancelled') throw businessRule('INVALID_STATUS', 'A cancelled order cannot be billed');
      const lines = await proposeLines(branchId, order, garments, session);
      if (!lines.length) throw businessRule('NOTHING_TO_BILL', 'Everything on this order has been billed');
      const [invoice] = await Invoice.create(
        [
          {
            branchId,
            customerId: order.customerId,
            orderId: order._id,
            status: 'draft',
            draft: { lines, invoiceDiscount: 0, invoiceDiscountReason: '', notes: '' },
            createdBy: actor.userId,
            updatedBy: actor.userId,
          },
        ],
        { session },
      );
      return { invoice: invoice.toObject(), created: true };
    });
  } catch (err) {
    // Two people pressing "Create bill" at once: the unique draft-per-order index lets one win.
    if (err?.code === 11000) {
      const draft = await existingDraftOf(branchId, orderId);
      if (draft) return { invoice: draft, created: false };
    }
    throw err;
  }
}

/** An empty draft bill for a customer. */
export async function createBlankDraft(branchId, customerId, actor) {
  const customer = await getCustomer(branchId, customerId).catch(() => null);
  if (!customer) throw validationError([{ path: 'customerId', message: 'Unknown customer' }]);
  const invoice = await Invoice.create({
    branchId,
    customerId: customer._id,
    orderId: null,
    status: 'draft',
    draft: { lines: [], invoiceDiscount: 0, invoiceDiscountReason: '', notes: '' },
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  return invoice.toObject();
}

// --- Maths -------------------------------------------------------------------------------------

/** computeInvoice with its errors as the 422 staff see. Lines without an item compute at 0 % (for the checks only). */
function compute({ lines, items, invoiceDiscount, interState }) {
  try {
    return computeInvoice({
      lines: lines.map((l) => {
        const item = items.get(String(l.itemId));
        return {
          key: l.key,
          quantity: l.quantity,
          rate: l.rate,
          discount: l.discount ?? 0,
          hsnSac: item?.hsnSac ?? null,
          gstSlabs: item?.gstSlabs ?? NO_SLABS,
        };
      }),
      invoiceDiscount,
      interState,
    });
  } catch (err) {
    if (err instanceof GstError) throw businessRule(err.code, err.message);
    if (err instanceof RangeError) throw businessRule('INVALID_AMOUNT', err.message);
    throw err;
  }
}

async function supplyFor(branchId, customer) {
  const branch = await getBranch(branchId);
  return { branch, supply: placeOfSupply({ branchStateCode: branch.stateCode, customer }) };
}

// --- Editing -----------------------------------------------------------------------------------

async function loadInvoice(branchId, id, session) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const invoice = await Invoice.findOne({ _id: id, branchId }).session(session ?? null);
  if (!invoice) throw notFound();
  return invoice;
}

/** Garments and charges can only be kept as the order offers them; they cannot be added by hand. */
async function checkLinks(branchId, invoice, lines, session) {
  const issues = [];
  let offered = { garments: [], events: [] };
  let order = null;
  if (invoice.orderId) {
    const loaded = await getOrderForBilling(branchId, invoice.orderId, session);
    order = loaded.order;
    offered = await billableFor(branchId, order, loaded.garments, session);
  }
  const garmentIds = new Set(offered.garments.map((g) => String(g._id)));
  const eventIds = new Set(offered.events.map((e) => String(e.id)));
  const seenGarments = new Set();
  const seenEvents = new Set();
  lines.forEach((l, i) => {
    if (l.garmentId) {
      if (!garmentIds.has(l.garmentId) || seenGarments.has(l.garmentId)) {
        issues.push({ path: `lines.${i}.garmentId`, message: 'This garment cannot be added to the bill' });
      }
      seenGarments.add(l.garmentId);
    } else if (l.source === 'garment') {
      issues.push({ path: `lines.${i}.garmentId`, message: 'A garment line needs its garment' });
    }
    if (l.stageEventId) {
      if (!eventIds.has(l.stageEventId) || seenEvents.has(l.stageEventId)) {
        issues.push({ path: `lines.${i}.stageEventId`, message: 'This charge cannot be added to the bill' });
      }
      seenEvents.add(l.stageEventId);
    } else if (l.source === 'charge') {
      issues.push({ path: `lines.${i}.stageEventId`, message: 'A charge line needs its charge' });
    }
    if (l.source === 'rush' && order?.priority !== 'rush') {
      issues.push({ path: `lines.${i}.source`, message: 'Only a rush order has a rush charge' });
    }
  });
  if (issues.length) throw validationError(issues);
}

/** Saves staff edits to a draft at `version`. */
export async function updateDraft(branchId, id, { version, patch }, user, actor) {
  const anyDiscount = patch.lines.some((l) => l.discount > 0) || patch.invoiceDiscount !== null;
  if (anyDiscount && !user.permissions.has('discounts.give')) throw forbidden();
  return withTransaction(async (session) => {
    const invoice = await loadInvoice(branchId, id, session);
    if (invoice.status !== 'draft') throw immutable();
    if (invoice.__v !== version) throw conflict();

    const items = await getItemsByIds(branchId, patch.lines.map((l) => l.itemId).filter(Boolean), session);
    const issues = patch.lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.itemId && !items.get(String(l.itemId))?.active)
      .map(({ i }) => ({ path: `lines.${i}.itemId`, message: 'Choose an item from the price list' }));
    if (issues.length) throw validationError(issues);
    await checkLinks(branchId, invoice, patch.lines, session);

    if (patch.lines.length) {
      const customer = await getCustomer(branchId, invoice.customerId);
      const { supply } = await supplyFor(branchId, customer);
      compute({ lines: patch.lines, items, invoiceDiscount: patch.invoiceDiscount?.amount ?? 0, interState: supply.interState });
    }

    const oid = (v) => (v ? new mongoose.Types.ObjectId(v) : null);
    invoice.draft.lines = patch.lines.map((l) => ({ ...l, itemId: oid(l.itemId), garmentId: oid(l.garmentId), stageEventId: oid(l.stageEventId) }));
    invoice.markModified('draft.lines');
    invoice.draft.invoiceDiscount = patch.invoiceDiscount?.amount ?? 0;
    invoice.draft.invoiceDiscountReason = patch.invoiceDiscount?.reason ?? '';
    invoice.draft.notes = patch.notes;
    invoice.updatedBy = actor.userId;
    invoice.increment();
    await invoice.save({ session });
    return invoice.toObject();
  });
}

/** Deletes a draft; an issued or cancelled bill is never deleted. */
export async function deleteDraft(branchId, id) {
  const invoice = await loadInvoice(branchId, id);
  if (invoice.status !== 'draft') throw immutable();
  await invoice.deleteOne();
}

// --- Issuing -----------------------------------------------------------------------------------

const lineRule = (code, message, lineKey) => businessRule(code, message, { lineKey });
const notBillable = (line) => lineRule('GARMENT_NOT_BILLABLE', 'This line can no longer be billed', line.key);
const alreadyBilled = (line) => lineRule('ALREADY_BILLED', 'This is already on another bill', line.key);

/** The first line whose `field` repeats an earlier line's. */
function repeated(lines, field) {
  const seen = new Set();
  return lines.find((l) => {
    const k = String(l[field]);
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });
}

/**
 * Re-checks, inside the issuing transaction, that every garment, charge and rush line can still
 * be billed: garments not rejected or cancelled, nothing already on another issued bill, at most
 * one rush charge and none once the order's rush is billed. Returns the ids the bill will carry.
 */
async function checkIssueLinks(branchId, invoice, lines, session) {
  const garmentLines = lines.filter((l) => l.garmentId);
  const eventLines = lines.filter((l) => l.stageEventId);
  const rushLines = lines.filter((l) => l.source === 'rush');
  if (!invoice.orderId) {
    const stray = garmentLines[0] ?? eventLines[0] ?? rushLines[0];
    if (stray) throw notBillable(stray);
    return { order: null, garmentIds: [], stageEventIds: [] };
  }

  const { order, garments } = await getOrderForBilling(branchId, invoice.orderId, session);
  const byId = new Map(garments.map((g) => [String(g._id), g]));
  const billableGarment = (garmentId) => {
    const g = byId.get(String(garmentId));
    return Boolean(g) && !NOT_BILLABLE.has(g.status);
  };
  for (const l of garmentLines) if (!billableGarment(l.garmentId)) throw notBillable(l);
  if (eventLines.length) {
    const chargeable = await listChargeableEvents(branchId, garments.map((g) => g._id), session);
    const events = new Map(chargeable.map((e) => [String(e.id), e]));
    for (const l of eventLines) {
      const e = events.get(String(l.stageEventId));
      if (!e || !billableGarment(e.garmentId)) throw notBillable(l);
    }
  }
  if (rushLines.length && order.priority !== 'rush') throw notBillable(rushLines[0]);

  const twice = repeated(garmentLines, 'garmentId') ?? repeated(eventLines, 'stageEventId') ?? rushLines[1];
  if (twice) throw alreadyBilled(twice);

  const oid = (v) => new mongoose.Types.ObjectId(String(v));
  const garmentIds = garmentLines.map((l) => oid(l.garmentId));
  const stageEventIds = eventLines.map((l) => oid(l.stageEventId));
  if (garmentIds.length || stageEventIds.length) {
    const others = await Invoice.find(
      {
        _id: { $ne: invoice._id },
        status: 'issued',
        $or: [{ garmentIds: { $in: garmentIds } }, { stageEventIds: { $in: stageEventIds } }],
      },
      { garmentIds: 1, stageEventIds: 1 },
    )
      .session(session)
      .lean();
    const billed = new Set(others.flatMap((i) => [...i.garmentIds, ...i.stageEventIds].map(String)));
    const onAnother = (v) => Boolean(v) && billed.has(String(v));
    const clash = lines.find((l) => onAnother(l.garmentId) || onAnother(l.stageEventId));
    if (clash) throw alreadyBilled(clash);
  }
  if (rushLines.length) {
    const rushBilled = await Invoice.exists({
      branchId,
      orderId: order._id,
      status: 'issued',
      'snapshot.lines.source': 'rush',
    }).session(session);
    if (rushBilled) throw alreadyBilled(rushLines[0]);
  }
  return { order, garmentIds, stageEventIds };
}

/**
 * Applies the advance held for the bill (the order's receipts, then receipts with no order,
 * oldest first) until the bill is covered. Returns { advanceApplied, adjustments }.
 */
async function applyAdvance(invoice, total, { date, actor }, session) {
  const held = await availableByReceipt(
    invoice.branchId,
    invoice.customerId,
    { orderId: invoice.orderId, includeUnassigned: true },
    session,
  );
  let remaining = total;
  const adjustments = [];
  for (const { receipt, available } of held) {
    if (remaining <= 0) break;
    const applied = Math.min(available, remaining);
    await allocate(
      {
        branchId: invoice.branchId,
        customerId: invoice.customerId,
        receiptId: receipt._id,
        invoiceId: invoice._id,
        amount: applied,
        reason: 'advance_applied',
        date,
        by: actor.userId,
      },
      session,
    );
    remaining -= applied;
    const adjustment = await voucherShare(receipt, applied, session);
    if (adjustment) adjustments.push(adjustment);
  }
  return { advanceApplied: total - remaining, adjustments };
}

const discountsOf = (lines) =>
  lines.filter((l) => l.discount > 0).map((l) => ({ lineKey: l.key, amount: l.discount, reason: l.discountReason ?? '' }));

/** Refuses a bill of ₹50,000 or more to an unregistered customer without an address (Rule 46). */
function checkAddress(customer, total) {
  if (customer.gstin || total < RULE46_ADDRESS_THRESHOLD) return;
  const a = customer.billingAddress;
  if (!a?.line1 || !a?.city) {
    throw businessRule('ADDRESS_REQUIRED', "Add the customer's address for a bill of ₹50,000 or more");
  }
}

export const PDF_WAIT_MS = 2 * 60_000;
export const pdfFilename = (number) => `${number.replace(/\//g, '-')}.pdf`;

/**
 * Issues a draft bill at `version`: re-checks it against the items, customer, branch and order
 * as they are now, takes the next number, fixes the snapshot, applies the advance held and
 * audits it, all in one transaction dated today (IST).
 */
export async function issueInvoice(branchId, id, { version }, actor) {
  try {
    return await withTransaction(async (session) => {
      const now = clock.now();
      const date = istDate(now);
      await assertPeriodOpen(branchId, date, session);

      const invoice = await loadInvoice(branchId, id, session);
      if (invoice.__v !== version) throw conflict();
      if (invoice.status !== 'draft') throw immutable();
      await guardCustomerMoney(branchId, invoice.customerId, session);

      const draft = invoice.toObject().draft ?? {};
      const lines = draft.lines ?? [];
      if (!lines.length) throw businessRule('NO_LINES', 'Add something to the bill first');
      const items = await getItemsByIds(branchId, lines.map((l) => l.itemId).filter(Boolean), session);
      for (const l of lines) {
        if (!l.itemId || !items.has(String(l.itemId))) {
          throw lineRule('ITEM_REQUIRED', 'Choose what to bill this line as', l.key);
        }
        if (l.rate === 0) throw lineRule('PRICE_NEEDED', 'Enter the price', l.key);
      }
      const customer = await getCustomer(branchId, invoice.customerId, session);
      const branch = await getBranch(branchId, session);
      const settings = await readSettings(branchId, session);
      if (!branch.gstin) throw businessRule('BRANCH_GSTIN_MISSING', 'Add the shop GSTIN before issuing bills');
      const { order, garmentIds, stageEventIds } = await checkIssueLinks(branchId, invoice, lines, session);

      const supply = placeOfSupply({ branchStateCode: branch.stateCode, customer });
      const invoiceDiscount = draft.invoiceDiscount ?? 0;
      const calc = compute({ lines, items, invoiceDiscount, interState: supply.interState });
      checkAddress(customer, calc.totals.total);

      const { number, fyCode } = await takeDocumentNumber({ branchId, docType: 'invoice', now }, session);
      const dueDate = addDaysYmd(date, settings.billDueDays);
      const calcByKey = new Map(calc.lines.map((c) => [c.key, c]));
      const seller = sellerSnapshot(branch);
      const discount = invoiceDiscount ? { amount: invoiceDiscount, reason: draft.invoiceDiscountReason ?? '' } : null;
      invoice.snapshot = {
        docType: 'invoice',
        title: 'Tax invoice',
        number,
        date,
        dueDate,
        seller,
        customer: customerSnapshot(customer),
        placeOfSupply: { stateCode: supply.stateCode, stateName: supply.stateName, interState: supply.interState },
        reverseCharge: false,
        lines: lines.map((l) => lineView(l, items.get(String(l.itemId)), calcByKey.get(l.key))),
        invoiceDiscount: discount,
        totals: calc.totals,
        taxSummary: calc.taxSummary,
        amountInWords: amountInWords(calc.totals.total),
        notes: draft.notes ?? '',
        signatory: seller.legalName,
        order: order ? { orderNo: order.orderNo } : null,
      };
      invoice.set({
        status: 'issued',
        number,
        fyCode,
        date,
        month: date.slice(0, 7),
        dueDate,
        totals: calc.totals,
        interState: supply.interState,
        garmentIds,
        stageEventIds,
        issuedAt: now,
        issuedBy: actor.userId,
        pdf: { key: newPdfKey(branchId, now), status: 'pending', attempts: 0, nextAttemptAt: now },
        updatedBy: actor.userId,
      });
      invoice.draft = null;

      // Once saved the bill is fixed, so the voucher adjustments are worked out before the save.
      const { advanceApplied, adjustments } = await applyAdvance(invoice, calc.totals.total, { date, actor }, session);
      invoice.advanceAdjustments = adjustments;
      // What the printed bill shows beside its total (the snapshot is read by the PDF alone).
      invoice.snapshot = { ...invoice.snapshot, advanceApplied, balanceDue: calc.totals.total - advanceApplied };
      invoice.increment();
      await invoice.save({ session });
      await recomputeSettlement(invoice._id, session);

      await recordAudit(
        {
          branchId,
          entityType: 'invoice',
          entityId: invoice._id,
          action: 'issue',
          after: {
            number,
            date,
            customerId: invoice.customerId,
            totals: calc.totals,
            discounts: discountsOf(lines),
            invoiceDiscount: discount,
            advanceApplied,
          },
          actor,
        },
        session,
      );
      // The client's copy waits two minutes for the PDF to be rendered; delivery retries if not.
      await emit(
        'invoice.issued',
        {
          branchId,
          refId: String(invoice._id),
          data: { customerId: invoice.customerId },
          vars: {
            customerName: customer.name,
            invoiceNo: number,
            amount: formatINR(calc.totals.total),
            balance: formatINR(calc.totals.total - advanceApplied),
            dueDate: displayDate(dueDate),
            paymentLine:
              calc.totals.total - advanceApplied > 0
                ? `Amount to pay: ${formatINR(calc.totals.total - advanceApplied)}. Please pay by ${displayDate(dueDate)}.`
                : 'Paid in full, thank you.',
          },
          attachments: [{ key: invoice.pdf.key, filename: pdfFilename(number) }],
        },
        { session, notBefore: new Date(now.getTime() + PDF_WAIT_MS) },
      );
      return Invoice.findById(invoice._id).session(session).lean();
    });
  } catch (err) {
    throw toImmutableError(err);
  }
}

// --- Cancelling --------------------------------------------------------------------------------

/**
 * Cancels an issued bill (admin) in the month it is dated, while that month is open: the money on
 * it becomes advance on its receipts again, its garments and charges can be billed again, and its
 * number stays used. A bill with credit notes cannot be cancelled.
 */
export async function cancelInvoice(branchId, id, { reason }, actor) {
  try {
    return await withTransaction(async (session) => {
      const now = clock.now();
      const invoice = await loadInvoice(branchId, id, session);
      if (invoice.status === 'cancelled') throw businessRule('ALREADY_CANCELLED', 'This bill is already cancelled');
      if (invoice.status !== 'issued') throw businessRule('INVALID_STATUS', 'Only an issued bill can be cancelled');
      await assertPeriodOpen(branchId, invoice.date, session);
      await guardCustomerMoney(branchId, invoice.customerId, session);
      if (await CreditNote.exists({ invoiceId: invoice._id, status: 'issued' }).session(session)) {
        throw businessRule('HAS_CREDIT_NOTES', 'This bill has a credit note, so it cannot be cancelled');
      }

      const { paid } = await recomputeSettlement(invoice._id, session);
      const rows = paid > 0 ? await releaseInvoice(invoice, paid, 'release_cancel', actor, session) : [];
      const cancellation = { reason, at: now, by: actor.userId };
      const { matchedCount } = await Invoice.updateOne(
        { _id: invoice._id, status: 'issued' },
        { $set: { status: 'cancelled', cancellation, updatedBy: actor.userId } },
        { session },
      );
      if (matchedCount !== 1) throw conflict();
      await recomputeSettlement(invoice._id, session);

      await recordAudit(
        {
          branchId,
          entityType: 'invoice',
          entityId: invoice._id,
          action: 'cancel',
          before: { status: 'issued' },
          after: {
            status: 'cancelled',
            reason,
            released: rows.map((r) => ({ receiptId: r.receiptId, amount: -r.amount })),
          },
          actor,
        },
        session,
      );
      return Invoice.findById(invoice._id).session(session).lean();
    });
  } catch (err) {
    throw toImmutableError(err);
  }
}

/** A stored invoice (any status) of the branch, lean; 404 otherwise. */
export async function getInvoice(branchId, id, session) {
  return (await loadInvoice(branchId, id, session)).toObject();
}

// --- Reading -----------------------------------------------------------------------------------

function lineView(line, item, calc) {
  return {
    key: line.key,
    source: line.source,
    itemId: line.itemId ? String(line.itemId) : null,
    item: item ? { name: item.name, hsnSac: item.hsnSac, supplyType: item.supplyType, unit: item.unit } : null,
    garmentId: line.garmentId ? String(line.garmentId) : null,
    stageEventId: line.stageEventId ? String(line.stageEventId) : null,
    description: line.description,
    quantity: line.quantity,
    rate: line.rate,
    discount: line.discount ?? 0,
    discountReason: line.discountReason ?? '',
    invoiceDiscountShare: calc?.invoiceDiscountShare ?? null,
    taxable: calc?.taxable ?? null,
    gstRateBp: calc?.rateBp ?? null,
    cgst: calc?.cgst ?? null,
    sgst: calc?.sgst ?? null,
    igst: calc?.igst ?? null,
    total: calc?.total ?? null,
  };
}

async function draftView(branchId, invoice, session) {
  const customer = await getCustomer(branchId, invoice.customerId);
  const { branch, supply } = await supplyFor(branchId, customer);
  const lines = invoice.draft?.lines ?? [];
  const items = await getItemsByIds(branchId, lines.map((l) => l.itemId).filter(Boolean), session);
  const missingItem = (l) => !l.itemId || !items.has(String(l.itemId));
  const warnings = [];
  for (const l of lines) {
    if (missingItem(l)) warnings.push({ code: 'ITEM_REQUIRED', lineKey: l.key });
    if (l.rate === 0) warnings.push({ code: 'PRICE_NEEDED', lineKey: l.key });
  }

  let order = null;
  if (invoice.orderId) {
    const loaded = await getOrderForBilling(branchId, invoice.orderId, session).catch(() => null);
    if (loaded) {
      order = { id: String(loaded.order._id), orderNo: loaded.order.orderNo };
      const offered = await billableFor(branchId, loaded.order, loaded.garments, session);
      const garmentIds = new Set(offered.garments.map((g) => String(g._id)));
      const eventIds = new Set(offered.events.map((e) => String(e.id)));
      for (const l of lines) {
        const gone = (l.garmentId && !garmentIds.has(String(l.garmentId))) || (l.stageEventId && !eventIds.has(String(l.stageEventId)));
        if (gone) warnings.push({ code: 'GARMENT_NOT_BILLABLE', lineKey: l.key });
      }
    }
  }

  let calc = null;
  if (lines.length && !lines.some(missingItem)) {
    try {
      calc = compute({ lines, items, invoiceDiscount: invoice.draft.invoiceDiscount ?? 0, interState: supply.interState });
    } catch {
      calc = null;
    }
  }
  if (calc && !customer.gstin && calc.totals.total >= RULE46_ADDRESS_THRESHOLD) {
    const a = customer.billingAddress;
    if (!a?.line1 || !a?.city) warnings.push({ code: 'ADDRESS_REQUIRED', lineKey: null });
  }
  if (!branch.gstin) warnings.push({ code: 'BRANCH_GSTIN_MISSING', lineKey: null });

  const calcByKey = new Map((calc?.lines ?? []).map((c) => [c.key, c]));
  return {
    invoice,
    customer: { id: String(customer._id), name: customer.name, gstin: customer.gstin ?? null, stateCode: customer.stateCode },
    order,
    lines: lines.map((l) => lineView(l, items.get(String(l.itemId)), calcByKey.get(l.key))),
    invoiceDiscount: invoice.draft?.invoiceDiscount
      ? { amount: invoice.draft.invoiceDiscount, reason: invoice.draft.invoiceDiscountReason ?? '' }
      : null,
    notes: invoice.draft?.notes ?? '',
    placeOfSupply: { stateCode: supply.stateCode, stateName: supply.stateName, interState: supply.interState },
    totals: calc ? { ...calc.totals } : null,
    settlement: null,
    overdue: false,
    monthLocked: false,
    creditNotes: [],
    warnings,
  };
}

async function issuedView(branchId, invoice, session) {
  const snap = invoice.snapshot ?? {};
  const c = snap.customer ?? {};
  const [order, creditNotes, monthLocked] = await Promise.all([
    invoice.orderId
      ? getOrderForBilling(branchId, invoice.orderId, session)
          .then((o) => ({ id: String(o.order._id), orderNo: o.order.orderNo }))
          .catch(() => null)
      : null,
    CreditNote.find({ invoiceId: invoice._id, status: 'issued' }).sort({ date: 1, _id: 1 }).session(session ?? null).lean(),
    isPeriodLocked(branchId, invoice.month, session),
  ]);
  const settlement = invoice.settlement
    ? { ...invoice.settlement, payStatus: payStatus({ total: invoice.totals.total, balance: invoice.settlement.balance }) }
    : null;
  return {
    invoice,
    customer: { id: String(invoice.customerId), name: c.name ?? '', gstin: c.gstin ?? null, stateCode: c.stateCode ?? '' },
    order,
    lines: snap.lines ?? [],
    invoiceDiscount: snap.invoiceDiscount ?? null,
    notes: snap.notes ?? '',
    placeOfSupply: snap.placeOfSupply ?? { stateCode: c.stateCode ?? '', stateName: c.stateName ?? '', interState: invoice.interState },
    totals: invoice.totals ? { ...invoice.totals } : null,
    settlement,
    overdue:
      invoice.status === 'issued' && (settlement?.balance ?? 0) > 0 && Boolean(invoice.dueDate) && istDate(clock.now()) > invoice.dueDate,
    monthLocked,
    creditNotes: creditNotes.map((n) => ({ id: String(n._id), number: n.number, date: n.date, total: n.totals.total })),
    warnings: [],
  };
}

/**
 * A bill as shown: a draft is computed from today's price list, customer and branch (with
 * warnings for what blocks issuing); an issued or cancelled bill comes from its snapshot.
 * `amountInWords` is added for the JSON.
 */
export async function invoiceView(branchId, invoice, session) {
  const view = invoice.status === 'draft' ? await draftView(branchId, invoice, session) : await issuedView(branchId, invoice, session);
  return { ...view, amountInWords: view.totals ? amountInWords(view.totals.total) : null };
}

/**
 * Pauses or resumes the overdue reminders of an issued bill (admin). Audited; the bill's
 * number, figures and snapshot are untouched.
 */
export async function setReminderPause(branchId, id, { paused }, actor) {
  try {
    return await withTransaction(async (session) => {
      const invoice = await loadInvoice(branchId, id, session);
      if (invoice.status !== 'issued') throw businessRule('INVALID_STATUS', 'Only an issued bill has reminders');
      const before = Boolean(invoice.remindersPaused);
      if (before !== paused) {
        const { matchedCount } = await Invoice.updateOne(
          { _id: invoice._id, status: 'issued' },
          { $set: { remindersPaused: paused, updatedBy: actor.userId } },
          { session },
        );
        if (matchedCount !== 1) throw conflict();
        await recordAudit(
          {
            branchId,
            entityType: 'invoice',
            entityId: invoice._id,
            action: paused ? 'reminders_paused' : 'reminders_resumed',
            before: { remindersPaused: before },
            after: { remindersPaused: paused },
            actor,
          },
          session,
        );
      }
      return Invoice.findById(invoice._id).session(session).lean();
    });
  } catch (err) {
    throw toImmutableError(err);
  }
}
