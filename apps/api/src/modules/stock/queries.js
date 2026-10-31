import mongoose from 'mongoose';
import { notFound } from '../../core/errors.js';
import { paginate } from '../../core/pagination.js';
import { GarmentMaterials, StockItem, StockMovement } from './model.js';

const { ObjectId } = mongoose.Types;
const oid = (id) => new ObjectId(String(id));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The find filter of listItems (exported for the index test). Shows items in use unless
 * `active: false` asks for the hidden ones; `q` matches anywhere in the name.
 */
export function itemListFilter(branchId, { q, category, low, active = true } = {}) {
  const filter = { branchId: oid(branchId), active };
  const text = q?.trim().toLowerCase();
  if (text) filter.searchName = { $regex: escapeRegex(text) };
  if (category) filter.category = category;
  if (low !== undefined) filter.low = low;
  return filter;
}

/** One page of the branch's stock items by name. */
export function listItems(branchId, { cursor, limit, ...filters } = {}) {
  return paginate(StockItem, itemListFilter(branchId, filters), { sort: ['searchName', 1], limit, cursor });
}

/** One of the branch's stock items, or 404. */
export async function getItem(branchId, id, session) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const item = await StockItem.findOne({ _id: id, branchId }).session(session ?? null).lean();
  if (!item) throw notFound();
  return item;
}

/** The find filter of listMovements (exported for the index test). */
export const movementFilter = (branchId, itemId) => ({ branchId: oid(branchId), stockItemId: oid(itemId) });

/** One page of an item's movements, newest first. */
export function listMovements(branchId, itemId, { cursor, limit } = {}) {
  return paginate(StockMovement, movementFilter(branchId, itemId), { sort: ['at', -1], limit, cursor });
}

/** The find filter of lowStockItems (exported for the index test). */
export const lowStockFilter = (branchId) => ({ branchId: oid(branchId), low: true, active: true });

/** Items in use whose free stock is below their reorder level, by name. */
export function lowStockItems(branchId, { limit = 50 } = {}) {
  return StockItem.find(lowStockFilter(branchId)).sort({ searchName: 1, _id: 1 }).limit(limit).lean();
}

// --- Garment materials (quantities only: no response built from these carries a cost) -----------

/** The find filter of a garment's materials document (exported for the index test). */
export const garmentMaterialsFilter = (garmentId) => ({ garmentId: oid(garmentId) });

/** The find filter of the item's open shortfall request (exported for the index test). */
export const shortfallFilter = (branchId, stockItemId) => ({
  branchId: oid(branchId),
  stockItemId: oid(stockItemId),
  status: 'requested',
  reason: 'shortfall',
});

/** The find filter of "requested" requests naming any of the garments (exported for the index test). */
export const needsFilter = (branchId, garmentIds) => ({
  'needs.garmentId': { $in: garmentIds.map(oid) },
  branchId: oid(branchId),
  status: 'requested',
});

/**
 * A garment's materials card: lines still planned or used (released ones are history), each
 * with its item's name, unit and step, and `short` (planned − reserved) while planned. A garment
 * without a list answers version 0 and no lines.
 */
export async function garmentMaterialsView(branchId, garmentId, session) {
  const doc = await GarmentMaterials.findOne({ ...garmentMaterialsFilter(garmentId), branchId: oid(branchId) })
    .session(session ?? null)
    .lean();
  const lines = (doc?.lines ?? []).filter((l) => l.state !== 'released');
  const items = lines.length
    ? await StockItem.find({ _id: { $in: lines.map((l) => l.stockItemId) } }, { name: 1, usageUnit: 1, step: 1 }).session(session ?? null).lean()
    : [];
  const byId = new Map(items.map((it) => [String(it._id), it]));
  return {
    garmentId: String(garmentId),
    version: doc?.__v ?? 0,
    lines: lines.map((l) => {
      const it = byId.get(String(l.stockItemId));
      return {
        stockItemId: String(l.stockItemId),
        name: it?.name ?? '',
        usageUnit: it?.usageUnit ?? '',
        step: it?.step ?? 1000,
        planned: l.planned,
        reserved: l.reserved,
        used: l.used,
        state: l.state,
        short: l.state === 'planned' ? l.planned - l.reserved : 0,
      };
    }),
  };
}

const PICKER_LIMIT = 20;

/**
 * The find filter of the item picker (exported for the index test): active items whose name
 * starts with (`prefix`) or contains (`contains`) the text.
 */
export function pickerFilter(branchId, text, mode) {
  const filter = { branchId: oid(branchId), active: true };
  if (text) filter.searchName = { $regex: mode === 'prefix' ? `^${escapeRegex(text)}` : escapeRegex(text) };
  return filter;
}

/**
 * Up to 20 items in use for choosing materials: names starting with `q` first, then names
 * containing it, each by name. Quantities only.
 */
export async function pickerItems(branchId, { q } = {}) {
  const text = q?.trim().toLowerCase() ?? '';
  const fields = { name: 1, brand: 1, colour: 1, usageUnit: 1, step: 1, onHand: 1, reserved: 1, searchName: 1 };
  const find = (filter, limit) => StockItem.find(filter, fields).sort({ searchName: 1, _id: 1 }).limit(limit).lean();
  const items = await find(pickerFilter(branchId, text, 'prefix'), PICKER_LIMIT);
  if (text && items.length < PICKER_LIMIT) {
    const more = await find({ ...pickerFilter(branchId, text, 'contains'), _id: { $nin: items.map((it) => it._id) } }, PICKER_LIMIT - items.length);
    items.push(...more);
  }
  return items.map((it) => ({
    id: String(it._id),
    name: it.name,
    brand: it.brand ?? '',
    colour: it.colour ?? '',
    usageUnit: it.usageUnit,
    step: it.step,
    free: it.onHand - it.reserved,
  }));
}
