// Order and garment figures for the M8 dashboard and reports. Read-only; re-exported by service.js.
// Every function AND-combines a requested `designerId` with `orderScope(user)`, as listOrders
// does, so a designer filter can narrow a designer's view but never widen it.
import mongoose from 'mongoose';
import { isOnTime } from '@vs/shared/dashboard.js';
import { paginate } from '../../core/pagination.js';
import { Garment, Order } from './model.js';
import { orderListItems, orderScope } from './service.js';

const { ObjectId } = mongoose.Types;
const oid = (id) => new ObjectId(String(id));

export const READY_GARMENT_CAP = 5000;
const BATCH = 500;

function customerMatch(customerFilter) {
  if (customerFilter?.in) return { customerId: { $in: customerFilter.in.map(oid) } };
  if (customerFilter?.notIn) return { customerId: { $nin: customerFilter.notIn.map(oid) } };
  return {};
}

/** The order conditions every M8 order figure shares: scope, designer, priority and customer type. */
function orderFilter(branchId, user, { designerId, priority, customerFilter } = {}) {
  return {
    branchId: oid(branchId),
    ...(priority && { priority }),
    ...customerMatch(customerFilter),
    $and: [orderScope(user), designerId ? { designerId: oid(designerId) } : {}],
  };
}

/** Orders placed (by `orderDate`) in [from, to] (`by_order_date`; exported for the index test). */
export function ordersPlacedMatch(branchId, user, { from, to, ...filters }) {
  return { ...orderFilter(branchId, user, filters), orderDate: { $gte: from, $lte: to } };
}

/** Orders with `status` (`branchId, status, pickupDate`; exported for the index test). */
export function ordersByStatusMatch(branchId, user, status, filters = {}) {
  return { ...orderFilter(branchId, user, filters), status };
}

/** Active orders (`branchId, status, pickupDate`; exported for the index test). */
export function activeOrdersMatch(branchId, user, filters = {}) {
  return ordersByStatusMatch(branchId, user, 'active', filters);
}

/** How many orders were placed in [from, to], and how many of them were normal or rush. */
export async function orderCounts(branchId, user, { from, to, ...filters }) {
  const rows = await Order.aggregate([
    { $match: ordersPlacedMatch(branchId, user, { from, to, ...filters }) },
    { $group: { _id: '$priority', count: { $sum: 1 } } },
  ]);
  const of = (p) => rows.find((r) => r._id === p)?.count ?? 0;
  return { placed: of('normal') + of('rush'), byPriority: { normal: of('normal'), rush: of('rush') } };
}

/** One page of the orders placed in [from, to], newest first, as listOrders rows. */
export async function listOrdersPlaced(branchId, user, { from, to, cursor, limit, ...filters }) {
  const page = await paginate(Order, ordersPlacedMatch(branchId, user, { from, to, ...filters }), { sort: ['orderDate', -1], cursor, limit });
  return { items: await orderListItems(branchId, page.items), nextCursor: page.nextCursor };
}

/** How many orders have `status` now. */
export function countOrdersByStatus(branchId, user, status, filters = {}) {
  return Order.countDocuments(ordersByStatusMatch(branchId, user, status, filters));
}

/** One page of the orders with `status`, soonest pickup first, as listOrders rows. */
export async function listOrdersByStatus(branchId, user, status, filters = {}, { cursor, limit } = {}) {
  const page = await paginate(Order, ordersByStatusMatch(branchId, user, status, filters), { sort: ['pickupDate', 1], cursor, limit });
  return { items: await orderListItems(branchId, page.items), nextCursor: page.nextCursor };
}

/** How many orders are active now. */
export function activeOrderCount(branchId, user, filters = {}) {
  return countOrdersByStatus(branchId, user, 'active', filters);
}

/** One page of the orders on hold, soonest pickup first, as listOrders rows. */
export function onHoldOrders(branchId, user, filters = {}, page = {}) {
  return listOrdersByStatus(branchId, user, 'on_hold', filters, page);
}

/** Of the given orders, those that pass the scope and filters: Map orderId → orderNo. */
export async function orderNumbersMatching(branchId, user, orderIds, filters = {}) {
  if (!orderIds.length) return new Map();
  const orders = await Order.find({ ...orderFilter(branchId, user, filters), _id: { $in: orderIds.map(oid) } }, { orderNo: 1 }).lean();
  return new Map(orders.map((o) => [String(o._id), o.orderNo]));
}

/** Garments that became ready in [from, to] and are still ready or picked up (`ready`; exported for the index test). */
export function garmentsReadyFilter(branchId, { from, to }) {
  return { branchId: oid(branchId), readyDate: { $type: 'string', $gte: from, $lte: to }, status: { $in: ['ready', 'picked_up'] } };
}

/**
 * Every garment ready in [from, to] whose order passes the filters, as on-time rows (Decision 18):
 * on time when ready by the garment's original due date, else the order's original pickup date.
 * Streams in batches, so reports can read past the dashboard's cap.
 */
export async function* iterateGarmentsReady(branchId, user, { from, to, ...filters }) {
  const cursor = Garment.find(garmentsReadyFilter(branchId, { from, to }), {
    garmentNo: 1, orderId: 1, readyDate: 1, originalDueDate: 1,
  }).lean().cursor({ batchSize: BATCH });
  let batch = [];
  const flush = async function* flush() {
    const orders = await Order.find(
      { ...orderFilter(branchId, user, filters), _id: { $in: [...new Set(batch.map((g) => String(g.orderId)))].map(oid) } },
      { orderNo: 1, designerId: 1, originalPickupDate: 1 },
    ).lean();
    const byId = new Map(orders.map((o) => [String(o._id), o]));
    for (const g of batch) {
      const order = byId.get(String(g.orderId));
      if (!order) continue;
      const dueDate = g.originalDueDate ?? order.originalPickupDate;
      yield {
        garmentId: String(g._id),
        garmentNo: g.garmentNo,
        orderId: String(order._id),
        orderNo: order.orderNo,
        designerId: String(order.designerId),
        readyDate: g.readyDate,
        dueDate,
        onTime: isOnTime({ readyDate: g.readyDate, originalDueDate: g.originalDueDate, originalPickupDate: order.originalPickupDate }),
      };
    }
    batch = [];
  };
  for await (const g of cursor) {
    batch.push(g);
    if (batch.length >= BATCH) yield* flush();
  }
  if (batch.length) yield* flush();
}

/** Garments ready in [from, to] with `onTime`, capped at 5,000 (`truncated` says more exist). */
export async function garmentsReadyBetween(branchId, user, filters, { cap = READY_GARMENT_CAP } = {}) {
  const items = [];
  for await (const row of iterateGarmentsReady(branchId, user, filters)) {
    if (items.length === cap) return { items, truncated: true };
    items.push(row);
  }
  return { items, truncated: false };
}
