import mongoose from 'mongoose';
import { mulDivRound } from '@vs/shared/money.js';
import { costAtAverage } from '@vs/shared/stock.js';
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

/** Garment numbers by garment id (from the stock module's own materials documents), for the history. */
export async function garmentNumbers(garmentIds) {
  const ids = [...new Set(garmentIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const docs = await GarmentMaterials.find({ garmentId: { $in: ids.map(oid) } }, { garmentId: 1, garmentNo: 1 }).lean();
  return new Map(docs.map((d) => [String(d.garmentId), d.garmentNo]));
}

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

// --- Costing and report data (money: only for costing.view routes and M8 reports) ---------------

/** The find filter of the garments' consume movements (exported for the index test; by_garment). */
// `$type` lets the planner use the partial index.
export const garmentConsumeFilter = (garmentIds) => ({ garmentId: { $in: garmentIds.map(oid), $type: 'objectId' }, type: 'consume' });

/** The find filter of the bills' sale movements (exported for the index test; by_invoice, `$type` for its partial filter). */
export const invoiceSalesFilter = (invoiceIds) => ({ invoiceId: { $in: invoiceIds.map(oid), $type: 'objectId' }, type: 'sale' });

/** Paise of stock sold on the bills, net of sales put back by a cancellation (−Σ valueChange). */
export async function saleCostForInvoices(branchId, invoiceIds, session) {
  if (!invoiceIds.length) return 0;
  const moves = await StockMovement.find({ ...invoiceSalesFilter(invoiceIds), branchId: oid(branchId) }, { valueChange: 1 })
    .session(session ?? null)
    .lean();
  return moves.reduce((sum, m) => sum - m.valueChange, 0);
}

/** The find filter of consume and sale movements in an IST date range (exported for the index test; by_date). */
export const movementDateFilter = (branchId, { from, to }) => ({
  branchId: oid(branchId),
  date: { $gte: from, $lte: to },
  type: { $in: ['consume', 'sale'] },
});

const itemsById = async (ids, fields, session) =>
  new Map(
    (await StockItem.find({ _id: { $in: ids } }, fields).session(session ?? null).lean()).map((it) => [String(it._id), it]),
  );

/**
 * What each garment's materials cost: a Map of garment id to { cost, lines: [{ stockItemId, name,
 * usageUnit, quantity, cost }] }, net of put-backs (cost = −Σ valueChange of its consume movements).
 * Every requested garment has an entry; lines whose net quantity and cost are both 0 are left out.
 */
export async function materialCostForGarments(branchId, garmentIds, session) {
  const result = new Map(garmentIds.map((id) => [String(id), { cost: 0, lines: [] }]));
  if (!garmentIds.length) return result;
  const moves = await StockMovement.find(
    { ...garmentConsumeFilter(garmentIds), branchId: oid(branchId) },
    { garmentId: 1, stockItemId: 1, quantity: 1, valueChange: 1 },
  )
    .sort({ at: 1, _id: 1 })
    .session(session ?? null)
    .lean();
  const items = await itemsById([...new Set(moves.map((m) => String(m.stockItemId)))], { name: 1, usageUnit: 1 }, session);
  const lineOf = new Map();
  for (const m of moves) {
    const entry = result.get(String(m.garmentId));
    if (!entry) continue;
    const key = `${m.garmentId}:${m.stockItemId}`;
    let line = lineOf.get(key);
    if (!line) {
      const it = items.get(String(m.stockItemId));
      line = { stockItemId: String(m.stockItemId), name: it?.name ?? '', usageUnit: it?.usageUnit ?? '', quantity: 0, cost: 0 };
      lineOf.set(key, line);
      entry.lines.push(line);
    }
    line.quantity += m.quantity;
    line.cost -= m.valueChange;
    entry.cost -= m.valueChange;
  }
  for (const entry of result.values()) entry.lines = entry.lines.filter((l) => l.quantity !== 0 || l.cost !== 0);
  return result;
}

/** Quantity and cost of each item consumed on garments or sold on bills in the date range (one aggregate). */
function consumedAndSold(branchId, range) {
  return StockMovement.aggregate([
    { $match: movementDateFilter(branchId, range) },
    { $group: { _id: '$stockItemId', quantity: { $sum: '$quantity' }, value: { $sum: '$valueChange' } } },
  ]);
}

/**
 * Profit per stock item over an IST date range (spec §9.2): what was consumed or sold, its cost,
 * and its worth at the item's selling price (`sales = quantity × sellingPrice`, per usage unit);
 * items without a selling price answer sales and profit null. By name.
 */
export async function stockItemProfit(branchId, { from, to }) {
  const rows = await consumedAndSold(branchId, { from, to });
  const items = await itemsById(rows.map((r) => r._id), { name: 1, sellingPrice: 1 });
  return rows
    .map((r) => {
      const it = items.get(String(r._id));
      const cost = -r.value;
      const price = it?.sellingPrice ?? null;
      const sales = price === null ? null : mulDivRound(r.quantity, price, 1000);
      return { stockItemId: String(r._id), name: it?.name ?? '', quantity: r.quantity, cost, sales, profit: sales === null ? null : sales - cost };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.stockItemId.localeCompare(b.stockItemId));
}

/** Paise of materials consumed on garments and sold on bills in the IST date range (spec §9.1 tile 11). */
export async function materialCostTotal(branchId, { from, to }) {
  const rows = await consumedAndSold(branchId, { from, to });
  return rows.reduce((sum, r) => sum - r.value, 0);
}

/**
 * The stock on the shelves at its value (spec §9.1 tile 7, valuation register): the branch's items
 * holding stock, by name, with `value` and the value of what is reserved for orders.
 */
export async function stockValuation(branchId) {
  const items = await StockItem.find(
    { branchId: oid(branchId), onHand: { $gt: 0 } },
    { name: 1, usageUnit: 1, onHand: 1, reserved: 1, value: 1, avgCost: 1, searchName: 1 },
  )
    .sort({ searchName: 1, _id: 1 })
    .lean();
  const rows = items.map((it) => ({
    stockItemId: String(it._id),
    name: it.name,
    usageUnit: it.usageUnit,
    onHand: it.onHand,
    reserved: it.reserved,
    avgCost: it.avgCost,
    value: it.value,
    reservedValue: costAtAverage(it.avgCost, it.reserved),
  }));
  return {
    value: rows.reduce((s, r) => s + r.value, 0),
    reservedValue: rows.reduce((s, r) => s + r.reservedValue, 0),
    items: rows,
  };
}
