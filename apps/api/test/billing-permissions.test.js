import { test, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { can, ROLE_PERMISSIONS, periodOf, istDate } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { clock } from '../src/clock.js';
import { Branch } from '../src/modules/branches/model.js';
import { PeriodLock } from '../src/modules/periods/model.js';
import { Outbox } from '../src/core/notify/models.js';
import { billingRouter, integrityRouter } from '../src/modules/billing/routes.js';
import { catalogRouter } from '../src/modules/catalog/routes.js';
import { periodsRouter } from '../src/modules/periods/routes.js';

useTestDb();
const app = buildTestApp();
const { world, draftFor, issue, pay } = billingHelpers(app);

afterEach(() => vi.restoreAllMocks());

const ID = '000000000000000000000000';
const MONTH = '2020-01';
const MONEY = 'money.view';

// [method, path, permission]: every billing, catalog, period-lock and check-records route.
const ROUTES = [
  ['GET', '/v1/billing/customers/:id/summary', MONEY],
  ['GET', '/v1/billing/customers/:id/ledger', MONEY],
  ['GET', '/v1/billing/receivables', MONEY],
  ['GET', '/v1/billing/orders/:id/summary', MONEY],
  ['GET', '/v1/billing/invoices', MONEY],
  ['GET', '/v1/billing/payments', MONEY],
  ['POST', '/v1/billing/invoices/from-order', 'billing.draft'],
  ['POST', '/v1/billing/invoices', 'billing.draft'],
  ['GET', '/v1/billing/documents/:id/pdf', MONEY],
  ['GET', '/v1/billing/invoices/:id', MONEY],
  ['PUT', '/v1/billing/invoices/:id', 'billing.draft'],
  ['POST', '/v1/billing/invoices/:id/issue', 'billing.issue'],
  ['POST', '/v1/billing/invoices/:id/cancel', 'billing.cancel'],
  ['PUT', '/v1/billing/invoices/:id/reminders', 'billing.cancel'],
  ['POST', '/v1/billing/invoices/:id/credit-notes', 'billing.cancel'],
  ['GET', '/v1/billing/credit-notes/:id', MONEY],
  ['DELETE', '/v1/billing/invoices/:id', 'billing.draft'],
  ['POST', '/v1/billing/payments', 'payments.record'],
  ['GET', '/v1/billing/payments/:id', MONEY],
  ['POST', '/v1/billing/payments/:id/cancel', 'billing.cancel'],
  ['POST', '/v1/billing/opening-balances/:id/cancel', 'billing.cancel'],
  ['POST', '/v1/billing/refunds', 'billing.cancel'],
  ['GET', '/v1/billing/refunds/:id', MONEY],
  ['GET', '/v1/billing/receipt-vouchers/:id', MONEY],
  ['GET', '/v1/catalog/items', MONEY],
  ['POST', '/v1/catalog/items', 'catalog.manage'],
  ['PATCH', '/v1/catalog/items/:id', 'catalog.manage'],
  ['GET', '/v1/period-locks', 'periods.lock'],
  ['POST', '/v1/period-locks/:month/lock', 'periods.lock'],
  ['POST', '/v1/period-locks/:month/unlock', 'periods.lock'],
  ['POST', '/v1/admin/audit/verify', 'audit.verify'],
  ['GET', '/v1/admin/audit/verify', 'audit.verify'],
];

// The routes the routers really declare, so a new route cannot slip past the table.
function declared(prefix, router) {
  return router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${prefix}${layer.route.path === '/' ? '' : layer.route.path}`),
    );
}

const concrete = (path) => path.replace(':id', ID).replace(':month', MONTH);
const call = (who, method, path) => {
  const req = who.agent[method.toLowerCase()](concrete(path));
  if (method === 'GET') return req;
  return req.set('Idempotency-Key', `perm-${Math.random().toString(36).slice(2)}`).send({});
};
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);

test('the permission table covers every billing, catalog, period and check-records route', () => {
  const real = [
    ...declared('/v1/billing', billingRouter({})),
    ...declared('/v1/catalog', catalogRouter()),
    ...declared('/v1/period-locks', periodsRouter()),
    ...declared('/v1/admin/audit', integrityRouter()),
  ].sort();
  expect(ROUTES.map(([m, p]) => `${m} ${p}`).sort()).toEqual(real);
});

test('the admin-only permissions are the ones the plan names', () => {
  const adminOnly = [...new Set(ROUTES.map((r) => r[2]))].filter((p) => !can(['operations'], p)).sort();
  expect(adminOnly).toEqual(['audit.verify', 'billing.cancel', 'catalog.manage', 'periods.lock']);
  for (const [, , permission] of ROUTES) expect(can(['designer'], permission)).toBe(false);
  expect(ROLE_PERMISSIONS.designer).not.toContain(MONEY);
});

test('designers are refused every billing route', async () => {
  const { d1 } = await world();
  for (const [method, path] of ROUTES) {
    const r = await call(d1, method, path);
    expect([r.status, r.body.error?.code], `${method} ${path}`).toEqual([403, 'FORBIDDEN']);
  }
});

test('operations are refused admin-only billing routes and allowed the rest', async () => {
  const { ops } = await world();
  for (const [method, path, permission] of ROUTES) {
    const r = await call(ops, method, path);
    if (can(['operations'], permission)) expect(r.status, `${method} ${path}`).not.toBe(403);
    else expect(r.status, `${method} ${path}`).toBe(403);
    expect(r.status, `${method} ${path}`).toBeLessThan(500);
  }
});

test('admins are allowed every billing route', async () => {
  const { admin } = await world();
  for (const [method, path] of ROUTES) {
    const r = await call(admin, method, path);
    expect(r.status, `${method} ${path}`).not.toBe(403);
    expect(r.status, `${method} ${path}`).toBeLessThan(500);
  }
});

test('no designer response contains a money field', async () => {
  const { d1, ops, customerId, takeOrder } = await world();
  const order = await takeOrder({ prices: [450000] });
  ok(await pay(ops, { customerId, orderId: order.id, amount: 100000, mode: 'cash' }));
  ok(await issue(ops, await draftFor(order)));
  const money = /amount|price|total|balance|paid|advance|charge|gst|tax|discount|settlement|credited|invoice|receipt|payment/i;
  const keysOf = (v) => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);
  const reads = [
    '/v1/orders',
    `/v1/orders/${order.id}`,
    `/v1/production/garments/${order.garments[0].id}/events`,
    ...ROUTES.filter(([m]) => m === 'GET').map(([, p]) => concrete(p)),
  ];
  for (const path of reads) {
    const r = await d1.agent.get(path);
    expect(keysOf(r.body).filter((k) => money.test(k)), path).toEqual([]);
  }
});

// --- A locked month ----------------------------------------------------------------------------

const at = (iso) => vi.spyOn(clock, 'now').mockReturnValue(new Date(iso));
let keys = 0;
const lock = async (month) => PeriodLock.create({ branchId: (await Branch.findOne())._id, month, locked: true });
const longAgo = () => new Date(Date.now() - 40 * 24 * 3600_000);

// Each case sets up what it needs (before the lock), then tries its write.
const WRITES = {
  'issue a bill': {
    month: 'current',
    prepare: async (w) => ({ draft: await draftFor(await w.takeOrder()) }),
    send: (w, s) => issue(w.ops, s.draft),
  },
  'take a payment': {
    month: 'current',
    prepare: async () => ({}),
    send: (w) => pay(w.ops, { customerId: w.customerId, amount: 50000, mode: 'cash' }),
  },
  'give a refund': {
    month: 'current',
    prepare: async (w) => {
      ok(await pay(w.ops, { customerId: w.customerId, amount: 50000, mode: 'cash' }));
      return {};
    },
    send: (w) =>
      w.admin.agent
        .post('/v1/billing/refunds')
        .set('Idempotency-Key', `r${++keys}`)
        .send({ customerId: w.customerId, amount: 10000, mode: 'cash', reason: 'Order cancelled' }),
  },
  'issue a credit note': {
    month: 'current',
    prepare: async (w) => {
      const r = await issue(w.ops, await draftFor(await w.takeOrder()));
      ok(r);
      return { bill: r.body.invoice };
    },
    send: (w, s) =>
      w.admin.agent
        .post(`/v1/billing/invoices/${s.bill.id}/credit-notes`)
        .set('Idempotency-Key', `c${++keys}`)
        .send({ reason: 'Price reduced', lines: [{ key: s.bill.lines[0].key, taxable: 100 }] }),
  },
  'cancel a bill': {
    month: 'past',
    prepare: async (w) => {
      const r = await issue(w.ops, await draftFor(await w.takeOrder()));
      ok(r);
      return { bill: r.body.invoice };
    },
    send: (w, s) => w.admin.agent.post(`/v1/billing/invoices/${s.bill.id}/cancel`).send({ reason: 'Billed by mistake' }),
  },
  'cancel a receipt': {
    month: 'past',
    prepare: async (w) => {
      const r = await pay(w.ops, { customerId: w.customerId, amount: 50000, mode: 'cash' });
      ok(r);
      return { receipt: r.body.receipt };
    },
    send: (w, s) => w.admin.agent.post(`/v1/billing/payments/${s.receipt.id}/cancel`).send({ reason: 'Wrong amount' }),
  },
};

const snapshot = async () => ({
  counters: await mongoose.connection.collection('counters').find({ _id: { $not: /^audit:/ } }).sort({ _id: 1 }).toArray(),
  audit: await mongoose.connection.collection('auditLog').countDocuments(),
  outbox: await Outbox.countDocuments(),
});

test.each(Object.entries(WRITES))('a locked month refuses every billing write: %s', async (_name, c) => {
  const w = await world();
  const past = c.month === 'past';
  const when = longAgo();
  if (past) at(when.toISOString());
  const state = await c.prepare(w);
  vi.restoreAllMocks();
  const month = past ? istDate(when).slice(0, 7) : periodOf(clock.now());
  await lock(month);

  const before = await snapshot();
  const r = await c.send(w, state);
  expect([r.status, r.body.error?.code, r.body.error?.details], JSON.stringify(r.body)).toEqual([422, 'PERIOD_LOCKED', { month }]);
  expect(await snapshot()).toEqual(before);
});
