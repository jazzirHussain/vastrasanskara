import { test, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_TILES, MONEY_KEYS, permissionsFor } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { dashboardHelpers } from './helpers/dashboard.js';
import { clearDashboardCache } from '../src/modules/dashboard/cache.js';
import { metricsFor } from '../src/modules/dashboard/metrics/index.js';
import { dashboardRouter } from '../src/modules/dashboard/routes.js';
import { Garment, Order } from '../src/modules/orders/model.js';

useTestDb();
const app = buildTestApp();
const { dashboardWorld } = dashboardHelpers(app);

beforeEach(() => clearDashboardCache());

const userOf = (login) => ({ id: String(login.user._id), branchId: String(login.user.branchId), permissions: new Set(permissionsFor(login.user.roles)) });
const get = async (who, url, query = {}) => {
  const r = await who.agent.get(url).query(query);
  expect(r.status, `${url} ${JSON.stringify(r.body)}`).toBe(200);
  return r.body;
};

function expectNoMoney(value, where) {
  if (Array.isArray(value)) return value.forEach((v) => expectNoMoney(v, where));
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      expect(MONEY_KEYS, `${where}: money key ${key}`).not.toContain(key);
      expectNoMoney(v, where);
    }
  }
  return undefined;
}

test('designers never receive a money field anywhere on Home', async () => {
  const w = await dashboardWorld();
  for (const query of [{ preset: 'month' }, { preset: 'fy' }]) {
    const home = await get(w.d1, '/v1/dashboard', query);
    expectNoMoney(home, 'home');
    for (const { id } of metricsFor(userOf(w.d1))) {
      const page = await get(w.d1, `/v1/dashboard/metrics/${id}/rows`, query);
      expectNoMoney(page, id);
      const figure = Object.values(home.tiles).find((t) => t.metrics?.[id])?.metrics[id];
      for (const bar of figure?.breakdown ?? []) expectNoMoney(await get(w.d1, `/v1/dashboard/metrics/${id}/rows`, { ...query, key: bar.key }), `${id}:${bar.key}`);
    }
  }
});

test('designers see only their own garments, appointments and on-time rate', async () => {
  const w = await dashboardWorld();
  const own = new Set((await Order.find({ designerId: w.d1.user._id }, { _id: 1 }).lean()).map((o) => String(o._id)));
  const home = await get(w.d1, '/v1/dashboard');
  for (const id of ['late_garments', 'stage_garments', 'pickups_at_risk', 'vendor_overdue', 'active_orders', 'on_time']) {
    const { items } = await get(w.d1, `/v1/dashboard/metrics/${id}/rows`, { limit: 100 });
    for (const row of items) expect(own.has(row.link.split('/').pop()), `${id} ${row.link}`).toBe(true);
  }
  expect(home.tiles.calendar.metrics.appointments_today.breakdown.map((d) => d.key)).toEqual([String(w.d1.user._id)]);
  expect(home.tiles.key_numbers.metrics.on_time).toMatchObject({ count: 1, onTime: 1 });
  const theirs = await Garment.countDocuments({ orderId: { $nin: [...own] } });
  expect(theirs).toBeGreaterThan(0);
});

test('a designer filter cannot widen a designer\'s scope', async () => {
  const w = await dashboardWorld();
  const query = { designerId: String(w.d2.user._id) };
  const home = await get(w.d1, '/v1/dashboard', query);
  expect(home.tiles.attention.metrics.qc_failed.count).toBe(0);
  expect(home.tiles.key_numbers.metrics.on_time.count).toBe(0);
  expect(home.tiles.production.metrics.stage_garments.count).toBe(0);
  expect((await get(w.d1, '/v1/dashboard/metrics/qc_failed/rows', query)).items).toEqual([]);
  expect((await get(w.d1, '/v1/dashboard/metrics/active_orders/rows', query)).items).toEqual([]);
});

test('operations see money but not profit', async () => {
  const w = await dashboardWorld();
  const home = await get(w.ops, '/v1/dashboard');
  expect(home.tiles.key_numbers.metrics.billed).toBeDefined();
  expect(home.tiles.money).toBeDefined();
  expect(home.tiles.profit).toBeUndefined();
  expect((await w.ops.agent.get('/v1/dashboard/metrics/order_profits/rows')).status).toBe(404);
  expect((await get(w.ops, '/v1/dashboard/metrics/billed/rows')).items.every((r) => typeof r.amount === 'number')).toBe(true);
});

test('admins see every tile', async () => {
  const w = await dashboardWorld();
  const home = await get(w.admin, '/v1/dashboard');
  expect(Object.keys(home.tiles).sort()).toEqual([...DASHBOARD_TILES].sort());
});

test('the dashboard route table matches the router', async () => {
  const declared = dashboardRouter()
    .stack.filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} /v1/dashboard${layer.route.path === '/' ? '' : layer.route.path}`))
    .sort();
  const ROUTES = ['GET /v1/dashboard', 'GET /v1/dashboard/metrics/:metric/rows'];
  expect(declared).toEqual(ROUTES);

  const w = await dashboardWorld();
  for (const who of [w.admin, w.ops, w.d1]) {
    expect((await who.agent.get('/v1/dashboard')).status).toBe(200);
    expect((await who.agent.get('/v1/dashboard/metrics/active_orders/rows')).status).toBe(200);
  }
  const anon = await import('supertest').then((m) => m.default(app).get('/v1/dashboard').set('X-Requested-With', 'vs-app'));
  expect(anon.status).toBe(401);
});

test('dashboard and reports never import another module\'s model', () => {
  const modules = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/modules');
  const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : [path.join(dir, f)]));
  const specifiers = (file) => [...readFileSync(file, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const own = ['dashboard', 'reports'];
  for (const file of walk(modules).filter((f) => f.endsWith('.js'))) {
    const mod = path.relative(modules, file).split(path.sep)[0];
    for (const spec of specifiers(file)) {
      if (!spec.startsWith('.')) continue;
      const target = path.relative(modules, path.resolve(path.dirname(file), spec)).split(path.sep);
      if (own.includes(mod)) {
        // Other modules are reached through their service.js, never their model.js.
        if (target[0] !== mod && !target[0].startsWith('..')) expect(target.at(-1), `${file} imports ${spec}`).not.toBe('model.js');
      } else {
        expect(own.includes(target[0]), `${file} imports ${spec}`).toBe(false);
      }
    }
  }
  expect(existsSync(path.join(modules, 'dashboard', 'service.js'))).toBe(true);
});
