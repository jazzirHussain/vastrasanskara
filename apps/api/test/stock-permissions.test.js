import { test, expect } from 'vitest';
import { can, ROLE_PERMISSIONS } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { stockHelpers } from './helpers/stock.js';
import { VENDOR_GSTIN } from './helpers/expenses.js';
import { today } from './helpers/production.js';
import { runPendingIntegrityChecks } from '../src/modules/billing/service.js';
import { stockRouter } from '../src/modules/stock/routes.js';
import { costingRouter } from '../src/modules/costing/routes.js';
import { StockItem } from '../src/modules/stock/model.js';
import '../src/jobs.js';

useTestDb();
const app = buildTestApp();
const { world: billingWorld, draftFor, issue, act } = billingHelpers(app);
const { item, expectBalanced } = stockHelpers(app);

const ID = '000000000000000000000000';
const VIEW = 'stock.view';
const WRITE = 'stock.write';
const OWN = 'stock.consume.own';

// [method, path, permissions (any of)]: every stock and costing route.
const ROUTES = [
  ['GET', '/v1/stock/items', [VIEW]],
  ['POST', '/v1/stock/items', [WRITE]],
  ['GET', '/v1/stock/items/:id', [VIEW]],
  ['PATCH', '/v1/stock/items/:id', [WRITE]],
  ['GET', '/v1/stock/items/:id/movements', [VIEW]],
  ['POST', '/v1/stock/items/:id/count', [WRITE]],
  ['POST', '/v1/stock/items/:id/receive', [WRITE]],
  ['GET', '/v1/stock/low', [VIEW]],
  ['GET', '/v1/stock/picker', [VIEW, OWN]],
  ['GET', '/v1/stock/garments/:id/materials', [VIEW, WRITE, OWN]],
  ['PUT', '/v1/stock/garments/:id/materials', [WRITE, OWN]],
  ['POST', '/v1/stock/garments/:id/materials/used', [WRITE, OWN]],
  ['GET', '/v1/stock/requests', [VIEW]],
  ['POST', '/v1/stock/requests', [WRITE]],
  ['POST', '/v1/stock/requests/:id/order', [WRITE]],
  ['POST', '/v1/stock/requests/:id/cancel', [WRITE]],
  ['POST', '/v1/stock/requests/:id/undo', [WRITE]],
  ['POST', '/v1/stock/requests/:id/receive', [WRITE]],
  ['GET', '/v1/costing/orders/:id', ['costing.view']],
];

// Every money key of the Global Constraints: a designer never receives one, at any depth.
const MONEY_KEYS = ['cost', 'value', 'valueChange', 'avgCost', 'sellingPrice', 'price', 'total', 'revenue', 'margin', 'profit'];

function declared(prefix, router) {
  return router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${prefix}${layer.route.path}`));
}

const allowed = (roles, permissions) => permissions.some((p) => can(roles, p));
const concrete = (path) => path.replace(':id', ID);
let keys = 0;
const call = (who, method, path) => {
  const req = who.agent[method.toLowerCase()](concrete(path));
  if (method === 'GET') return req;
  return req.set('Idempotency-Key', `perm-${++keys}`).send({});
};
const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const keysOf = (v) => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);
const moneyKeysIn = (body) => keysOf(body).filter((k) => MONEY_KEYS.includes(k));

/** The billing world plus a silk stock item and an order of one blouse for Meera with 2 m of it. */
async function world() {
  const w = await billingWorld();
  const silk = await item(w.ops, { name: 'Silk', opening: { quantity: 10000, unitCost: 100000 }, sellingPrice: 150000 });
  const take = async (designer = w.d1, materials = [{ stockItemId: silk.id, quantity: 2000 }]) => {
    const r = await w.ops.agent.post('/v1/orders').set('Idempotency-Key', `o${++keys}`).send({
      customerId: w.customerId, designerId: String(designer.user._id), pickupDate: '2099-01-01',
      garments: [{ type: 'blouse', description: 'Blouse', agreedPrice: 1000000, quantity: 1, materials }],
    });
    ok(r, 201);
    return r.body;
  };
  return { ...w, silk, take };
}

test('the permission table covers every stock and costing route', () => {
  const real = [...declared('/v1/stock', stockRouter({})), ...declared('/v1/costing', costingRouter())].sort();
  expect(ROUTES.map(([m, p]) => `${m} ${p}`).sort()).toEqual(real);
  expect(ROLE_PERMISSIONS.designer).not.toContain(VIEW);
  expect(can(['operations'], 'costing.view')).toBe(false);
});

test("designers are refused every stock and costing route except their garments' materials", async () => {
  const w = await world();
  for (const [method, path, permissions] of ROUTES) {
    const r = await call(w.d1, method, path);
    if (allowed(['designer'], permissions)) expect(r.status, `${method} ${path}`).not.toBe(403);
    else expect([r.status, r.body.error?.code], `${method} ${path}`).toEqual([403, 'FORBIDDEN']);
    expect(r.status, `${method} ${path}`).toBeLessThan(500);
  }
  const mine = await w.take(w.d1);
  const theirs = await w.take(w.d2);
  ok(await w.d1.agent.get('/v1/stock/picker?q=si'));
  ok(await w.d1.agent.get(`/v1/stock/garments/${mine.garments[0].id}/materials`));
  expect((await w.d1.agent.get(`/v1/stock/garments/${theirs.garments[0].id}/materials`)).status).toBe(404);
  expect((await w.d1.agent.put(`/v1/stock/garments/${theirs.garments[0].id}/materials`).send({ version: 1, lines: [] })).status).toBe(404);
});

test('operations are allowed stock routes and refused costing', async () => {
  const w = await world();
  for (const [method, path, permissions] of ROUTES) {
    const r = await call(w.ops, method, path);
    if (allowed(['operations'], permissions)) expect(r.status, `${method} ${path}`).not.toBe(403);
    else expect([r.status, r.body.error?.code], `${method} ${path}`).toEqual([403, 'FORBIDDEN']);
    expect(r.status, `${method} ${path}`).toBeLessThan(500);
  }
});

test('admins are allowed every route', async () => {
  const w = await world();
  for (const [method, path] of ROUTES) {
    const r = await call(w.admin, method, path);
    expect(r.status, `${method} ${path}`).not.toBe(403);
    expect(r.status, `${method} ${path}`).toBeLessThan(500);
  }
});

test('designers never receive a cost field', async () => {
  const w = await world();
  const order = await w.take();
  const g = order.garments[0];
  const bodies = {};
  bodies.picker = (await w.d1.agent.get('/v1/stock/picker')).body;
  const view = await w.d1.agent.get(`/v1/stock/garments/${g.id}/materials`);
  ok(view);
  bodies.materials = view.body;
  const planned = await w.d1.agent.put(`/v1/stock/garments/${g.id}/materials`)
    .send({ version: view.body.version, lines: [{ stockItemId: w.silk.id, quantity: 2500 }] });
  ok(planned);
  bodies.plan = planned.body;
  const stage = await w.d1.agent.post('/v1/production/actions').send({
    stage: 'materials_ready', action: 'complete', garments: [{ id: g.id, version: g.version }],
    materialsUsed: [{ garmentId: g.id, stockItemId: w.silk.id, quantity: 2000 }],
  });
  ok(stage);
  bodies.stage = stage.body;
  const after = await w.d1.agent.get(`/v1/stock/garments/${g.id}/materials`);
  bodies.after = after.body;
  const used = await w.d1.agent.post(`/v1/stock/garments/${g.id}/materials/used`)
    .send({ version: after.body.version, changes: [{ stockItemId: w.silk.id, change: 500 }] });
  ok(used);
  bodies.used = used.body;
  bodies.order = (await w.d1.agent.get(`/v1/orders/${order.id}`)).body;
  bodies.orders = (await w.d1.agent.get('/v1/orders')).body;
  bodies.events = (await w.d1.agent.get(`/v1/production/garments/${g.id}/events`)).body;
  for (const [name, body] of Object.entries(bodies)) expect(moneyKeysIn(body), name).toEqual([]);
  // The used quantity really reached the stock: 2 m at Materials ready and 0.5 m more.
  expect((await StockItem.findById(w.silk.id).lean()).onHand).toBe(7500);
});

test('garment and order responses carry no stock cost', async () => {
  const w = await world();
  const order = await w.take();
  await act(w.d1, order.garments[0], { action: 'complete' });
  const stockKeys = ['cost', 'valueChange', 'avgCost', 'margin', 'profit', 'revenue', 'material'];
  for (const who of [w.admin, w.ops]) {
    const r = await who.agent.get(`/v1/orders/${order.id}`);
    ok(r);
    expect(keysOf(r.body).filter((k) => stockKeys.includes(k))).toEqual([]);
  }
});

test('from order to profit', async () => {
  const w = await world();
  const { ops, admin, d1 } = w;
  await w.addItem({
    name: 'Rush', kind: 'extra_charge', supplyType: 'service', hsnSac: '998821', defaultPrice: 100000,
    gstSlabs: [{ upToUnitPrice: null, rateBp: 1800 }], chargeFor: 'rush',
  });
  // Zari: 2 m on the shelf at ₹1,000 a metre, sold by the metre at ₹1,500.
  const zari = await item(ops, { name: 'Zari', opening: { quantity: 2000, unitCost: 100000 }, sellingPrice: 150000 });
  const material = await w.addItem({
    name: 'Zari by the metre', kind: 'material', supplyType: 'goods', hsnSac: '5605', unit: 'MTR',
    defaultPrice: 150000, gstSlabs: [{ upToUnitPrice: null, rateBp: 500 }], stockItemId: zari.id,
  });

  // The order needs 5 m: 2 m are reserved and 3 m go on "To buy".
  const r0 = await ops.agent.post('/v1/orders').set('Idempotency-Key', 'e2e-order').send({
    customerId: w.customerId, designerId: String(d1.user._id), pickupDate: '2099-01-01', priority: 'rush',
    garments: [{ type: 'blouse', description: 'Blouse', agreedPrice: 1000000, quantity: 1, materials: [{ stockItemId: zari.id, quantity: 5000 }] }],
  });
  ok(r0, 201);
  const order = r0.body;
  const g = order.garments[0];
  expect(await StockItem.findById(zari.id).lean()).toMatchObject({ onHand: 2000, reserved: 2000 });
  const requests = (await ops.agent.get('/v1/stock/requests?status=requested')).body.items;
  const request = requests.find((x) => x.stockItem.id === zari.id);
  expect(request).toMatchObject({ quantity: 3000 });

  // Ordered, then 4 m delivered on a GST bill (₹3,600 before GST, GST claimable): the reservation fills.
  const ordered = await ops.agent.post(`/v1/stock/requests/${request.id}/order`).send({ version: request.version, vendorId: null });
  ok(ordered);
  const received = await ops.agent.post(`/v1/stock/requests/${request.id}/receive`).set('Idempotency-Key', 'e2e-receive').send({
    quantity: 4000, total: 424800, mode: 'cash', payee: { name: 'Bengaluru Silks', gstin: VENDOR_GSTIN },
    gst: { billNo: 'Z-1', billDate: today(), rateBp: 1800, taxable: 360000, cgst: 32400, sgst: 32400, igst: 0, itcEligible: true },
  });
  ok(received, 201);
  expect(await StockItem.findById(zari.id).lean()).toMatchObject({ onHand: 6000, reserved: 5000, value: 560000 });

  // Meera uses 4.5 m, not 5 (cost 560000 × 4500 / 6000 = 420000); operations add 0.5 m used more
  // (140000 × 500 / 1500 = 46667).
  await act(d1, g, { action: 'complete', materialsUsed: [{ garmentId: g.id, stockItemId: zari.id, quantity: 4500 }] });
  expect(await StockItem.findById(zari.id).lean()).toMatchObject({ onHand: 1500, reserved: 0, value: 140000 });
  const card = (await ops.agent.get(`/v1/stock/garments/${g.id}/materials`)).body;
  ok(await ops.agent.post(`/v1/stock/garments/${g.id}/materials/used`).send({ version: card.version, changes: [{ stockItemId: zari.id, change: 500 }] }));
  expect(await StockItem.findById(zari.id).lean()).toMatchObject({ onHand: 1000, value: 93333 });

  // The bill: the blouse ₹10,000, the rush ₹1,000 and 0.5 m of zari sold at ₹1,500 a metre (₹750).
  const draft = await draftFor(order);
  const put = await ops.agent.put(`/v1/billing/invoices/${draft.id}`).send({
    version: draft.version, invoiceDiscount: null, notes: '',
    lines: [
      ...draft.lines.map(({ key, source, itemId, garmentId, stageEventId, description, quantity, rate, discount, discountReason }) =>
        ({ key, source, itemId, garmentId, stageEventId, description, quantity, rate, discount, discountReason })),
      { key: 'zari', source: 'manual', itemId: material.id, garmentId: null, stageEventId: null, description: 'Zari', quantity: 0.5, rate: 150000, discount: 0, discountReason: '' },
    ],
  });
  ok(put);
  const issued = await issue(ops, put.body.invoice);
  ok(issued, 201);
  const bill = issued.body.invoice;
  expect(bill.lines.map((l) => [l.source, l.taxable])).toEqual([['garment', 1000000], ['rush', 100000], ['manual', 75000]]);
  // The sale took 0.5 m out at 93333 × 500 / 1000 = 46667 (rounded).
  expect(await StockItem.findById(zari.id).lean()).toMatchObject({ onHand: 500, value: 46666 });

  // ₹2,000 off the blouse after the fitting.
  ok(await admin.agent.post(`/v1/billing/invoices/${bill.id}/credit-notes`).set('Idempotency-Key', 'e2e-cn')
    .send({ reason: 'Fitting discount', lines: [{ key: bill.lines[0].key, taxable: 200000 }] }), 201);

  // Billed 800000 + shared 175000; materials 420000 + 46667; no other costs.
  const costs = await admin.agent.get(`/v1/costing/orders/${order.id}`);
  ok(costs);
  expect(costs.body.garments[0]).toMatchObject({
    id: g.id, revenue: 975000, sharedRevenue: 175000, material: 466667, expense: 0, margin: 508333,
  });
  expect(costs.body.garments[0].materials).toEqual([{ stockItemId: zari.id, name: 'Zari', usageUnit: 'm', quantity: 5000, cost: 466667 }]);
  expect(costs.body.order).toMatchObject({ revenue: 975000, material: 466667, expense: 0, margin: 508333 });

  await expectBalanced(zari.id);
  await expectBalanced(w.silk.id);
  const started = await admin.agent.post('/v1/admin/audit/verify').send({});
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  await runPendingIntegrityChecks({ storage: app.locals.storage });
  const run = (await admin.agent.get('/v1/admin/audit/verify')).body.run;
  expect(run).toMatchObject({ status: 'done', result: { ok: true } });
});
