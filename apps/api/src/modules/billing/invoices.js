import mongoose from 'mongoose';
import { payStatus } from '@vs/shared/billing.js';
import { istDate } from '@vs/shared/fy.js';
import { GstError, RULE46_ADDRESS_THRESHOLD, computeInvoice, placeOfSupply } from '@vs/shared/gst.js';
import { amountInWords } from '@vs/shared/money.js';
import { clock } from '../../clock.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, conflict, forbidden, notFound, validationError } from '../../core/errors.js';
import { getBranch } from '../branches/service.js';
import { getItemsByIds, itemForCharge, itemForGarmentType } from '../catalog/service.js';
import { getCustomer } from '../customers/service.js';
import { getOrderForBilling } from '../orders/service.js';
import { isPeriodLocked } from '../periods/service.js';
import { listChargeableEvents } from '../production/service.js';
import { readSettings } from '../settings/service.js';
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
