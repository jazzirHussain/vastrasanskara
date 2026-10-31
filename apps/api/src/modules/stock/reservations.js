import mongoose from 'mongoose';
import { workingStage } from '@vs/shared/production.js';
import { stageIndex } from '@vs/shared/stages.js';
import { clock } from '../../clock.js';
import { businessRule, conflict, validationError } from '../../core/errors.js';
import { moveStock, readItemForMove } from './ledger.js';
import { GarmentMaterials, PurchaseRequest, StockItem } from './model.js';
import { garmentMaterialsFilter, needsFilter, shortfallFilter } from './queries.js';

const { ObjectId } = mongoose.Types;
const oid = (id) => new ObjectId(String(id));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const NO_LONGER_NEEDED = 'No longer needed';
const LIVE_GARMENT = ['in_progress', 'ready'];

/** 422 INVALID_STATUS unless the garment is still being made or waiting for pickup. */
function assertLive(garment) {
  if (!garment.live) throw businessRule('INVALID_STATUS', 'This garment cannot be changed in its current status');
}

/**
 * The plain garment facts the stock functions take: { garmentId, orderId, garmentNo, live,
 * afterMaterialsReady } (Materials ready is done or skipped once the garment works on a later stage;
 * a live garment is still being made or waiting for pickup).
 */
export function garmentFacts(garment) {
  return {
    garmentId: garment._id,
    orderId: garment.orderId,
    garmentNo: garment.garmentNo,
    live: LIVE_GARMENT.includes(garment.status),
    afterMaterialsReady: stageIndex(workingStage(garment)) > stageIndex('materials_ready'),
  };
}

const chooseItem = (i) => ({ path: `materials.${i}.stockItemId`, message: 'Choose an item from stock' });

/**
 * The branch's items for `lines`, as a Map by id string. Each line's item must exist; it must be
 * in use (active) unless `mayBeInactive(line)` says otherwise. 400 on `materials.<i>.stockItemId`.
 */
async function itemsFor(branchId, lines, session, mayBeInactive = () => false) {
  const ids = [...new Set(lines.map((l) => String(l.stockItemId).toLowerCase()))];
  const items = ids.length ? await StockItem.find({ _id: { $in: ids.map(oid) }, branchId }).session(session).lean() : [];
  const byId = new Map(items.map((it) => [String(it._id), it]));
  const issues = [];
  for (const [i, l] of lines.entries()) {
    const it = byId.get(String(l.stockItemId).toLowerCase());
    if (!it || (!it.active && !mayBeInactive(l))) issues.push(chooseItem(i));
  }
  if (issues.length) throw validationError(issues);
  return byId;
}

const needOf = (garment, quantity) => ({
  garmentId: garment.garmentId,
  garmentNo: garment.garmentNo,
  orderId: garment.orderId,
  quantity,
});

/**
 * Adds `quantity` for the garment to the item's open ("requested") shortfall request, or opens
 * one. A garment already waiting on that request has its need increased.
 */
export async function addShortfall(branchId, { stockItemId, garment, quantity }, session) {
  if (quantity <= 0) return;
  const request = await PurchaseRequest.findOne(shortfallFilter(branchId, stockItemId)).session(session);
  if (!request) {
    await PurchaseRequest.create(
      [{ branchId, stockItemId, quantity, reason: 'shortfall', needs: [needOf(garment, quantity)] }],
      { session },
    );
    return;
  }
  const need = request.needs.find((n) => same(n.garmentId, garment.garmentId));
  if (need) need.quantity += quantity;
  else request.needs.push(needOf(garment, quantity));
  request.quantity += quantity;
  await request.save({ session });
}

function cancelIfEmpty(request) {
  if (request.needs.length || request.reason !== 'shortfall') return;
  request.status = 'cancelled';
  request.cancellation = { reason: NO_LONGER_NEEDED, at: clock.now(), by: null };
}

/**
 * Takes up to `quantity` off one garment's need for an item on "requested" requests (what was
 * already ordered stays ordered). A shortfall request left with no needs is cancelled.
 */
async function reduceNeed(branchId, { stockItemId, garmentId }, quantity, session) {
  let left = quantity;
  const requests = await PurchaseRequest.find({ ...needsFilter(branchId, [garmentId]), stockItemId: oid(stockItemId) }).session(session);
  for (const request of requests) {
    if (left <= 0) break;
    const need = request.needs.find((n) => same(n.garmentId, garmentId));
    const take = Math.min(left, need.quantity);
    need.quantity -= take;
    request.quantity -= take;
    left -= take;
    request.needs = request.needs.filter((n) => n.quantity > 0);
    cancelIfEmpty(request);
    if (request.status === 'cancelled') request.quantity = Math.max(request.quantity, 1);
    await request.save({ session });
  }
}

/**
 * Removes the garments' needs (for one item when `stockItemId` is given) from "requested"
 * requests. A shortfall request left with no needs is cancelled ("No longer needed").
 */
export async function dropNeeds(branchId, garmentIds, session, { stockItemId } = {}) {
  if (!garmentIds.length) return;
  const filter = { ...needsFilter(branchId, garmentIds), ...(stockItemId && { stockItemId: oid(stockItemId) }) };
  const requests = await PurchaseRequest.find(filter).session(session);
  const dropped = new Set(garmentIds.map(String));
  for (const request of requests) {
    const removed = request.needs.filter((n) => dropped.has(String(n.garmentId)));
    const keep = request.needs.filter((n) => !dropped.has(String(n.garmentId)));
    request.needs = keep;
    // The request keeps any quantity asked for on top of the needs.
    request.quantity = Math.max(1, request.quantity - removed.reduce((sum, n) => sum + n.quantity, 0));
    cancelIfEmpty(request);
    await request.save({ session });
  }
}

/**
 * Reserves up to `quantity` of the item for the garment from free stock and asks for the rest
 * (never fails on a shortfall). Answers what was reserved.
 */
async function reserveOrRequest(branchId, stockItemId, garment, quantity, actor, session) {
  const item = await readItemForMove(branchId, stockItemId, session);
  const take = Math.max(0, Math.min(quantity, item.onHand - item.reserved));
  if (take > 0) {
    await moveStock(
      branchId,
      { stockItemId, type: 'reserve', quantity: take, refs: { garmentId: garment.garmentId, orderId: garment.orderId } },
      actor,
      session,
    );
  }
  await addShortfall(branchId, { stockItemId, garment, quantity: quantity - take }, session);
  return take;
}

async function release(branchId, stockItemId, garment, quantity, actor, session) {
  if (quantity <= 0) return;
  await moveStock(
    branchId,
    { stockItemId, type: 'release', quantity, refs: { garmentId: garment.garmentId, orderId: garment.orderId } },
    actor,
    session,
  );
}

/**
 * Lists materials on new garments (each `{ ...facts, materials: [{ stockItemId, quantity }] }`):
 * one GarmentMaterials document per garment with materials, each line reserved from free stock
 * and any shortfall asked for. Every item must be in use (400 `materials.<i>.stockItemId`).
 */
export async function planNewGarments(branchId, garments, actor, session) {
  const planned = garments.filter((g) => g.materials?.length);
  for (const g of planned) await itemsFor(branchId, g.materials, session);
  for (const g of planned) {
    const lines = [];
    for (const { stockItemId, quantity } of g.materials) {
      const reserved = await reserveOrRequest(branchId, stockItemId, g, quantity, actor, session);
      lines.push({ stockItemId: oid(stockItemId), planned: quantity, reserved, state: 'planned' });
    }
    await GarmentMaterials.create(
      [
        {
          branchId,
          orderId: g.orderId,
          garmentId: g.garmentId,
          garmentNo: g.garmentNo,
          lines,
          createdBy: actor?.userId ?? null,
          updatedBy: actor?.userId ?? null,
        },
      ],
      { session },
    );
  }
}

const materialsAlreadyUsed = () =>
  businessRule('MATERIALS_ALREADY_USED', 'Materials for this garment are already used. Use "Used more" or "Put back".');

/**
 * Replaces a garment's planned materials at `version` (409 when someone saved first; a garment
 * without a list is at version 0). Before Materials ready: a new line is reserved (shortfall
 * asked for); more of a line reserves the extra; less releases down to the new amount and asks
 * for less; a line left out is released, its request dropped, and kept as `released` for
 * history. After Materials ready: 422 MATERIALS_ALREADY_USED. A rejected, cancelled or picked-up
 * garment: 422 INVALID_STATUS. Answers the stored document.
 */
export async function setGarmentMaterials(branchId, garment, { version, lines }, actor, session) {
  assertLive(garment);
  if (garment.afterMaterialsReady) throw materialsAlreadyUsed();
  let doc = await GarmentMaterials.findOne(garmentMaterialsFilter(garment.garmentId)).session(session);
  if ((doc?.__v ?? 0) !== version) throw conflict();
  if (!doc) {
    doc = new GarmentMaterials({
      branchId,
      orderId: garment.orderId,
      garmentId: garment.garmentId,
      garmentNo: garment.garmentNo,
      lines: [],
      createdBy: actor?.userId ?? null,
    });
  }

  const current = (id, states) => doc.lines.find((l) => same(l.stockItemId, id) && states.includes(l.state));
  // An item already planned may stay (or shrink) even if it is no longer in use.
  await itemsFor(branchId, lines, session, (l) => {
    const existing = current(l.stockItemId, ['planned', 'used']);
    return existing && l.quantity <= existing.planned;
  });
  for (const l of lines) {
    const used = current(l.stockItemId, ['used']);
    if (used && l.quantity !== used.planned) throw materialsAlreadyUsed();
  }

  const wanted = new Map(lines.map((l) => [String(l.stockItemId).toLowerCase(), l.quantity]));
  for (const line of doc.lines.filter((l) => l.state === 'planned')) {
    const id = line.stockItemId;
    const quantity = wanted.get(String(id));
    if (quantity === undefined) {
      await release(branchId, id, garment, line.reserved, actor, session);
      await dropNeeds(branchId, [garment.garmentId], session, { stockItemId: id });
      line.reserved = 0;
      line.state = 'released';
    } else if (quantity > line.planned) {
      line.reserved += await reserveOrRequest(branchId, id, garment, quantity - line.planned, actor, session);
      line.planned = quantity;
    } else if (quantity < line.planned) {
      if (line.reserved > quantity) {
        // Now fully reserved, so nothing is still asked for: the whole need goes (no reduceNeed).
        await release(branchId, id, garment, line.reserved - quantity, actor, session);
        await dropNeeds(branchId, [garment.garmentId], session, { stockItemId: id });
        line.reserved = quantity;
      } else {
        await reduceNeed(branchId, { stockItemId: id, garmentId: garment.garmentId }, line.planned - quantity, session);
      }
      line.planned = quantity;
    }
  }
  for (const { stockItemId, quantity } of lines) {
    if (current(stockItemId, ['planned', 'used'])) continue;
    const reserved = await reserveOrRequest(branchId, stockItemId, garment, quantity, actor, session);
    doc.lines.push({ stockItemId: oid(stockItemId), planned: quantity, reserved, state: 'planned' });
  }

  doc.updatedBy = actor?.userId ?? null;
  if (!doc.isNew) doc.increment();
  else doc.__v = 1;
  await doc.save({ session });
  return doc.toObject();
}

/**
 * Puts back every planned (not yet used) material of the garments: each reservation released,
 * the line `released`, and the garments' needs dropped from "requested" requests. Used materials
 * stay used.
 */
export async function releaseGarments(branchId, garmentIds, actor, session) {
  if (!garmentIds.length) return;
  const docs = await GarmentMaterials.find({ garmentId: { $in: garmentIds.map(oid) } }).session(session);
  for (const doc of docs) {
    const facts = { garmentId: doc.garmentId, orderId: doc.orderId };
    let changed = false;
    for (const line of doc.lines.filter((l) => l.state === 'planned')) {
      await release(branchId, line.stockItemId, facts, line.reserved, actor, session);
      line.reserved = 0;
      line.state = 'released';
      changed = true;
    }
    if (changed) {
      doc.updatedBy = actor?.userId ?? null;
      doc.increment();
      await doc.save({ session });
    }
  }
  await dropNeeds(branchId, garmentIds, session);
}

/**
 * A remake gets the rejected garment's materials: the source's planned and used lines (their
 * planned quantities) become the new garment's plan. The source is released first, so its
 * reservation can serve the remake.
 */
export async function copyGarmentMaterials(branchId, fromGarmentId, toGarment, actor, session) {
  const source = await GarmentMaterials.findOne(garmentMaterialsFilter(fromGarmentId)).session(session).lean();
  const materials = (source?.lines ?? [])
    .filter((l) => l.state === 'planned' || l.state === 'used')
    .map((l) => ({ stockItemId: l.stockItemId, quantity: l.planned }))
    .filter((l) => l.quantity > 0);
  await releaseGarments(branchId, [fromGarmentId], actor, session);
  // Items no longer in use are left off the remake rather than refusing the rejection.
  const active = materials.length
    ? new Set((await StockItem.find({ _id: { $in: materials.map((m) => m.stockItemId) }, branchId, active: true }, { _id: 1 })
      .session(session).lean()).map((it) => String(it._id)))
    : new Set();
  await planNewGarments(branchId, [{ ...toGarment, materials: materials.filter((m) => active.has(String(m.stockItemId))) }], actor, session);
}
