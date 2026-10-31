import mongoose from 'mongoose';
import { notFound } from '../../core/errors.js';
import { paginate } from '../../core/pagination.js';
import { StockItem, StockMovement } from './model.js';

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
