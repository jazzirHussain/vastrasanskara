import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { addDaysYmd, atIstTime, comparisonRange } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { today } from './helpers/production.js';
import { Branch } from '../src/modules/branches/model.js';
import { clearDashboardCache } from '../src/modules/dashboard/cache.js';
import { DashboardSnapshot } from '../src/modules/dashboard/model.js';
import { runDashboardSnapshots } from '../src/modules/dashboard/jobs.js';
import { snapshotNear } from '../src/modules/dashboard/snapshots.js';

useTestDb();
const app = buildTestApp();
const { world, draftFor, issue } = billingHelpers(app);

beforeEach(() => clearDashboardCache());
afterEach(() => vi.restoreAllMocks());

const TODAY = today();
// The same day a month back, as the comparison of "this month" draws it.
const monthAgo = comparisonRange({ preset: 'month', from: TODAY, to: TODAY }).to;

/** One active order with a bill issued today. */
async function setup() {
  const w = await world();
  const branchId = String((await Branch.findOne().lean())._id);
  const r = await issue(w.ops, await draftFor(await w.takeOrder({ prices: [100000] })));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { ...w, branchId, bill: r.body.invoice };
}
const home = async (who, query = {}) => {
  const r = await who.agent.get('/v1/dashboard').query(query);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const figures = (over = {}) => ({ activeOrders: 0, lateGarments: 0, outstanding: 0, overdueAmount: 0, advancesHeld: 0, ...over });

test('a snapshot is taken once a day after 23:30', async () => {
  const { branchId, bill } = await setup();
  await runDashboardSnapshots({ now: new Date(atIstTime(TODAY, '23:00')) });
  expect(await DashboardSnapshot.countDocuments()).toBe(0);
  await runDashboardSnapshots({ now: new Date(atIstTime(TODAY, '23:40')) });
  const [snap] = await DashboardSnapshot.find().lean();
  expect(String(snap.branchId)).toBe(branchId);
  expect(snap.date).toBe(TODAY);
  expect(snap.figures).toEqual(figures({ activeOrders: 1, outstanding: bill.totals.total }));
  await runDashboardSnapshots({ now: new Date(atIstTime(TODAY, '23:50')) });
  expect(await DashboardSnapshot.countDocuments()).toBe(1);
});

test('outstanding compares with the snapshot a month ago', async () => {
  const { branchId, admin, bill } = await setup();
  await DashboardSnapshot.create({ branchId, date: addDaysYmd(monthAgo, -3), figures: figures({ outstanding: 40000, activeOrders: 3 }) });
  expect(await snapshotNear(branchId, monthAgo)).toMatchObject({ outstanding: 40000 });
  expect(await snapshotNear(branchId, addDaysYmd(monthAgo, 4))).toMatchObject({ outstanding: 40000 });
  expect(await snapshotNear(branchId, addDaysYmd(monthAgo, 5))).toBeNull();
  const body = await home(admin);
  const total = bill.totals.total;
  expect(body.tiles.key_numbers.metrics.outstanding).toEqual({
    amount: total, count: 1, change: { previous: 40000, diff: total - 40000, direction: total > 40000 ? 'up' : 'down' },
  });
  expect(body.tiles.key_numbers.metrics.active_orders).toEqual({ count: 1, change: { previous: 3, diff: -2, direction: 'down' } });
});

test('no snapshot, no change line', async () => {
  const { branchId, admin } = await setup();
  // Older than a week before the month-ago day: too far to compare with.
  await DashboardSnapshot.create({ branchId, date: addDaysYmd(monthAgo, -8), figures: figures({ outstanding: 40000 }) });
  const body = await home(admin);
  expect(body.tiles.key_numbers.metrics.outstanding).not.toHaveProperty('change');
  expect(body.tiles.key_numbers.metrics.active_orders).not.toHaveProperty('change');
});

test('filtered views show no change on point-in-time figures', async () => {
  const { branchId, admin, d1 } = await setup();
  await DashboardSnapshot.create({ branchId, date: monthAgo, figures: figures({ outstanding: 40000, activeOrders: 3 }) });
  const filtered = await home(admin, { customerType: 'individual' });
  expect(filtered.tiles.key_numbers.metrics.outstanding).not.toHaveProperty('change');
  const byDesigner = await home(admin, { designerId: String(d1.user._id) });
  expect(byDesigner.tiles.key_numbers.metrics.active_orders).not.toHaveProperty('change');
  // A designer's own view is not the whole branch.
  const own = await home(d1);
  expect(own.tiles.key_numbers.metrics.active_orders).not.toHaveProperty('change');
});
