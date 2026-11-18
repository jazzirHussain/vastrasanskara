// Production board, upcoming pickups and workload: all from the open garments read once per request.
import { onTimeRate } from '@vs/shared/dashboard.js';
import { addDaysYmd } from '@vs/shared/fy.js';
import { STAGE_KEYS } from '@vs/shared/stages.js';
import { orderPaymentStatuses } from '../../billing/service.js';
import { pageArray, registerMetric } from './index.js';
import { readyGarments } from './keyNumbers.js';
import { garmentRow, stageLabel } from './rows.js';

// Materials ready through Ready for pickup, as the production board shows them.
const BOARD_STAGES = STAGE_KEYS.slice(1, 13);
export const PICKUP_DAYS = 14;
const NEXT_PICKUPS = 5;
const STATUS_CHUNK = 200;

registerMetric({
  id: 'stage_garments',
  async figure(ctx) {
    const { items, truncated } = await ctx.openGarments();
    const stages = new Map(BOARD_STAGES.map((key) => [key, { key, label: stageLabel(key), inHouse: 0, withVendor: 0, late: 0, count: 0 }]));
    for (const i of items) {
      const s = stages.get(i.workingStage);
      if (!s) continue;
      if (i.garment.stageState === 'with_vendor') s.withVendor += 1;
      else s.inHouse += 1;
      if (i.late) s.late += 1;
      s.count += 1;
    }
    const breakdown = [...stages.values()];
    return { count: breakdown.reduce((n, s) => n + s.count, 0), breakdown, truncated };
  },
  async rows(ctx, { key, ...page } = {}) {
    const { items } = await ctx.openGarments();
    return pageArray(items.filter((i) => BOARD_STAGES.includes(i.workingStage) && (!key || i.workingStage === key)).map(garmentRow), page);
  },
});

/** Orders with open garments picking up in the next 14 days, soonest first. */
async function pickups(ctx) {
  const { items, truncated } = await ctx.openGarments();
  const last = addDaysYmd(ctx.today, PICKUP_DAYS);
  const byOrder = new Map();
  for (const i of items) {
    const { order, garment } = i;
    if (order.pickupDate < ctx.today || order.pickupDate > last) continue;
    const p = byOrder.get(String(order._id)) ?? {
      orderId: String(order._id), orderNo: order.orderNo, customerName: i.customerName ?? '', pickupDate: order.pickupDate, garments: 0, ready: 0,
    };
    p.garments += 1;
    if (garment.status === 'ready') p.ready += 1;
    byOrder.set(p.orderId, p);
  }
  const list = [...byOrder.values()].sort((a, b) => a.pickupDate.localeCompare(b.pickupDate) || a.orderNo.localeCompare(b.orderNo));
  return { list, truncated };
}

/** Adds `payment: { status, balance }` to pickups, for money users only (200 orders per read). */
async function withPayment(ctx, list) {
  if (!ctx.money || !list.length) return list;
  const statuses = new Map();
  for (let i = 0; i < list.length; i += STATUS_CHUNK) {
    const chunk = await orderPaymentStatuses(ctx.branchId, list.slice(i, i + STATUS_CHUNK).map((p) => p.orderId));
    for (const [id, s] of chunk) statuses.set(id, s);
  }
  return list.map((p) => {
    const s = statuses.get(p.orderId);
    return { ...p, payment: { status: s.status, balance: s.balance } };
  });
}

const PAYMENT_LABELS = { paid: 'Paid', part_paid: 'Part paid', unpaid: 'Unpaid', advance_only: 'Advance taken', nothing_yet: 'Nothing paid' };

registerMetric({
  id: 'upcoming_pickups',
  async figure(ctx) {
    const { list, truncated } = await pickups(ctx);
    return { count: list.length, next: await withPayment(ctx, list.slice(0, NEXT_PICKUPS)), truncated };
  },
  async rows(ctx, page) {
    const { list } = await pickups(ctx);
    const out = pageArray(list, page);
    const items = (await withPayment(ctx, out.items)).map((p) => {
      const row = {
        id: p.orderId,
        title: p.orderNo,
        subtitle: `${p.customerName} · ${p.ready} of ${p.garments} ready`,
        date: p.pickupDate,
        link: `/orders/${p.orderId}`,
      };
      if (p.payment) row.badge = PAYMENT_LABELS[p.payment.status];
      return row;
    });
    return { items, nextCursor: out.nextCursor };
  },
});

registerMetric({
  id: 'workload_designers',
  async figure(ctx) {
    const [{ items, truncated }, ready] = await Promise.all([ctx.openGarments({ byDesigner: false }), readyGarments(ctx, { byDesigner: false })]);
    const byDesigner = new Map();
    const entry = (id, name) => {
      const e = byDesigner.get(id) ?? { key: id, label: name ?? '', count: 0, ready: [] };
      if (name && !e.label) e.label = name;
      byDesigner.set(id, e);
      return e;
    };
    for (const i of items) entry(String(i.order.designerId), i.designerName).count += 1;
    for (const g of ready.items) entry(g.designerId).ready.push(g);
    const breakdown = [...byDesigner.values()]
      .map(({ ready: rows, ...e }) => ({ ...e, onTime: onTimeRate(rows) }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
    return { count: items.length, breakdown, truncated: truncated || ready.truncated };
  },
  async rows(ctx, { key, ...page } = {}) {
    // The bar counts open garments, so its rows are those garments.
    const { items } = await ctx.openGarments({ byDesigner: false });
    return pageArray(items.filter((i) => !key || String(i.order.designerId) === key).map(garmentRow), page);
  },
});

registerMetric({
  id: 'workload_vendors',
  async figure(ctx) {
    const { items, truncated } = await ctx.openGarments();
    const byVendor = new Map();
    for (const i of items) {
      if (i.garment.stageState !== 'with_vendor') continue;
      const id = String(i.garment.vendorWork?.vendorId);
      const v = byVendor.get(id) ?? { key: id, label: i.vendorName ?? '', count: 0, overdue: 0 };
      v.count += 1;
      if (i.garment.vendorWork?.dueBackDate && i.garment.vendorWork.dueBackDate < ctx.today) v.overdue += 1;
      byVendor.set(id, v);
    }
    const breakdown = [...byVendor.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
    return { count: breakdown.reduce((n, v) => n + v.count, 0), breakdown, truncated };
  },
  async rows(ctx, { key, ...page } = {}) {
    const { items } = await ctx.openGarments();
    const withVendor = items.filter((i) => i.garment.stageState === 'with_vendor' && (!key || String(i.garment.vendorWork?.vendorId) === key));
    return pageArray(withVendor.map(garmentRow), page);
  },
});
