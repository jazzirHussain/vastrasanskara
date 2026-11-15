import { test, expect, afterEach, beforeEach, vi } from 'vitest';
import { permissionsFor } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { dashboardHelpers } from './helpers/dashboard.js';
import { clearDashboardCache } from '../src/modules/dashboard/cache.js';
import { metricsFor } from '../src/modules/dashboard/metrics/index.js';

useTestDb();
const app = buildTestApp();
const { dashboardWorld } = dashboardHelpers(app);

beforeEach(() => clearDashboardCache());
afterEach(() => vi.restoreAllMocks());

let keys = 0;
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const userOf = (login) => ({ id: String(login.user._id), branchId: String(login.user.branchId), permissions: new Set(permissionsFor(login.user.roles)) });

/** The dashboard world plus an expense, so every tile has something in it. */
async function richWorld() {
  const w = await dashboardWorld();
  ok(await w.admin.agent.post('/v1/expenses').set('Idempotency-Key', `dd${++keys}`)
    .send({ date: w.TODAY, category: 'rent', payee: { name: 'Landlord' }, mode: 'cash', total: 118000 }));
  return w;
}

/** Every row of a metric (optionally one bar), page by page, asserting no row repeats. */
async function rowsOf(who, id, query, key) {
  const items = [];
  let cursor;
  do {
    const r = await who.agent.get(`/v1/dashboard/metrics/${id}/rows`).query({ ...query, limit: 2, ...(key && { key }), ...(cursor && { cursor }) });
    expect(r.status, `${id} ${JSON.stringify(r.body)}`).toBe(200);
    items.push(...r.body.items);
    cursor = r.body.nextCursor;
  } while (cursor);
  const ids = items.map((i) => i.id);
  expect(new Set(ids).size, `${id}${key ? `:${key}` : ''} repeats a row`).toBe(ids.length);
  return items;
}

const sum = (rows) => rows.reduce((n, r) => n + (r.amount ?? 0), 0);

/** A figure (or one bar of it) and its rows agree: count with the number of rows, amount with their sum. */
function expectAgree(label, figure, rows) {
  if (figure.count !== undefined) expect(rows.length, `${label} count`).toBe(figure.count);
  const amount = figure.amount ?? figure.billed;
  if (amount !== undefined && amount !== null) expect(sum(rows), `${label} amount`).toBe(amount);
}

const CONTEXTS = [
  ['month, no filter', { preset: 'month' }],
  ['fy, no filter', { preset: 'fy' }],
  ['month, designer', { preset: 'month' }, 'd1'],
  ['fy, designer', { preset: 'fy' }, 'd2'],
  ['month, business customers', { preset: 'month', customerType: 'business' }],
  ['fy, business customers', { preset: 'fy', customerType: 'business' }],
];

test.each(CONTEXTS)('every figure equals the sum of its drill-down rows (%s)', async (_name, base, designer) => {
  const w = await richWorld();
  const query = designer ? { ...base, designerId: String(w[designer].user._id) } : base;
  const body = (await w.admin.agent.get('/v1/dashboard').query(query)).body;
  const ids = metricsFor(userOf(w.admin)).map((d) => d.id);
  expect(ids.length).toBeGreaterThan(25);
  let checked = 0;
  for (const tile of Object.values(body.tiles)) {
    expect(tile.error).toBeUndefined();
    for (const [id, figure] of Object.entries(tile.metrics)) {
      const rows = await rowsOf(w.admin, id, query);
      expectAgree(id, figure, rows);
      for (const bar of figure.breakdown ?? []) {
        expectAgree(`${id}:${bar.key}`, bar, await rowsOf(w.admin, id, query, bar.key));
      }
      checked += 1;
    }
  }
  expect(checked).toBe(ids.length);
});

const LINKS = {
  order: /^\/orders\/[0-9a-f]{24}$/,
  bill: /^\/bills\/[0-9a-f]{24}$/,
  payment: /^\/payments\/[0-9a-f]{24}$/,
  customer: /^\/customers\/[0-9a-f]{24}$/,
  expense: /^\/expenses\/[0-9a-f]{24}$/,
  stock: /^\/stock\/[0-9a-f]{24}$/,
  enquiry: /^\/enquiries\/[0-9a-f]{24}$/,
  appointment: /^\/appointments\?date=\d{4}-\d{2}-\d{2}$/,
  page: /^\/(reports|stock|expenses)$/,
};
const LINK_OF = {
  late_garments: ['order'], pickups_at_risk: ['order'], vendor_overdue: ['order'], qc_failed: ['order'], on_hold_orders: ['order'],
  active_orders: ['order'], orders_placed: ['order'], on_time: ['order'], stage_garments: ['order'], upcoming_pickups: ['order'],
  workload_designers: ['order'], workload_vendors: ['order'], order_profits: ['order'],
  overdue_bills: ['bill'], billed: ['bill'], outstanding: ['bill'], overdue_amount: ['bill'], month_money: ['bill'], receivables_ageing: ['bill'],
  collected: ['payment'], advances_held: ['customer'], expense_categories: ['expense'],
  low_stock: ['stock'], stock_low: ['stock'], stock_reserved: ['stock'], stock_item_profit: ['stock'],
  follow_ups_due: ['enquiry'], enquiry_sources: ['enquiry'], fittings_today: ['appointment'], appointments_today: ['appointment'],
  profit: ['page'],
};

test('rows link to the record behind them', async () => {
  const w = await richWorld();
  const query = { preset: 'fy' };
  let seen = 0;
  for (const { id } of metricsFor(userOf(w.admin))) {
    expect(LINK_OF[id], `no link rule for ${id}`).toBeDefined();
    for (const row of await rowsOf(w.admin, id, query)) {
      expect(Object.keys(row).every((k) => ['id', 'title', 'subtitle', 'amount', 'date', 'badge', 'link'].includes(k)), `${id} ${JSON.stringify(row)}`).toBe(true);
      expect(LINK_OF[id].some((kind) => LINKS[kind].test(row.link)), `${id} → ${row.link}`).toBe(true);
      seen += 1;
    }
  }
  expect(seen).toBeGreaterThan(20);
});

test('paging never repeats a row', async () => {
  const w = await richWorld();
  // rowsOf asserts uniqueness across pages of 2; walk the biggest lists with pages of 1 too.
  for (const id of ['active_orders', 'stage_garments', 'billed', 'workload_designers']) {
    const seen = [];
    let cursor;
    do {
      const r = await w.admin.agent.get(`/v1/dashboard/metrics/${id}/rows`).query({ preset: 'fy', limit: 1, ...(cursor && { cursor }) });
      ok(r, 200);
      seen.push(...r.body.items.map((i) => i.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size, id).toBe(seen.length);
    expect(seen.length, id).toBeGreaterThan(0);
  }
  const bad = await w.admin.agent.get('/v1/dashboard/metrics/active_orders/rows').query({ cursor: 'not-a-cursor' });
  expect(bad.status).toBe(400);
});

test('an unpermitted metric is not found', async () => {
  const w = await richWorld();
  for (const id of ['billed', 'profit', 'follow_ups_due', 'expense_categories']) {
    const r = await w.d1.agent.get(`/v1/dashboard/metrics/${id}/rows`);
    expect([r.status, r.body.error?.code], id).toEqual([404, 'NOT_FOUND']);
  }
  expect((await w.ops.agent.get('/v1/dashboard/metrics/profit/rows')).status).toBe(404);
  expect((await w.admin.agent.get('/v1/dashboard/metrics/no_such_thing/rows')).status).toBe(404);
  const r = await w.admin.agent.get('/v1/dashboard/metrics/billed/rows');
  ok(r, 200);
  expect(r.body.metric).toEqual({ id: 'billed', label: 'Billed', count: expect.any(Number), amount: expect.any(Number) });
  expect(r.body.columns.map((c) => c.key)).toEqual(['title', 'subtitle', 'date', 'amount']);
});
