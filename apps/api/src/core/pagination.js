import mongoose from 'mongoose';
import { validationError } from './errors.js';

const MAX_LIMIT = 100;
const badCursor = () => validationError([{ path: 'cursor', message: 'Invalid cursor' }]);

// The cursor is the sort value and id of the last item; dates are marked so they round-trip.
function encodeCursor(value, id) {
  const v = value instanceof Date ? { $date: value.toISOString() } : value;
  return Buffer.from(JSON.stringify({ v, id: String(id) })).toString('base64url');
}

/** Reads a cursor from paginate(); a malformed one is a 400. */
export function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    throw badCursor();
  }
  if (!parsed || typeof parsed !== 'object' || !mongoose.isValidObjectId(parsed.id)) throw badCursor();
  const v = parsed.v?.$date ? new Date(parsed.v.$date) : (parsed.v ?? null);
  return { v, id: new mongoose.Types.ObjectId(parsed.id) };
}

/**
 * One page of `filter` sorted by `sort` = [field, 1|-1], ties broken by _id in the same
 * direction so pages never repeat or skip an item. Returns lean items and the cursor of the
 * next page (null on the last page).
 */
export async function paginate(Model, filter, { sort: [field, dir], limit = 25, cursor } = {}) {
  const size = Math.min(Math.max(1, Number(limit) || 25), MAX_LIMIT);
  let query = filter;
  if (cursor) {
    const { v, id } = decodeCursor(cursor);
    const op = dir === 1 ? '$gt' : '$lt';
    query = { $and: [filter, { $or: [{ [field]: { [op]: v } }, { [field]: v, _id: { [op]: id } }] }] };
  }
  const items = await Model.find(query)
    .sort({ [field]: dir, _id: dir })
    .limit(size + 1)
    .lean();
  const more = items.length > size;
  if (more) items.pop();
  const last = items.at(-1);
  return { items, nextCursor: more ? encodeCursor(last[field] ?? null, last._id) : null };
}
