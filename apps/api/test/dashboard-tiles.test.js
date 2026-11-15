import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { addDaysYmd, isGarmentLate, permissionsFor } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { dashboardHelpers } from './helpers/dashboard.js';
import { Garment, Order } from '../src/modules/orders/model.js';
import { clearDashboardCache } from '../src/modules/dashboard/cache.js';
import { metricDef } from '../src/modules/dashboard/metrics/index.js';
import { buildContext } from '../src/modules/dashboard/filters.js';
import { logger } from '../src/logger.js';

useTestDb();
const app = buildTestApp();
const { dashboardWorld } = dashboardHelpers(app);

beforeEach(() => clearDashboardCache());
afterEach(() => vi.restoreAllMocks());

const home = async (who, query = {}) => {
  const r = await who.agent.get('/v1/dashboard').query(query);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const metric = (body, tile, id) => body.tiles[tile]?.metrics?.[id];
const userOf = (login) => ({ id: String(login.user._id), branchId: String(login.user.branchId), permissions: new Set(permissionsFor(login.user.roles)) });
const allRows = async (id, ctx, extra = {}) => {
  const items = [];
  let cursor;
  do {
    const page = await metricDef(id).rows(ctx, { cursor, limit: 2, ...extra });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
};

/** Whether the vendor garment is late by its own stage plan (the world does not fix that). */
async function vendorGarmentLate(world) {
  const g = await Garment.findById(world.orders.vendorOrder.garments[0].id).lean();
  const o = await Order.findById(world.orders.vendorOrder.id).lean();
  return isGarmentLate(g, o, world.TODAY);
}

test('Home shows the attention list with late, at-risk, vendor-overdue and QC-failed garments', async () => {
  const w = await dashboardWorld();
  const body = await home(w.admin);
  const vendorLate = (await vendorGarmentLate(w)) ? 1 : 0;
  expect(metric(body, 'attention', 'late_garments')).toEqual({ count: 1 + vendorLate, truncated: false });
  expect(metric(body, 'attention', 'pickups_at_risk')).toEqual({ count: 1, truncated: false });
  expect(metric(body, 'attention', 'vendor_overdue')).toEqual({ count: 1, truncated: false });
  expect(metric(body, 'attention', 'qc_failed')).toEqual({ count: 1, truncated: false });
  expect(metric(body, 'attention', 'on_hold_orders')).toEqual({ count: 1 });
  expect(metric(body, 'attention', 'overdue_bills')).toEqual({ count: 1, amount: w.bills.overdueBill.totals.total });
  expect(metric(body, 'attention', 'low_stock')).toEqual({ count: 1, truncated: false });

  const ctx = await buildContext(userOf(w.admin), { preset: 'month' }, { today: w.TODAY });
  const late = await allRows('late_garments', ctx);
  expect(late.map((r) => r.id)).toContain(w.orders.late.garments[0].id);
  expect(late).toHaveLength(1 + vendorLate);
  expect(late[0]).toEqual({
    id: expect.any(String), title: expect.any(String), subtitle: expect.any(String), date: expect.any(String),
    badge: expect.any(String), link: expect.stringMatching(/^\/orders\/[0-9a-f]{24}$/),
  });
  expect((await allRows('qc_failed', ctx)).map((r) => r.id)).toEqual([w.orders.qc.garments[0].id]);
  expect((await allRows('pickups_at_risk', ctx)).map((r) => r.id)).toEqual([w.orders.atRisk.garments[0].id]);
  expect((await allRows('vendor_overdue', ctx)).map((r) => r.id)).toEqual([w.orders.vendorOrder.garments[0].id]);
  expect((await allRows('on_hold_orders', ctx)).map((r) => r.id)).toEqual([w.orders.held.id]);
  const overdue = await allRows('overdue_bills', ctx);
  expect(overdue).toEqual([expect.objectContaining({ id: w.bills.overdueBill.id, amount: w.bills.overdueBill.totals.total, link: `/bills/${w.bills.overdueBill.id}` })]);
});

test('today\'s fittings and follow-ups due appear for front desk', async () => {
  const w = await dashboardWorld();
  const ops = await home(w.ops);
  expect(metric(ops, 'attention', 'fittings_today')).toEqual({ count: 1 });
  expect(metric(ops, 'attention', 'follow_ups_due')).toEqual({ count: 1, overdue: 0 });
  // Designers: their own fittings; no enquiries.
  const d1 = await home(w.d1);
  expect(metric(d1, 'attention', 'fittings_today')).toEqual({ count: 1 });
  expect(metric(d1, 'attention', 'follow_ups_due')).toBeUndefined();
  expect(metric(await home(w.d2), 'attention', 'fittings_today')).toEqual({ count: 0 });

  const ctx = await buildContext(userOf(w.ops), { preset: 'month' }, { today: w.TODAY });
  expect(await allRows('fittings_today', ctx)).toEqual([expect.objectContaining({ title: 'Asha Rao', link: expect.stringMatching(/^\/appointments/) })]);
  expect(await allRows('follow_ups_due', ctx)).toEqual([expect.objectContaining({ title: 'Priya Sharma', link: expect.stringMatching(/^\/enquiries\/[0-9a-f]{24}$/) })]);
});

test('key numbers count active orders, orders this month and on-time rate with change vs last month', async () => {
  const w = await dashboardWorld();
  const body = await home(w.admin);
  const monthStart = `${w.TODAY.slice(0, 7)}-01`;
  const placedNow = await Order.countDocuments({ orderDate: { $gte: monthStart, $lte: w.TODAY } });
  const previousTo = (() => {
    const d = Number(w.TODAY.slice(8, 10));
    const last = addDaysYmd(monthStart, -1);
    return Number(last.slice(8, 10)) < d ? last : `${last.slice(0, 8)}${w.TODAY.slice(8, 10)}`;
  })();
  const placedBefore = await Order.countDocuments({ orderDate: { $gte: `${previousTo.slice(0, 7)}-01`, $lte: previousTo } });
  expect(placedBefore).toBeGreaterThanOrEqual(1);

  expect(metric(body, 'key_numbers', 'active_orders')).toEqual({ count: await Order.countDocuments({ status: 'active' }) });
  expect(metric(body, 'key_numbers', 'orders_placed')).toEqual({
    count: placedNow,
    rush: 0,
    change: { previous: placedBefore, diff: placedNow - placedBefore, direction: placedNow > placedBefore ? 'up' : placedNow < placedBefore ? 'down' : 'same' },
  });
  // Ready this month: d1's on time, d2's after its original due date. Nothing was ready last month.
  expect(metric(body, 'key_numbers', 'on_time')).toEqual({ count: 2, onTime: 1, rate: 5000, truncated: false, change: null });
  // Designers see their own.
  const d1 = await home(w.d1);
  expect(metric(d1, 'key_numbers', 'on_time')).toMatchObject({ count: 1, onTime: 1, rate: 10000 });
  expect(metric(d1, 'key_numbers', 'active_orders')).toEqual({ count: await Order.countDocuments({ status: 'active', designerId: w.d1.user._id }) });
});

test('the production board counts garments per stage in house and with vendors', async () => {
  const w = await dashboardWorld();
  const body = await home(w.admin);
  const board = metric(body, 'production', 'stage_garments');
  const open = await Garment.countDocuments({
    status: { $in: ['in_progress', 'ready'] },
    orderId: { $in: (await Order.find({ status: 'active' }, { _id: 1 }).lean()).map((o) => o._id) },
  });
  expect(board.count).toBe(open);
  expect(board.breakdown.reduce((s, b) => s + b.count, 0)).toBe(open);
  // The QC failure went back to Handwork, beside the garment out with the vendor.
  expect(board.breakdown.find((b) => b.key === 'handwork')).toMatchObject({ label: 'Handwork', inHouse: 1, withVendor: 1, count: 2 });
  expect(board.breakdown.find((b) => b.key === 'ready_for_pickup')).toMatchObject({ count: 2 });

  const ctx = await buildContext(userOf(w.admin), { preset: 'month' }, { today: w.TODAY });
  const handwork = await allRows('stage_garments', ctx, { key: 'handwork' });
  expect(handwork.map((r) => r.id).sort()).toEqual([w.orders.vendorOrder.garments[0].id, w.orders.qc.garments[0].id].sort());
});

test('upcoming pickups show payment status only to money users', async () => {
  const w = await dashboardWorld();
  const admin = metric(await home(w.admin), 'pickups', 'upcoming_pickups');
  expect(admin.count).toBe(1);
  expect(admin.next).toEqual([
    expect.objectContaining({ orderId: w.orders.atRisk.id, orderNo: w.orders.atRisk.orderNo, pickupDate: addDaysYmd(w.TODAY, 2), garments: 1, ready: 0, payment: { status: 'nothing_yet', balance: 0 } }),
  ]);
  const designer = metric(await home(w.d1), 'pickups', 'upcoming_pickups');
  expect(designer.count).toBe(1);
  expect(designer.next[0]).not.toHaveProperty('payment');
  expect(metric(await home(w.d2), 'pickups', 'upcoming_pickups')).toMatchObject({ count: 0, next: [] });
});

test('workload counts garments per designer and vendor', async () => {
  const w = await dashboardWorld();
  const body = await home(w.admin);
  const designers = metric(body, 'workload', 'workload_designers');
  const board = metric(body, 'production', 'stage_garments');
  expect(designers.breakdown.reduce((s, d) => s + d.count, 0)).toBe(board.count);
  const d1Entry = designers.breakdown.find((d) => d.key === String(w.d1.user._id));
  const d2Entry = designers.breakdown.find((d) => d.key === String(w.d2.user._id));
  expect(d1Entry).toMatchObject({ label: 'Meera', onTime: { ready: 1, onTime: 1, rate: 10000 } });
  expect(d2Entry).toMatchObject({ label: 'Nila', count: 2, onTime: { ready: 1, onTime: 0, rate: 0 } });
  expect(metric(body, 'workload', 'workload_vendors')).toEqual({
    count: 1, breakdown: [{ key: w.vendor.id, label: 'Zari works', count: 1, overdue: 1 }], truncated: false,
  });
  // A designer sees only themselves.
  const own = metric(await home(w.d2), 'workload', 'workload_designers');
  expect(own.breakdown.map((d) => d.key)).toEqual([String(w.d2.user._id)]);

  const ctx = await buildContext(userOf(w.admin), { preset: 'month' }, { today: w.TODAY });
  expect((await allRows('workload_designers', ctx, { key: String(w.d2.user._id) })).map((r) => r.id).sort()).toEqual(
    [w.orders.qc.garments[0].id, w.orders.lateReady.garments[0].id].sort(),
  );
  expect((await allRows('workload_vendors', ctx, { key: w.vendor.id })).map((r) => r.id)).toEqual([w.orders.vendorOrder.garments[0].id]);
});

test('filters narrow order tiles and are reported on tiles they do not touch', async () => {
  const w = await dashboardWorld();
  const byD2 = await home(w.admin, { designerId: String(w.d2.user._id) });
  expect(metric(byD2, 'attention', 'late_garments')).toMatchObject({ count: 0 });
  expect(metric(byD2, 'attention', 'qc_failed')).toMatchObject({ count: 1 });
  expect(metric(byD2, 'key_numbers', 'on_time')).toMatchObject({ count: 1, onTime: 0 });
  expect(metric(byD2, 'attention', 'fittings_today')).toEqual({ count: 0 });
  expect(byD2.tiles.attention.notFilteredBy).toEqual(['designer']);
  expect(byD2.tiles.key_numbers.notFilteredBy).toEqual([]);
  expect(byD2.filters).toMatchObject({ preset: 'month', designerId: String(w.d2.user._id) });

  const business = await home(w.admin, { customerType: 'business' });
  expect(metric(business, 'attention', 'qc_failed')).toMatchObject({ count: 1 });
  expect(metric(business, 'attention', 'late_garments')).toMatchObject({ count: 0 });
  expect(metric(business, 'attention', 'overdue_bills')).toEqual({ count: 0, amount: 0 });
  expect(business.tiles.attention.notFilteredBy).toEqual(['customerType']);

  const rush = await home(w.admin, { priority: 'rush' });
  expect(metric(rush, 'key_numbers', 'orders_placed')).toMatchObject({ count: 0 });
  expect(metric(rush, 'key_numbers', 'active_orders')).toEqual({ count: 0 });
  expect(rush.tiles.attention.notFilteredBy).toEqual(['priority']);
});

test('a range over 400 days is refused', async () => {
  const w = await dashboardWorld();
  const r = await w.admin.agent.get('/v1/dashboard').query({ preset: 'custom', from: '2025-01-01', to: '2026-02-05' });
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('RANGE_TOO_LONG');
  const fine = await w.admin.agent.get('/v1/dashboard').query({ preset: 'custom', from: '2025-01-01', to: '2026-02-04' });
  expect(fine.status).toBe(200);
});

test('figures are cached for a minute per scope and fresh=1 recomputes', async () => {
  const w = await dashboardWorld();
  const spy = vi.spyOn(metricDef('active_orders'), 'figure');
  await home(w.admin);
  await home(w.admin);
  expect(spy).toHaveBeenCalledTimes(1);
  await home(w.admin, { fresh: '1' });
  expect(spy).toHaveBeenCalledTimes(2);
  await home(w.d1);
  await home(w.ops);
  expect(spy).toHaveBeenCalledTimes(4);
  await home(w.d1);
  expect(spy).toHaveBeenCalledTimes(4);
});

test('a failing tile shows unavailable and the rest still load', async () => {
  const w = await dashboardWorld();
  vi.spyOn(metricDef('late_garments'), 'figure').mockRejectedValue(new Error('boom'));
  const warn = vi.spyOn(logger, 'error').mockImplementation(() => {});
  const body = await home(w.admin);
  expect(body.tiles.attention).toEqual({ error: 'UNAVAILABLE' });
  expect(metric(body, 'key_numbers', 'active_orders')).toEqual({ count: expect.any(Number) });
  expect(warn).toHaveBeenCalled();
  // A failure is not cached.
  vi.mocked(metricDef('late_garments').figure).mockRestore();
  expect((await home(w.admin)).tiles.attention.metrics.late_garments).toMatchObject({ count: expect.any(Number) });
});
