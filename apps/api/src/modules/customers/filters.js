// Customer-type filters for the M8 dashboard and reports (Decision 7). Re-exported by service.js.
// Orders and documents carry no customer type, so a type becomes a list of customer ids:
// business and film customers are few, so they are listed; `individual` lists who to leave out.
import mongoose from 'mongoose';
import { businessRule } from '../../core/errors.js';
import { Customer } from './model.js';

export const MAX_TYPE_FILTER_IDS = 5000;
const OTHER_TYPES = ['business', 'film_production'];

/** The find filter behind customerIdsOfType (`by_type`; exported for the index test). */
export function customerTypeFilter(branchId, type) {
  const branch = new mongoose.Types.ObjectId(String(branchId));
  return type === 'individual' ? { branchId: branch, type: { $in: OTHER_TYPES } } : { branchId: branch, type };
}

/**
 * `{ in: ids }` for business or film customers, `{ notIn: ids }` (the business and film ones) for
 * individuals. More than `cap` ids is a 422 FILTER_TOO_BROAD.
 */
export async function customerIdsOfType(branchId, type, { cap = MAX_TYPE_FILTER_IDS } = {}) {
  const rows = await Customer.find(customerTypeFilter(branchId, type), { _id: 1 }).limit(cap + 1).lean();
  if (rows.length > cap) throw businessRule('FILTER_TOO_BROAD', 'Too many customers for this filter');
  const ids = rows.map((r) => r._id);
  return type === 'individual' ? { notIn: ids } : { in: ids };
}
