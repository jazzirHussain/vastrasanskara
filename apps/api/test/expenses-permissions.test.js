import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { addDaysYmd, can, ROLE_PERMISSIONS } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { expenseHelpers, VENDOR_GSTIN } from './helpers/expenses.js';
import { clock } from '../src/clock.js';
import { AuditLog } from '../src/core/audit/model.js';
import { Expense } from '../src/modules/expenses/model.js';
import { expensesRouter } from '../src/modules/expenses/routes.js';
import { expenseCostForGarments } from '../src/modules/expenses/service.js';
import { Garment, Order } from '../src/modules/orders/model.js';
import { runPendingIntegrityChecks } from '../src/modules/billing/service.js';

useTestDb();
const app = buildTestApp();
const { world, upload, add, lockMonth } = expenseHelpers(app);
const { ObjectId } = mongoose.Types;

// "Now" is 15 Nov 2026 (IST): October is finished and can be locked.
const NOW = new Date('2026-11-15T06:00:00Z');
const TODAY = '2026-11-15';
const LAST = '2026-10';
beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

const ID = '000000000000000000000000';
const VIEW = 'expenses.view';
const WRITE = 'expenses.write';

// [method, path, permission]: every /v1/expenses route.
const ROUTES = [
  ['POST', '/v1/expenses', WRITE],
  ['GET', '/v1/expenses', VIEW],
  ['GET', '/v1/expenses/summary', VIEW],
  ['GET', '/v1/expenses/payees', WRITE],
  ['GET', '/v1/expenses/:id', VIEW],
  ['PATCH', '/v1/expenses/:id', WRITE],
  ['POST', '/v1/expenses/:id/void', WRITE],
];

// The routes the router really declares, so a new route cannot slip past the table.
function declared(prefix, router) {
  return router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${prefix}${layer.route.path === '/' ? '' : layer.route.path}`),
    );
}

const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const call = (who, method, path) => {
  const req = who.agent[method.toLowerCase()](path.replace(':id', ID));
  if (method === 'GET') return req;
  return req.set('Idempotency-Key', `perm-${Math.random().toString(36).slice(2)}`).send({});
};
const keysOf = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      keysOf(v, found);
    }
  }
  return found;
};
const gst = (taxable, half) => ({
  billNo: 'INV-1', billDate: TODAY, rateBp: 1800, taxable, cgst: half, sgst: half, igst: 0, itcEligible: true,
});

let orderKeys = 0;
async function setup() {
  const w = await world();
  const customerId = (await w.ops.agent.post('/v1/customers').send({ name: 'Asha Rao', phone: '9876543210' })).body.id;
  const take = async (garments) => {
    const r = await w.ops.agent.post('/v1/orders').set('Idempotency-Key', `p${++orderKeys}`).send({
      customerId,
      designerId: String(w.designer.user._id),
      pickupDate: addDaysYmd(TODAY, 40),
      garments: garments.map((g) => ({ type: 'blouse', description: 'Blouse', agreedPrice: 450000, quantity: 1, ...g })),
    });
    ok(r, 201);
    return { order: r.body, garments: r.body.garments };
  };
  return { ...w, take };
}

test('the permission table covers every expense route', () => {
  const real = declared('/v1/expenses', expensesRouter({})).sort();
  expect(ROUTES.map(([m, p]) => `${m} ${p}`).sort()).toEqual(real);
  for (const [, , permission] of ROUTES) expect(can(['designer'], permission)).toBe(false);
  expect(ROLE_PERMISSIONS.designer).not.toContain('money.view');
});

test('designers are refused every expense route', async () => {
  const { designer } = await world();
  for (const [method, path] of ROUTES) {
    const r = await call(designer, method, path);
    expect([r.status, r.body.error?.code], `${method} ${path}`).toEqual([403, 'FORBIDDEN']);
  }
});

test('operations and admins are allowed every expense route', async () => {
  const { ops, admin } = await world();
  for (const who of [ops, admin]) {
    for (const [method, path] of ROUTES) {
      const r = await call(who, method, path);
      expect(r.status, `${method} ${path}`).not.toBe(403);
      expect(r.status, `${method} ${path}`).toBeLessThan(500);
    }
  }
});

test('a designer cannot open or upload a bill photo', async () => {
  const { ops, designer, branchId } = await world();
  const key = await upload(ops);
  expect(key.startsWith(`${branchId}/expense_bill/`)).toBe(true);
  const refused = await designer.agent.get(`/v1/files/url?key=${encodeURIComponent(key)}`);
  expect(refused.status).toBe(404);
  const allowed = await ops.agent.get(`/v1/files/url?key=${encodeURIComponent(key)}`);
  ok(allowed);
  expect(allowed.body.url).toBeTruthy();
  const up = await designer.agent.post('/v1/files/upload-url').send({ purpose: 'expense_bill', contentType: 'image/jpeg', size: 3 });
  expect(up.status).toBe(403);
});

test('order and garment responses carry no expense figures', async () => {
  const { ops, designer, take } = await setup();
  const { order, garments } = await take([{ quantity: 2 }, { description: 'red silk' }]);
  ok(await add(ops, { total: 90000, link: { kind: 'order', id: order.id } }), 201);
  ok(await add(ops, { total: 50000, link: { kind: 'batch', id: garments[0].batchId } }), 201);
  ok(await add(ops, { total: 70000, link: { kind: 'garment', id: garments[2].id } }), 201);

  const seen = [];
  for (const who of [designer, ops]) {
    const detail = await who.agent.get(`/v1/orders/${order.id}`);
    ok(detail);
    seen.push(detail.body);
    const patched = await who.agent.patch(`/v1/garments/${garments[2].id}`).send({ version: detail.body.garments[2].version, notes: 'x' });
    seen.push(patched.body);
  }
  for (const body of seen) {
    expect([...keysOf(body)].filter((k) => /expense|cost/i.test(k))).toEqual([]);
  }
});

test.each([
  ['create', (ops) => add(ops, { date: `${LAST}-22` })],
  ['edit', (ops, e) => ops.agent.patch(`/v1/expenses/${e.id}`).send({ version: e.version, note: 'Late' })],
  ['date move', (ops, e) => ops.agent.patch(`/v1/expenses/${e.id}`).send({ version: e.version, date: TODAY })],
  ['void', (ops, e) => ops.agent.post(`/v1/expenses/${e.id}/void`).send({ version: e.version, reason: 'Wrong' })],
])('every expense write in a locked month is refused: %s', async (_name, act) => {
  const { ops } = await world();
  const made = await add(ops, { date: `${LAST}-20` });
  ok(made, 201);
  const expense = made.body.expense;
  await lockMonth(LAST);
  const stored = await Expense.findById(expense.id).lean();
  const audits = await AuditLog.countDocuments();
  const counters = await mongoose.connection.collection('counters').find().toArray();

  const r = await act(ops, expense);
  expect([r.status, r.body.error?.code]).toEqual([422, 'PERIOD_LOCKED']);

  expect(await AuditLog.countDocuments()).toBe(audits);
  expect(await mongoose.connection.collection('counters').find().toArray()).toEqual(counters);
  expect(await Expense.countDocuments()).toBe(1);
  expect(await Expense.findById(expense.id).lean()).toEqual(stored);
});

test("linking to another branch's garment, batch or order is refused", async () => {
  const { ops, take } = await setup();
  const { order, garments } = await take([{ quantity: 2 }]);
  const foreign = new ObjectId();
  await Order.updateOne({ _id: order.id }, { branchId: foreign });
  await Garment.updateMany({ orderId: order.id }, { branchId: foreign });
  for (const link of [
    { kind: 'garment', id: garments[0].id },
    { kind: 'batch', id: garments[0].batchId },
    { kind: 'order', id: order.id },
  ]) {
    const r = await add(ops, { link });
    expect([r.status, r.body.error?.code, (r.body.error?.details ?? []).map((d) => d.path)], link.kind).toEqual([
      400, 'VALIDATION_FAILED', ['link.id'],
    ]);
  }
  expect(await Expense.countDocuments()).toBe(0);
});

test('an expense from photo to month figures', async () => {
  const { ops, admin, take, vendor29, branchId, storage } = await setup();
  const { garments } = await take([{ quantity: 3 }]);
  const key = await upload(ops);

  const made = await add(ops, {
    total: 118000,
    payee: { vendorId: vendor29.id },
    gst: gst(100000, 9000),
    attachments: [{ key, name: 'bill.jpg' }],
    link: { kind: 'batch', id: garments[0].batchId },
  });
  ok(made, 201);
  let expense = made.body.expense;
  expect(expense.payee).toMatchObject({ name: 'Bengaluru Silks', gstin: VENDOR_GSTIN });

  const summary = async () => {
    const r = await ops.agent.get('/v1/expenses/summary?month=2026-11');
    ok(r);
    return r.body;
  };
  const costs = async () => {
    const map = await expenseCostForGarments(branchId, garments.map((g) => g.id));
    return garments.map((g) => map.get(g.id)?.cost ?? 0);
  };
  expect(await summary()).toMatchObject({ total: 118000, count: 1, missingBill: 0 });
  expect(await costs()).toEqual([33334, 33333, 33333]) // claimable GST is not cost: 100000 taxable;

  const edited = await ops.agent.patch(`/v1/expenses/${expense.id}`).send({ version: expense.version, total: 59000, gst: gst(50000, 4500) });
  ok(edited);
  expense = edited.body.expense;
  expect(await summary()).toMatchObject({ total: 59000, count: 1 });
  expect((await costs()).reduce((a, b) => a + b, 0)).toBe(50000);

  ok(await ops.agent.post(`/v1/expenses/${expense.id}/void`).send({ version: expense.version, reason: 'Entered twice' }));
  expect(await summary()).toMatchObject({ total: 0, count: 0 });
  expect(await costs()).toEqual([0, 0, 0]);

  const actions = (await AuditLog.find({ entityType: 'expense' }).sort({ seq: 1 }).lean()).map((a) => a.action);
  expect(actions).toEqual(['create', 'update', 'void']);

  ok(await admin.agent.post('/v1/admin/audit/verify').send({}), 202);
  await runPendingIntegrityChecks({ storage });
  const check = await admin.agent.get('/v1/admin/audit/verify');
  ok(check);
  expect(check.body.run).toMatchObject({ status: 'done' });
  expect(check.body.run.result).toMatchObject({ ok: true, audit: { ok: true, firstBreak: null } });
});
