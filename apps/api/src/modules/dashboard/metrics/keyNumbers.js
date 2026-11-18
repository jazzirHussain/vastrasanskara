// Key numbers about orders: active orders, orders placed in the period and the on-time rate.
// (The money key numbers are registered in metrics/money.js.)
import { onTimeRate } from '@vs/shared/dashboard.js';
import { displayDate } from '@vs/shared/fy.js';
import { countOrdersByStatus, garmentsReadyBetween, listOrdersByStatus, listOrdersPlaced, orderCounts } from '../../orders/service.js';
import { orderFilters } from '../filters.js';
import { pageArray, registerMetric } from './index.js';
import { orderRow } from './rows.js';

registerMetric({
  id: 'active_orders',
  async figure(ctx) {
    return { count: await countOrdersByStatus(ctx.branchId, ctx.user, 'active', orderFilters(ctx)) };
  },
  async rows(ctx, page) {
    const out = await listOrdersByStatus(ctx.branchId, ctx.user, 'active', orderFilters(ctx), page);
    return { items: out.items.map(orderRow), nextCursor: out.nextCursor };
  },
});

registerMetric({
  id: 'orders_placed',
  async figure(ctx) {
    const { placed, byPriority } = await orderCounts(ctx.branchId, ctx.user, { ...ctx.range, ...orderFilters(ctx) });
    return { count: placed, rush: byPriority.rush };
  },
  async rows(ctx, { cursor, limit } = {}) {
    const out = await listOrdersPlaced(ctx.branchId, ctx.user, { ...ctx.range, ...orderFilters(ctx), cursor, limit });
    return { items: out.items.map(orderRow), nextCursor: out.nextCursor };
  },
});

/** Garments ready in the context's range that pass its filters (memoised per range). */
export const readyGarments = (ctx, { byDesigner = true } = {}) =>
  ctx.memo(`ready:${byDesigner}`, () => garmentsReadyBetween(ctx.branchId, ctx.user, { ...ctx.range, ...orderFilters(ctx, { byDesigner }) }));

export const readyRow = (g) => ({
  id: g.garmentId,
  title: g.garmentNo,
  subtitle: `${g.orderNo} · due ${displayDate(g.dueDate)}`,
  date: g.readyDate,
  badge: g.onTime ? 'On time' : 'Late',
  link: `/orders/${g.orderId}`,
});

registerMetric({
  id: 'on_time',
  async figure(ctx) {
    const { items, truncated } = await readyGarments(ctx);
    const { ready, onTime, rate } = onTimeRate(items);
    return { count: ready, onTime, rate, truncated };
  },
  async rows(ctx, page) {
    const { items } = await readyGarments(ctx);
    return pageArray(items.map(readyRow), page);
  },
});
