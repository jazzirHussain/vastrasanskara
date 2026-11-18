import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { addDaysYmd, atIstTime, isGarmentLate, permissionsFor } from '@vs/shared';
import { itemBody } from './helpers/stock.js';
import { clock } from '../src/clock.js';
import { Enquiry } from '../src/modules/enquiries/model.js';
import { orderProfits } from '../src/modules/costing/service.js';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { dashboardHelpers } from './helpers/dashboard.js';
import { Garment, Order } from '../src/modules/orders/model.js';
import { clearDashboardCache } from '../src/modules/dashboard/cache.js';
import { metricDef, metricsFor } from '../src/modules/dashboard/metrics/index.js';
import { buildContext } from '../src/modules/dashboard/filters.js';
import { logger } from '../src/logger.js';

useTestDb();
const app = buildTestApp();
const { dashboardWorld, pay, act } = dashboardHelpers(app);

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
  // Billed, collected and the other money key numbers take only the customer type filter.
  expect(byD2.tiles.key_numbers.notFilteredBy).toEqual(['designer']);
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

// --- Task 6: money, expenses, stock, enquiries, calendar and profit -------------------------------

const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
let keys6 = 0;
const lastThirty = (w) => ({ preset: 'custom', from: w.ago(30), to: w.TODAY });

test('money tiles show billed, collected, owed, overdue and advances with credit notes and refunds as sub-lines', async () => {
  const w = await dashboardWorld();
  const note = await w.admin.agent
    .post(`/v1/billing/invoices/${w.bills.partBill.id}/credit-notes`)
    .set('Idempotency-Key', `d6c${++keys6}`)
    .send({ reason: 'Price reduced', lines: [{ key: w.bills.partBill.lines[0].key, taxable: 1000 }] });
  ok(note);
  ok(await pay(w.ops, { customerId: w.customerId, orderId: w.orders.atRisk.id, amount: 5000, mode: 'upi' }));
  ok(await w.admin.agent.post('/v1/billing/refunds').set('Idempotency-Key', `d6r${++keys6}`)
    .send({ customerId: w.customerId, orderId: w.orders.atRisk.id, amount: 2000, mode: 'cash', reason: 'Changed order' }));
  const noteTotal = note.body.creditNote.totals.total;
  const billed = w.bills.overdueBill.totals.total + w.bills.partBill.totals.total;

  const body = await home(w.admin, lastThirty(w));
  expect(metric(body, 'key_numbers', 'billed')).toMatchObject({
    amount: billed, count: 2, credited: noteTotal, change: { previous: 0, diff: billed, direction: 'up' },
  });
  expect(metric(body, 'key_numbers', 'collected')).toMatchObject({ amount: 15000, count: 2, refunded: 2000 });
  const owed = billed - 10000 - noteTotal;
  expect(metric(body, 'key_numbers', 'outstanding')).toEqual({ amount: owed, count: 2 });
  expect(metric(body, 'key_numbers', 'overdue_amount')).toEqual({ amount: w.bills.overdueBill.totals.total, count: 1 });
  expect(metric(body, 'key_numbers', 'advances_held')).toEqual({ amount: 3000, count: 1 });

  const ageing = metric(body, 'money', 'receivables_ageing');
  expect(ageing.amount).toBe(owed);
  expect(ageing.breakdown.map((b) => b.key)).toEqual(['not_due', 'd0_30', 'd31_60', 'd61_90', 'd90_plus']);
  expect(ageing.breakdown.reduce((s, b) => s + b.amount, 0)).toBe(owed);
  expect(ageing.top).toEqual([{ id: w.customerId, name: 'Asha Rao', balance: owed, oldestDays: 10 }]);

  const ctx = await buildContext(userOf(w.admin), lastThirty(w), { today: w.TODAY });
  const sum = (rows) => rows.reduce((n, r) => n + r.amount, 0);
  expect(sum(await allRows('billed', ctx))).toBe(billed);
  expect(sum(await allRows('advances_held', ctx))).toBe(3000);
  expect(sum(await allRows('receivables_ageing', ctx, { key: 'd0_30' }))).toBe(ageing.breakdown.find((b) => b.key === 'd0_30').amount);

  const business = await home(w.admin, { ...lastThirty(w), customerType: 'business' });
  expect(metric(business, 'key_numbers', 'billed')).toMatchObject({ amount: 0, count: 0 });
  expect(metric(business, 'key_numbers', 'advances_held')).toEqual({ amount: 0, count: 0 });
  expect(metric(business, 'money', 'month_money').breakdown.every((m) => m.billed === 0)).toBe(true);

  expect(metric(await home(w.ops, lastThirty(w)), 'key_numbers', 'billed')).toMatchObject({ amount: billed });
  const designer = await home(w.d1, lastThirty(w));
  expect(metric(designer, 'key_numbers', 'billed')).toBeUndefined();
  expect(designer.tiles.money).toBeUndefined();
});

test('billed against collected by month has every month, even empty ones', async () => {
  const w = await dashboardWorld();
  const months = metric(await home(w.admin), 'money', 'month_money');
  expect(months.breakdown).toHaveLength(6);
  expect(months.breakdown.at(-1).key).toBe(w.TODAY.slice(0, 7));
  for (let i = 1; i < 6; i += 1) {
    const [y, m] = months.breakdown[i - 1].key.split('-').map(Number);
    expect(months.breakdown[i].key).toBe(m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`);
  }
  expect(months.breakdown.reduce((s, b) => s + b.billed, 0)).toBe(w.bills.overdueBill.totals.total + w.bills.partBill.totals.total);
  expect(months.breakdown.reduce((s, b) => s + b.collected, 0)).toBe(10000);
  expect(months.breakdown.filter((b) => b.billed === 0).length).toBeGreaterThanOrEqual(4);
  expect(months.breakdown[0]).toEqual({ key: months.breakdown[0].key, label: expect.any(String), billed: 0, collected: 0 });

  const fy = metric(await home(w.admin, { preset: 'fy' }), 'money', 'month_money');
  const year = Number(w.TODAY.slice(0, 4));
  const fyStart = Number(w.TODAY.slice(5, 7)) >= 4 ? `${year}-04` : `${year - 1}-04`;
  expect(fy.breakdown[0].key).toBe(fyStart);
  expect(fy.breakdown.at(-1).key).toBe(w.TODAY.slice(0, 7));
});

test('expenses this month by category with labels', async () => {
  const w = await dashboardWorld();
  const add = async (body) =>
    ok(await w.admin.agent.post('/v1/expenses').set('Idempotency-Key', `d6e${++keys6}`)
      .send({ date: w.TODAY, payee: { name: 'Landlord' }, mode: 'cash', ...body }));
  await add({ category: 'rent', total: 118000 });
  await add({ category: 'electricity', total: 5000 });
  await add({ category: 'electricity', total: 2000 });
  expect(metric(await home(w.admin, { preset: 'today' }), 'expenses', 'expense_categories')).toMatchObject({
    amount: 125000,
    count: 3,
    breakdown: [
      { key: 'rent', label: 'Rent', amount: 118000, count: 1 },
      { key: 'electricity', label: 'Electricity', amount: 7000, count: 2 },
    ],
  });
  const ctx = await buildContext(userOf(w.admin), { preset: 'today' }, { today: w.TODAY });
  expect((await allRows('expense_categories', ctx, { key: 'electricity' })).map((r) => r.amount).sort()).toEqual([2000, 5000]);
  expect((await home(w.d1)).tiles.expenses).toBeUndefined();
});

/** Silk bought for ₹5,000 (10 m) with a purchase expense; 4 m used on a garment, 3 m set aside on another. */
async function stockUse(w) {
  const silk = await w.admin.agent.post('/v1/stock/items').set('Idempotency-Key', `d6s${++keys6}`)
    .send({ ...itemBody({ name: 'Silk' }), sellingPrice: 80000 });
  ok(silk);
  const id = silk.body.item.id;
  ok(await w.ops.agent.post(`/v1/stock/items/${id}/receive`).set('Idempotency-Key', `d6s${++keys6}`)
    .send({ quantity: 10000, total: 500000, mode: 'cash', payee: { name: 'Bengaluru Silks' } }));
  const take = async (quantity) => {
    const r = await w.ops.agent.post('/v1/orders').set('Idempotency-Key', `d6o${++keys6}`).send({
      customerId: w.customerId, designerId: String(w.d1.user._id), pickupDate: addDaysYmd(w.TODAY, 40),
      garments: [{ type: 'blouse', description: 'Silk blouse', agreedPrice: 100000, quantity: 1, materials: [{ stockItemId: id, quantity }] }],
    });
    ok(r);
    return r.body;
  };
  const used = await take(4000);
  await act(w.d1, used.garments[0], { action: 'complete' });
  await take(3000);
  return { silkId: id };
}

test('stock tile shows low items, money reserved for orders and profit per item', async () => {
  const w = await dashboardWorld();
  const { silkId } = await stockUse(w);
  const body = await home(w.admin);
  expect(metric(body, 'stock', 'stock_low')).toEqual({ count: 1, truncated: false });
  expect(metric(body, 'stock', 'stock_reserved')).toMatchObject({ amount: 150000 });
  expect(metric(body, 'stock', 'stock_item_profit')).toMatchObject({
    amount: 120000,
    top: [{ key: silkId, label: 'Silk', cost: 200000, sales: 320000, profit: 120000, noSellingPrice: false }],
  });
  const ctx = await buildContext(userOf(w.admin), { preset: 'month' }, { today: w.TODAY });
  expect((await allRows('stock_reserved', ctx)).map((r) => r.amount)).toEqual([150000]);
  // Stock without money: the low list only, as M6's own routes hide stock values.
  const stockOnly = { id: String(w.ops.user._id), branchId: w.branchId, permissions: new Set(['stock.view']) };
  expect(metricsFor(stockOnly).map((d) => d.id).filter((id) => id.startsWith('stock'))).toEqual(['stock_low']);
});

test('enquiries by source with conversion', async () => {
  const w = await dashboardWorld();
  const add = async (name, phone, source) => {
    const r = await w.ops.agent.post('/v1/enquiries').set('Idempotency-Key', `d6q${++keys6}`).send({ name, phone, source });
    ok(r);
    return r.body.enquiry;
  };
  const a = await add('Insta One', '9845000201', 'instagram');
  await add('Insta Two', '9845000202', 'instagram');
  await Enquiry.updateOne({ _id: a.id }, { status: 'converted', isOpen: false });
  const total = await Enquiry.countDocuments();
  const figure = metric(await home(w.ops, { preset: 'today' }), 'enquiries', 'enquiry_sources');
  expect(figure).toMatchObject({ count: total, converted: 1, conversionRate: Math.round(10000 / total) });
  expect(figure.breakdown.find((b) => b.key === 'instagram')).toEqual({ key: 'instagram', label: 'Instagram', count: 2, converted: 1 });
  const ctx = await buildContext(userOf(w.ops), { preset: 'today' }, { today: w.TODAY });
  expect((await allRows('enquiry_sources', ctx, { key: 'instagram' })).map((r) => r.title).sort()).toEqual(['Insta One', 'Insta Two']);
  expect((await home(w.d1)).tiles.enquiries).toBeUndefined();
});

test('today\'s calendar groups appointments by designer', async () => {
  const w = await dashboardWorld();
  vi.spyOn(clock, 'now').mockReturnValue(new Date(atIstTime(w.TODAY, '09:00')));
  ok(await w.ops.agent.post('/v1/appointments').set('Idempotency-Key', `d6a${++keys6}`).send({
    type: 'consultation', designerId: String(w.d2.user._id), customerId: w.biz, date: w.TODAY, time: '12:00',
  }));
  vi.restoreAllMocks();
  expect(metric(await home(w.admin), 'calendar', 'appointments_today')).toEqual({
    count: 2,
    breakdown: [
      { key: String(w.d1.user._id), label: 'Meera', count: 1 },
      { key: String(w.d2.user._id), label: 'Nila', count: 1 },
    ],
  });
  expect(metric(await home(w.d1), 'calendar', 'appointments_today')).toEqual({
    count: 1, breakdown: [{ key: String(w.d1.user._id), label: 'Meera', count: 1 }],
  });
  const ctx = await buildContext(userOf(w.admin), { preset: 'month' }, { today: w.TODAY });
  expect((await allRows('appointments_today', ctx, { key: String(w.d2.user._id) })).map((r) => r.title)).toEqual(['Sri Silks']);
});

test('profit is net taxable revenue less materials used and running costs, not stock purchases', async () => {
  const w = await dashboardWorld();
  await stockUse(w);
  ok(await w.admin.agent.post('/v1/expenses').set('Idempotency-Key', `d6e${++keys6}`)
    .send({ date: w.TODAY, category: 'rent', payee: { name: 'Landlord' }, mode: 'cash', total: 100000 }));
  const revenue = w.bills.overdueBill.totals.taxable + w.bills.partBill.totals.taxable;
  expect(metric(await home(w.admin, lastThirty(w)), 'profit', 'profit')).toMatchObject({
    revenue, material: 200000, expenses: 100000, profit: revenue - 300000, amount: revenue - 300000,
  });
});

test('per-order profit lists the lowest and highest of the latest invoiced orders', async () => {
  const w = await dashboardWorld();
  const ids = [w.orders.overdueOrder.id, w.orders.paidPart.id];
  const profits = await orderProfits(w.branchId, ids);
  const sorted = ids.map((id) => ({ id, profit: profits.get(id).profit })).sort((a, b) => a.profit - b.profit || a.id.localeCompare(b.id));
  const figure = metric(await home(w.admin, lastThirty(w)), 'profit', 'order_profits');
  expect(figure.count).toBe(2);
  expect(figure.lowest.map((o) => o.orderId)).toEqual(sorted.map((o) => o.id));
  expect(figure.highest.map((o) => o.orderId)).toEqual([...sorted].reverse().map((o) => o.id));
  expect(figure.lowest[0]).toEqual({
    orderId: sorted[0].id, orderNo: expect.any(String), revenue: profits.get(sorted[0].id).revenue, profit: sorted[0].profit,
  });
});

test('profit is for admins only', async () => {
  const w = await dashboardWorld();
  expect((await home(w.admin)).tiles.profit).toBeDefined();
  expect((await home(w.ops)).tiles.profit).toBeUndefined();
  expect((await home(w.d1)).tiles.profit).toBeUndefined();
});
