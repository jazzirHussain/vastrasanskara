// "To buy" requests and receiving deliveries. Needs expenses/service.js, so (unlike service.js and
// what it re-exports) this file is imported only by routes.js.
import mongoose from 'mongoose';
import { expenseCost } from '@vs/shared/expenses.js';
import { istDate } from '@vs/shared/fy.js';
import { formatQty } from '@vs/shared/stock.js';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, conflict, notFound, validationError } from '../../core/errors.js';
import { paginate } from '../../core/pagination.js';
import { createExpense, getExpense, voidExpense } from '../expenses/service.js';
import { isActiveVendor } from '../vendors/service.js';
import { moveStock, readItemForMove } from './ledger.js';
import { GarmentMaterials, PurchaseRequest, StockItem } from './model.js';
import { addShortfall } from './reservations.js';

const { ObjectId } = mongoose.Types;
const oid = (id) => new ObjectId(String(id));
const OPEN = ['requested', 'ordered'];
const fieldError = (path, message) => validationError([{ path, message }]);
const invalidStatus = () => businessRule('INVALID_STATUS', 'This request cannot be changed in its current status');

/** The find filter of listRequests (exported for the index test); `open` is requested + ordered. */
export const requestListFilter = (branchId, status = 'open') => ({
  branchId: oid(branchId),
  status: status === 'open' ? { $in: OPEN } : status,
});

/** One page of the branch's requests with `status` (default open), newest first. */
export function listRequests(branchId, { status = 'open', cursor, limit } = {}) {
  return paginate(PurchaseRequest, requestListFilter(branchId, status), { sort: ['createdAt', -1], limit, cursor });
}

/** The items of `requests` by id string (for the JSON). */
export async function itemsOfRequests(branchId, requests) {
  const ids = [...new Set(requests.map((r) => String(r.stockItemId)))];
  const items = ids.length ? await StockItem.find({ _id: { $in: ids.map(oid) }, branchId }).lean() : [];
  return new Map(items.map((it) => [String(it._id), it]));
}

/** The branch's request read for a write at `version` (404; 409 when stale). */
async function loadForWrite(branchId, id, version, session) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const request = await PurchaseRequest.findOne({ _id: id, branchId }).session(session);
  if (!request) throw notFound();
  if (version !== undefined && request.__v !== version) throw conflict();
  return request;
}

async function saveRequest(request, actor, session) {
  request.updatedBy = actor?.userId ?? null;
  if (!request.isNew) request.increment();
  await request.save({ session });
  return request.toObject();
}

/** Asks to buy an item in use ("low_stock" or "manual"). */
export function createRequest(branchId, { stockItemId, quantity, reason, note = '' }, actor) {
  return withTransaction(async (session) => {
    const item = mongoose.isValidObjectId(stockItemId)
      ? await StockItem.findOne({ _id: stockItemId, branchId, active: true }).session(session).lean()
      : null;
    if (!item) throw fieldError('stockItemId', 'Choose an item from stock');
    const request = new PurchaseRequest({
      branchId, stockItemId: item._id, quantity, reason, note, createdBy: actor?.userId ?? null,
    });
    return saveRequest(request, actor, session);
  });
}

/** Marks a "requested" request as ordered, from a vendor in use (optional). */
export function markOrdered(branchId, id, { version, patch: { vendorId = null, note = '' } }, actor) {
  return withTransaction(async (session) => {
    const request = await loadForWrite(branchId, id, version, session);
    if (request.status !== 'requested') throw invalidStatus();
    if (vendorId && !(await isActiveVendor(branchId, vendorId))) throw fieldError('vendorId', 'Choose one of your vendors');
    request.set({ status: 'ordered', vendorId: vendorId ? oid(vendorId) : null, orderedAt: clock.now(), orderedBy: actor?.userId ?? null });
    if (note) request.note = note;
    return saveRequest(request, actor, session);
  });
}

/**
 * The request's needs still waiting for stock: each garment's planned line for the item and how
 * much of the need it still lacks (`want`, at most the line's planned − reserved). Needs of
 * garments whose materials were since used or put back want nothing.
 */
async function waitingNeeds(request, session) {
  const garmentIds = request.needs.map((n) => n.garmentId);
  const docs = garmentIds.length ? await GarmentMaterials.find({ garmentId: { $in: garmentIds } }).session(session) : [];
  const byGarment = new Map(docs.map((d) => [String(d.garmentId), d]));
  const sameItem = (l) => String(l.stockItemId) === String(request.stockItemId) && l.state === 'planned';
  return request.needs.map((need) => {
    const doc = byGarment.get(String(need.garmentId));
    const line = doc?.lines.find(sameItem);
    const want = line ? Math.max(0, Math.min(need.quantity, line.planned - line.reserved)) : 0;
    return { need, doc, line, want };
  });
}

const garmentOf = (need) => ({ garmentId: need.garmentId, garmentNo: need.garmentNo, orderId: need.orderId });

/**
 * Cancels a "requested" or "ordered" request with a reason. Garments still waiting for the item
 * go onto its open shortfall request (they still need it).
 */
export function cancelRequest(branchId, id, { version, patch: { reason } }, actor) {
  return withTransaction(async (session) => {
    const request = await loadForWrite(branchId, id, version, session);
    if (!OPEN.includes(request.status)) throw invalidStatus();
    const waiting = await waitingNeeds(request, session);
    request.set({ status: 'cancelled', cancellation: { reason, at: clock.now(), by: actor?.userId ?? null } });
    const saved = await saveRequest(request, actor, session);
    for (const { need, want } of waiting) {
      await addShortfall(branchId, { stockItemId: request.stockItemId, garment: garmentOf(need), quantity: want }, session);
    }
    return saved;
  });
}

/**
 * Receives a delivery in one transaction: the material purchase expense (`source: 'purchase'`),
 * the stock in at the expense's cost value (before GST when it can be claimed), the delivery
 * reserved for the garments waiting on the request in order, and the request received. What
 * those garments still lack goes onto a new request. With `stockItemId` instead of `requestId`,
 * a "manual" request is recorded as received. `date` defaults to today.
 */
export function receive(branchId, { requestId, stockItemId }, input, actor, { storage } = {}) {
  return withTransaction(async (session) => {
    let request;
    if (requestId) {
      request = await loadForWrite(branchId, requestId, undefined, session);
      if (!OPEN.includes(request.status)) throw invalidStatus();
    } else {
      const found = await readItemForMove(branchId, stockItemId, session);
      request = new PurchaseRequest({
        branchId, stockItemId: found._id, quantity: input.quantity, reason: 'manual', status: 'ordered', createdBy: actor?.userId ?? null,
      });
    }
    const item = await readItemForMove(branchId, request.stockItemId, session);
    const date = input.date ?? istDate(clock.now());

    const expense = await createExpense(
      branchId,
      {
        date,
        category: 'material_purchase',
        note: `${formatQty(input.quantity, item.usageUnit)} ${item.name}`,
        payee: input.payee,
        total: input.total,
        mode: input.mode,
        reference: input.reference,
        gst: input.gst,
        attachments: input.attachments,
        link: null,
      },
      actor,
      { storage, session, source: 'purchase', sourceRef: String(request._id) },
    );
    const { movement } = await moveStock(
      branchId,
      {
        stockItemId: item._id,
        type: 'purchase_in',
        quantity: input.quantity,
        cost: expenseCost(expense),
        refs: { purchaseRequestId: request._id, expenseId: expense._id },
      },
      actor,
      session,
    );

    // Oldest need first, while the delivery lasts.
    const waiting = await waitingNeeds(request, session);
    let free = movement.onHandAfter - movement.reservedAfter;
    const unmet = [];
    const touched = new Set();
    for (const entry of waiting) {
      const { need, doc, line, want } = entry;
      const take = Math.min(want, free);
      need.reservedOnReceipt = take;
      if (take > 0) {
        await moveStock(
          branchId,
          {
            stockItemId: item._id,
            type: 'reserve',
            quantity: take,
            refs: { garmentId: need.garmentId, orderId: need.orderId, purchaseRequestId: request._id },
          },
          actor,
          session,
        );
        line.reserved += take;
        free -= take;
        touched.add(doc);
      }
      if (want > take) unmet.push({ need, quantity: want - take });
    }
    for (const doc of touched) {
      doc.updatedBy = actor?.userId ?? null;
      doc.increment();
      await doc.save({ session });
    }

    // The received request keeps the needs it served (what undo gives back).
    request.needs = request.needs.filter((n) => n.reservedOnReceipt > 0);
    for (const n of request.needs) n.quantity = n.reservedOnReceipt;
    request.set({
      status: 'received',
      receipt: {
        quantity: input.quantity,
        value: movement.valueChange,
        expenseId: expense._id,
        movementId: movement._id,
        date,
        at: clock.now(),
        by: actor?.userId ?? null,
      },
    });
    const saved = await saveRequest(request, actor, session);
    // Saved first, so a shortfall request being received is no longer the open one.
    for (const { need, quantity } of unmet) {
      await addShortfall(branchId, { stockItemId: item._id, garment: garmentOf(need), quantity }, session);
    }
    const stored = await readItemForMove(branchId, item._id, session);
    return { request: saved, item: stored, expense };
  });
}

/**
 * Undoes a received delivery at `version` with a reason, while it is still the item's latest
 * change of quantity or value (else 422 RECEIPT_USED): the reservations it made go back, its
 * stock and value come out again, its expense is voided (month lock applies) and the request is
 * ordered again with its garments still waiting on it. Audited.
 */
export function undoReceipt(branchId, id, { version, patch: { reason } }, actor) {
  return withTransaction(async (session) => {
    const request = await loadForWrite(branchId, id, version, session);
    if (request.status !== 'received' || !request.receipt) throw invalidStatus();
    const { receipt } = request;
    const item = await readItemForMove(branchId, request.stockItemId, session);
    if (String(item.lastValueMovementId) !== String(receipt.movementId)) {
      throw businessRule('RECEIPT_USED', 'Some of this delivery has been used or counted. Count the stock instead.');
    }
    const before = { status: request.status, receipt: request.toObject().receipt };

    const waiting = await waitingNeeds(request, session);
    for (const { need, doc, line } of waiting) {
      const back = line ? Math.min(need.reservedOnReceipt, line.reserved) : 0;
      need.reservedOnReceipt = 0;
      if (back <= 0) continue;
      await moveStock(
        branchId,
        {
          stockItemId: item._id,
          type: 'release',
          quantity: back,
          refs: { garmentId: need.garmentId, orderId: need.orderId, purchaseRequestId: request._id },
        },
        actor,
        session,
      );
      line.reserved -= back;
      doc.updatedBy = actor?.userId ?? null;
      doc.increment();
      await doc.save({ session });
    }
    await moveStock(
      branchId,
      {
        stockItemId: item._id,
        type: 'purchase_in',
        quantity: -receipt.quantity,
        cost: receipt.value,
        refs: { purchaseRequestId: request._id, expenseId: receipt.expenseId },
        reason,
      },
      actor,
      session,
    );
    const expense = await getExpense(branchId, String(receipt.expenseId), session);
    await voidExpense(
      branchId,
      String(receipt.expenseId),
      { version: expense.__v, patch: { reason: `Delivery undone: ${reason}` } },
      actor,
      { session, fromStock: true },
    );

    request.set({ status: 'ordered', receipt: null });
    const saved = await saveRequest(request, actor, session);
    await recordAudit(
      {
        branchId,
        entityType: 'purchase_request',
        entityId: request._id,
        action: 'undo_receipt',
        before,
        after: { status: 'ordered', receipt: null, reason },
        actor,
      },
      session,
    );
    const stored = await readItemForMove(branchId, item._id, session);
    return { request: saved, item: stored };
  });
}
