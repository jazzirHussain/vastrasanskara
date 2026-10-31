import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, vi, afterEach } from 'vitest';
import { addDaysYmd, istDate } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { stockHelpers } from './helpers/stock.js';
import { clock } from '../src/clock.js';
import * as auditService from '../src/core/audit/service.js';
import { AuditLog } from '../src/core/audit/model.js';
import { Expense } from '../src/modules/expenses/model.js';
import { lockPeriod } from '../src/modules/periods/service.js';
import { GarmentMaterials, PurchaseRequest, StockItem, StockMovement } from '../src/modules/stock/model.js';
import { Vendor } from '../src/modules/vendors/model.js';
import { requestListFilter } from '../src/modules/stock/purchasing.js';

useTestDb();
const app = buildTestApp();
const { world: stockWorld, item, expectBalanced } = stockHelpers(app);
afterEach(() => vi.restoreAllMocks());

const VENDOR_GSTIN = '29AAACV1234K1Z3';
const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const today = () => istDate(clock.now());
let keys = 0;

async function world() {
  const w = await stockWorld();
  const customerId = (await w.ops.agent.post('/v1/customers').send({ name: 'Asha Rao', phone: '9876543210' })).body.id;
  async function takeOk(garments) {
    const r = await w.ops.agent.post('/v1/orders').set('Idempotency-Key', `o${++keys}`).send({
      customerId,
      designerId: String(w.designer.user._id),
      pickupDate: addDaysYmd(today(), 40),
      garments: garments.map((g) => ({ type: 'blouse', description: 'Blouse', agreedPrice: 450000, ...g })),
    });
    ok(r, 201);
    return r.body;
  }
  return { ...w, takeOk };
}

const receiveBody = (fields = {}) => ({ quantity: 6000, total: 300000, mode: 'cash', payee: { name: 'Bengaluru Silks' }, ...fields });
const receiveRequest = (who, id, body, key = `k${++keys}`) =>
  who.agent.post(`/v1/stock/requests/${id}/receive`).set('Idempotency-Key', key).send(body);
const receiveItem = (who, id, body, key = `k${++keys}`) =>
  who.agent.post(`/v1/stock/items/${id}/receive`).set('Idempotency-Key', key).send(body);
const newRequest = async (who, stockItemId, quantity = 6000) => {
  const r = await who.agent.post('/v1/stock/requests').send({ stockItemId, quantity, reason: 'manual' });
  ok(r, 201);
  return r.body.request;
};
const stored = (id) => StockItem.findById(id).lean();
const requestsFor = (id) => PurchaseRequest.find({ stockItemId: id }).sort({ createdAt: 1, _id: 1 }).lean();
const purchases = (id) => StockMovement.find({ stockItemId: id, type: 'purchase_in' }).lean();
const lineOf = async (garmentId) => (await GarmentMaterials.findOne({ garmentId }).lean()).lines[0];
const gstBill = (fields = {}) => ({
  billNo: 'INV-77', billDate: today(), rateBp: 1800, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, itcEligible: true, ...fields,
});
const gstPayee = { vendorId: null, name: 'Lakshmi Textiles', gstin: VENDOR_GSTIN, stateCode: null };

/** Two garments on two orders waiting for 3 m of silk each (none in stock): one shortfall request. */
async function waiting(w) {
  const silk = await item(w.ops);
  const first = await w.takeOk([{ materials: [{ stockItemId: silk.id, quantity: 3000 }] }]);
  const second = await w.takeOk([{ materials: [{ stockItemId: silk.id, quantity: 3000 }] }]);
  const [request] = await requestsFor(silk.id);
  return { silk, a: first.garments[0], b: second.garments[0], request };
}

test('receiving adds stock and the material expense together', async () => {
  const { ops } = await world();
  const silk = await item(ops);
  const request = await newRequest(ops, silk.id);
  const r = await receiveRequest(ops, request.id, receiveBody());
  ok(r, 201);
  expect(r.body.request).toMatchObject({ id: request.id, status: 'received', receipt: { quantity: 6000, date: today(), value: 300000 } });
  expect(r.body.item).toMatchObject({ id: silk.id, onHand: 6000, value: 300000 });
  expect(r.body.expense).toEqual({ id: expect.any(String), number: expect.stringMatching(/\/0001$/) });

  const moves = await purchases(silk.id);
  expect(moves).toHaveLength(1);
  expect(String(moves[0].expenseId)).toBe(r.body.expense.id);
  expect(String(moves[0].purchaseRequestId)).toBe(request.id);
  const expense = await Expense.findById(r.body.expense.id).lean();
  expect(expense).toMatchObject({
    source: 'purchase', sourceRef: request.id, category: 'material_purchase', note: '6 m Red silk', date: today(), total: 300000, link: null,
  });
  expect(r.body.request.receipt.expenseId).toBe(r.body.expense.id);
  await expectBalanced(silk.id);
});

test('stock is valued before GST when the GST can be claimed', async () => {
  const { ops } = await world();
  const silk = await item(ops);
  const r = await receiveItem(ops, silk.id, receiveBody({ total: 118000, payee: gstPayee, gst: gstBill() }));
  ok(r, 201);
  expect(r.body.item.value).toBe(100000);
  // The payment date defaults to today, and the bill cannot be dated after it.
  const late = await receiveItem(ops, silk.id, receiveBody({ total: 118000, payee: gstPayee, gst: gstBill({ billDate: addDaysYmd(today(), 1) }) }));
  expect(late.status).toBe(400);
  expect(late.body.error.details.map((d) => d.path)).toContain('gst.billDate');
});

test('stock includes GST when it cannot', async () => {
  const { ops } = await world();
  const silk = await item(ops);
  const r = await receiveItem(ops, silk.id, receiveBody({ total: 118000, payee: gstPayee, gst: gstBill({ itcEligible: false }) }));
  ok(r, 201);
  expect(r.body.item.value).toBe(118000);
  await expectBalanced(silk.id);
});

test('receiving twice with one key makes one delivery and one expense', async () => {
  const { ops } = await world();
  const silk = await item(ops);
  const request = await newRequest(ops, silk.id);
  const first = await receiveRequest(ops, request.id, receiveBody(), 'same-key');
  const second = await receiveRequest(ops, request.id, receiveBody(), 'same-key');
  expect([first.status, second.status]).toEqual([201, 201]);
  expect(second.headers['idempotent-replayed']).toBe('true');
  expect(second.body.expense).toEqual(first.body.expense);
  expect(await Expense.countDocuments()).toBe(1);
  expect(await purchases(silk.id)).toHaveLength(1);
  expect((await stored(silk.id)).onHand).toBe(6000);
});

test('a failed receipt leaves neither stock nor expense', async () => {
  const { ops } = await world();
  const silk = await item(ops);
  const request = await newRequest(ops, silk.id);
  vi.spyOn(auditService, 'recordAudit').mockImplementationOnce(async () => {
    throw new Error('audit write failed');
  });
  const failed = await receiveRequest(ops, request.id, receiveBody());
  expect(failed.status).toBe(500);
  expect(await Expense.countDocuments()).toBe(0);
  expect(await purchases(silk.id)).toHaveLength(0);
  expect(await stored(silk.id)).toMatchObject({ onHand: 0, value: 0 });
  expect((await PurchaseRequest.findById(request.id).lean()).status).toBe('requested');
  const r = await receiveRequest(ops, request.id, receiveBody());
  ok(r, 201);
  expect(r.body.expense.number).toMatch(/\/0001$/);
});

test('a receipt in a locked month is refused', async () => {
  const { ops, admin } = await world();
  const silk = await item(ops);
  const request = await newRequest(ops, silk.id);
  const date = addDaysYmd(`${today().slice(0, 7)}-01`, -1);
  await lockPeriod(admin.user.branchId, date.slice(0, 7), { note: '' }, { userId: admin.user._id });
  const r = await receiveRequest(ops, request.id, receiveBody({ date }));
  expect([r.status, r.body.error.code]).toEqual([422, 'PERIOD_LOCKED']);
  expect(await Expense.countDocuments()).toBe(0);
  expect(await purchases(silk.id)).toHaveLength(0);
  expect((await PurchaseRequest.findById(request.id).lean()).status).toBe('requested');
});

test('a delivery is reserved for the garments waiting for it, oldest first', async () => {
  const w = await world();
  const { silk, a, b, request } = await waiting(w);
  expect(request).toMatchObject({ quantity: 6000, reason: 'shortfall', status: 'requested' });
  const r = await receiveRequest(w.ops, String(request._id), receiveBody({ quantity: 7000 }));
  ok(r, 201);
  expect(await lineOf(a.id)).toMatchObject({ planned: 3000, reserved: 3000 });
  expect(await lineOf(b.id)).toMatchObject({ planned: 3000, reserved: 3000 });
  expect(await stored(silk.id)).toMatchObject({ onHand: 7000, reserved: 6000 });
  const after = await requestsFor(silk.id);
  expect(after.map((q) => q.status)).toEqual(['received']);
  expect(after[0].needs.map((n) => [n.garmentNo, n.reservedOnReceipt])).toEqual([[a.garmentNo, 3000], [b.garmentNo, 3000]]);
  expect(r.body.request.needs.map((n) => n.garmentId)).toEqual([a.id, b.id]);
  expect(r.body.request.needs[0]).not.toHaveProperty('reservedOnReceipt');
  await expectBalanced(silk.id);
});

test('a smaller delivery leaves the rest on a new request', async () => {
  const w = await world();
  const { silk, a, b, request } = await waiting(w);
  const r = await receiveRequest(w.ops, String(request._id), receiveBody({ quantity: 4000 }));
  ok(r, 201);
  expect(await lineOf(a.id)).toMatchObject({ reserved: 3000 });
  expect(await lineOf(b.id)).toMatchObject({ reserved: 1000 });
  const after = await requestsFor(silk.id);
  expect(after.map((q) => [q.status, q.reason])).toEqual([['received', 'shortfall'], ['requested', 'shortfall']]);
  expect(after[1].quantity).toBe(2000);
  expect(after[1].needs.map((n) => [String(n.garmentId), n.quantity])).toEqual([[b.id, 2000]]);
  expect(await stored(silk.id)).toMatchObject({ onHand: 4000, reserved: 4000 });
  // The list of what to buy shows only the new request.
  const list = await w.ops.agent.get('/v1/stock/requests');
  ok(list);
  expect(list.body.items.map((q) => [q.id, q.quantity])).toEqual([[String(after[1]._id), 2000]]);
  await expectBalanced(silk.id);
});

test('receiving without a request records a manual one', async () => {
  const { ops } = await world();
  const silk = await item(ops);
  const r = await receiveItem(ops, silk.id, receiveBody({ quantity: 2500 }));
  ok(r, 201);
  const [request] = await requestsFor(silk.id);
  expect(request).toMatchObject({ reason: 'manual', status: 'received', quantity: 2500, receipt: { quantity: 2500 } });
  expect(r.body.request.id).toBe(String(request._id));
  expect((await Expense.findById(r.body.expense.id).lean()).sourceRef).toBe(String(request._id));
  const missing = await receiveItem(ops, '0123456789abcdef01234567', receiveBody());
  expect(missing.status).toBe(404);
});

test('undo delivery voids the expense and takes the stock back out', async () => {
  const w = await world();
  const { silk, a, request } = await waiting(w);
  const id = String(request._id);
  ok(await w.ops.agent.post(`/v1/stock/requests/${id}/order`).send({ version: request.__v, vendorId: w.vendor.id }));
  const before = await stored(silk.id);
  const received = await receiveRequest(w.ops, id, receiveBody({ quantity: 6000 }));
  ok(received, 201);
  expect(await lineOf(a.id)).toMatchObject({ reserved: 3000 });

  const r = await w.ops.agent.post(`/v1/stock/requests/${id}/undo`).send({ version: received.body.request.version, reason: 'Wrong colour' });
  ok(r);
  expect(r.body.request).toMatchObject({ status: 'ordered', receipt: null, vendor: { id: w.vendor.id, name: 'Bengaluru Silks' } });
  expect(r.body.request.needs.map((n) => n.quantity)).toEqual([3000, 3000]);
  const after = await stored(silk.id);
  expect({ onHand: after.onHand, reserved: after.reserved, value: after.value }).toEqual({
    onHand: before.onHand, reserved: before.reserved, value: before.value,
  });
  expect(await lineOf(a.id)).toMatchObject({ planned: 3000, reserved: 0, state: 'planned' });
  const expense = await Expense.findById(received.body.expense.id).lean();
  expect(expense.status).toBe('voided');
  expect(expense.void.reason).toBe('Delivery undone: Wrong colour');
  expect(await AuditLog.countDocuments({ entityType: 'purchase_request', action: 'undo_receipt' })).toBe(1);
  await expectBalanced(silk.id);

  // Only a received request can be undone; it can be received again.
  const again = await w.ops.agent.post(`/v1/stock/requests/${id}/undo`).send({ version: r.body.request.version, reason: 'x' });
  expect([again.status, again.body.error.code]).toEqual([422, 'INVALID_STATUS']);
  ok(await receiveRequest(w.ops, id, receiveBody({ quantity: 6000 })), 201);
  expect(await lineOf(a.id)).toMatchObject({ reserved: 3000 });
  await expectBalanced(silk.id);
});

test('undo is refused once the delivery has been used', async () => {
  const { ops } = await world();
  const silk = await item(ops);
  const received = await receiveItem(ops, silk.id, receiveBody({ quantity: 5000 }));
  ok(received, 201);
  ok(await ops.agent.post(`/v1/stock/items/${silk.id}/count`).send({ counted: 4000, expectedOnHand: 5000, reason: 'Cut sample' }));
  const r = await ops.agent
    .post(`/v1/stock/requests/${received.body.request.id}/undo`)
    .send({ version: received.body.request.version, reason: 'Wrong item' });
  expect([r.status, r.body.error.code]).toEqual([422, 'RECEIPT_USED']);
  expect((await Expense.findById(received.body.expense.id).lean()).status).toBe('active');
  expect((await stored(silk.id)).onHand).toBe(4000);
});

test("marking ordered and cancelling follow the request's status", async () => {
  const w = await world();
  const { ops, vendor } = w;
  const silk = await item(ops);
  const request = await newRequest(ops, silk.id, 2000);
  expect(request).toMatchObject({ status: 'requested', reason: 'manual', quantity: 2000, vendor: null, stockItem: { id: silk.id, name: 'Red silk' } });

  const stale = await ops.agent.post(`/v1/stock/requests/${request.id}/order`).send({ version: request.version + 1, vendorId: null });
  expect(stale.status).toBe(409);
  await Vendor.updateOne({ _id: vendor.id }, { active: false });
  const inactive = await ops.agent.post(`/v1/stock/requests/${request.id}/order`).send({ version: request.version, vendorId: vendor.id });
  expect(inactive.status).toBe(400);
  await Vendor.updateOne({ _id: vendor.id }, { active: true });

  const ordered = await ops.agent.post(`/v1/stock/requests/${request.id}/order`).send({ version: request.version, vendorId: vendor.id, note: 'Call Monday' });
  ok(ordered);
  expect(ordered.body.request).toMatchObject({ status: 'ordered', vendor: { id: vendor.id, name: 'Bengaluru Silks' }, note: 'Call Monday' });
  expect(ordered.body.request.orderedAt).toBeTruthy();
  const twice = await ops.agent.post(`/v1/stock/requests/${request.id}/order`).send({ version: ordered.body.request.version, vendorId: null });
  expect([twice.status, twice.body.error.code]).toEqual([422, 'INVALID_STATUS']);

  const cancelled = await ops.agent.post(`/v1/stock/requests/${request.id}/cancel`).send({ version: ordered.body.request.version, reason: 'Shop closed' });
  ok(cancelled);
  expect(cancelled.body.request).toMatchObject({ status: 'cancelled', cancellation: { reason: 'Shop closed' } });
  const again = await ops.agent.post(`/v1/stock/requests/${request.id}/cancel`).send({ version: cancelled.body.request.version, reason: 'x' });
  expect([again.status, again.body.error.code]).toEqual([422, 'INVALID_STATUS']);
  const receiving = await receiveRequest(ops, request.id, receiveBody());
  expect([receiving.status, receiving.body.error.code]).toEqual([422, 'INVALID_STATUS']);

  // Garments still waiting move to a new request when theirs is cancelled.
  const { silk: other, a, b, request: shortfall } = await waiting(w);
  const r = await ops.agent.post(`/v1/stock/requests/${shortfall._id}/cancel`).send({ version: shortfall.__v, reason: 'Wrong item' });
  ok(r);
  const open = (await requestsFor(other.id)).filter((q) => q.status === 'requested');
  expect(open).toHaveLength(1);
  expect(open[0].needs.map((n) => [String(n.garmentId), n.quantity])).toEqual([[a.id, 3000], [b.id, 3000]]);

  const list = await ops.agent.get('/v1/stock/requests?status=cancelled');
  ok(list);
  expect(list.body.items.map((q) => q.id).sort()).toEqual([request.id, String(shortfall._id)].sort());
  // Designers cannot see or change what to buy.
  expect((await w.designer.agent.get('/v1/stock/requests')).status).toBe(403);
});

test('the request list uses its index', async () => {
  const { branchId } = await world();
  await PurchaseRequest.init();
  for (const status of ['open', 'received']) {
    const plan = await PurchaseRequest.find(requestListFilter(branchId, status)).sort({ createdAt: -1, _id: -1 }).explain('queryPlanner');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
  }
});

test('receiving (which needs expenses) is imported only by the stock routes', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const importers = readdirSync(src, { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /['"][^'"]*\/purchasing\.js['"]/.test(readFileSync(path.join(src, f), 'utf8')))
    .map((f) => f.split(path.sep).join('/'));
  expect(importers).toEqual(['modules/stock/routes.js']);
});
