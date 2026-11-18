// The dashboard context: the date range and its comparison period, the filters, the user's scope,
// and the reads several metrics share, memoised for one request.
import { createHash } from 'node:crypto';
import { MAX_LIVE_RANGE_DAYS, comparisonRange, presetRange } from '@vs/shared/dashboard.js';
import { daysBetween } from '@vs/shared/billing.js';
import { businessRule } from '../../core/errors.js';
import { customerIdsOfType } from '../customers/service.js';
import { listProductionGarments } from '../production/service.js';

function keepsCustomer(customerFilter, customerId) {
  if (customerFilter?.in) return customerFilter.in.some((id) => String(id) === String(customerId));
  if (customerFilter?.notIn) return !customerFilter.notIn.some((id) => String(id) === String(customerId));
  return true;
}

/**
 * ctx = { branchId, user, today, preset, range, previous, designerId, priority, customerType,
 * customerFilter, money, fresh, scopeKey, memo(key, fn), openGarments({ byDesigner }), atRange(range) }.
 * A range longer than 400 days is a 422 RANGE_TOO_LONG.
 */
export async function buildContext(user, query, { today }) {
  const preset = query.preset ?? 'month';
  const range = presetRange(preset, today, query);
  if (daysBetween(range.from, range.to) + 1 > MAX_LIVE_RANGE_DAYS) {
    throw businessRule('RANGE_TOO_LONG', `Choose a period of ${MAX_LIVE_RANGE_DAYS} days or less`);
  }
  const branchId = String(user.branchId);
  const customerFilter = query.customerType ? await customerIdsOfType(branchId, query.customerType) : undefined;
  // What a figure can depend on: the branch, who is asking (scope and permissions) and the query.
  const scope = user.permissions.has('orders.read.all') ? 'all' : `user:${user.id}`;
  const perms = [...user.permissions].sort().join(',');
  const scopeKey = createHash('sha1')
    .update([branchId, scope, perms, preset, range.from, range.to, query.designerId ?? '', query.priority ?? '', query.customerType ?? ''].join('|'))
    .digest('hex');

  const memos = new Map();
  const memo = (key, fn) => {
    if (!memos.has(key)) memos.set(key, Promise.resolve().then(fn));
    return memos.get(key);
  };
  const ctx = {
    branchId,
    user,
    today,
    preset,
    range,
    previous: comparisonRange({ preset, ...range }),
    designerId: query.designerId,
    priority: query.priority,
    customerType: query.customerType,
    customerFilter,
    money: user.permissions.has('money.view'),
    fresh: query.fresh === '1',
    scopeKey,
    memo,
    /** Open garments in scope, filtered by priority and customer type (and the designer, unless `byDesigner: false`). */
    openGarments({ byDesigner = true } = {}) {
      return memo(`open:${byDesigner}`, async () => {
        const { items, truncated } = await listProductionGarments(branchId, user, { designerId: byDesigner ? query.designerId : undefined });
        const kept = items.filter((i) => (!query.priority || i.order.priority === query.priority) && keepsCustomer(customerFilter, i.order.customerId));
        return { items: kept, truncated };
      });
    },
    /** The same context over another range (the comparison period), sharing nothing range-bound. */
    atRange(other) {
      const shifted = Object.create(ctx);
      const own = new Map();
      shifted.range = other;
      shifted.memo = (key, fn) => {
        if (!own.has(key)) own.set(key, Promise.resolve().then(fn));
        return own.get(key);
      };
      return shifted;
    },
  };
  return ctx;
}

/** The order filters of a context, as the orders module takes them. */
export const orderFilters = (ctx, { byDesigner = true } = {}) => ({
  designerId: byDesigner ? ctx.designerId : undefined,
  priority: ctx.priority,
  customerFilter: ctx.customerFilter,
});
