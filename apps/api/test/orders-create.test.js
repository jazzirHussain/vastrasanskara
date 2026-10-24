import { test, expect, vi, afterEach } from 'vitest';
import { addDaysYmd, financialYear, istDate, planStages, durationsFor, DEFAULT_SETTINGS } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, createTestUser, loginAs } from './helpers/app.js';
import { clock } from '../src/clock.js';
import { Order, Garment } from '../src/modules/orders/model.js';
import { AuditLog } from '../src/core/audit/model.js';
useTestDb();
afterEach(() => vi.restoreAllMocks());
const app = buildTestApp();

let keyCounter = 0;
const today = () => istDate(clock.now());

async function setup() {
  const { agent, user } = await loginAs(app, { roles: ['operations'] });
  const designer = await createTestUser({ roles: ['designer'], name: 'Meera' });
  const customer = (await agent.post('/v1/customers').send({ name: 'Asha Rao', phone: '9876543210' })).body;
  const order = (overrides = {}) => ({
    customerId: customer.id,
    designerId: String(designer._id),
    pickupDate: addDaysYmd(today(), 45),
    garments: [{ type: 'blouse', description: 'Bridal blouse', agreedPrice: 450000 }],
    ...overrides,
  });
  const take = (body = order(), key = `k${++keyCounter}`) => agent.post('/v1/orders').set('Idempotency-Key', key).send(body);
  return { agent, user, designer, customer, order, take };
}

test('order number follows the IST financial year', async () => {
  vi.spyOn(clock, 'now').mockReturnValue(new Date('2027-03-31T18:29:00Z')); // 23:59 IST
  const { take, order } = await setup();
  const body = order({ pickupDate: '2027-04-30' });
  expect((await take(body)).body.orderNo).toBe('VS/ORD/2627/0001');
  vi.spyOn(clock, 'now').mockReturnValue(new Date('2027-03-31T18:31:00Z')); // 00:01 IST, new FY
  expect((await take(body)).body.orderNo).toBe('VS/ORD/2728/0001');
});
test('concurrent orders get consecutive numbers', async () => {
  const { take } = await setup();
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => take()));
  expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
  const fy = results[0].body.orderNo.split('/')[2];
  expect(results.map((r) => r.body.orderNo).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `VS/ORD/${fy}/000${n}`));
});
test('number series start from settings', async () => {
  const { take } = await setup();
  const fy = financialYear(clock.now()).code;
  await (await loginAs(app, { roles: ['admin'] })).agent.put('/v1/settings').send({ numberSeries: { [`order:${fy}`]: 101 } });
  expect((await take()).body.orderNo).toBe(`VS/ORD/${fy}/0101`);
  expect((await take()).body.orderNo).toBe(`VS/ORD/${fy}/0102`);
});
test('a batch of 3 becomes 3 garments with one batchId and consecutive numbers', async () => {
  const { take, order } = await setup();
  const r = await take(order({ garments: [
    { type: 'kurta', description: 'Film extra kurta', agreedPrice: 120000, quantity: 3 },
    { type: 'blouse', description: 'Lead blouse', agreedPrice: 450000 },
  ] }));
  expect(r.status).toBe(201);
  const g = r.body.garments;
  expect(g.map((x) => x.garmentNo)).toEqual([1, 2, 3, 4].map((i) => `${r.body.orderNo}-0${i}`));
  expect(new Set(g.slice(0, 3).map((x) => x.batchId)).size).toBe(1);
  expect(g[0].batchId).toEqual(expect.any(String));
  expect(g[3].batchId).toBeNull();
  expect(await Garment.countDocuments({ orderId: r.body.id })).toBe(4);
  expect(await AuditLog.countDocuments({ entityType: 'order', action: 'create' })).toBe(1);
});
test('each garment gets a stage plan from its due date and type', async () => {
  const { take, order } = await setup();
  const pickupDate = addDaysYmd(today(), 60);
  const dueDate = addDaysYmd(today(), 40);
  const r = await take(order({ pickupDate, garments: [
    { type: 'lehenga', description: 'Lehenga', agreedPrice: 900000, dueDate },
    { type: 'blouse', description: 'Blouse', agreedPrice: 300000 },
  ] }));
  const durations = (type) => durationsFor(DEFAULT_SETTINGS, type);
  const expectedPlan = (dueDate, type) => planStages({ orderDate: today(), dueDate, durations: durations(type) }).stagePlan.map((s) => ({ ...s, originalPlannedDate: s.plannedDate, skipped: false, skipReason: null }));
  expect(r.body.garments[0].stagePlan).toEqual(expectedPlan(dueDate, 'lehenga'));
  expect(r.body.garments[1].stagePlan).toEqual(expectedPlan(pickupDate, 'blouse'));
  expect(r.body).toMatchObject({ orderDate: today(), pickupDate, originalPickupDate: pickupDate, status: 'active', priority: 'normal' });
  expect(r.body.garments[0]).toMatchObject({ dueDate, originalDueDate: dueDate, currentStage: 'order_taken', stageState: 'pending', status: 'in_progress', tightSchedule: false, agreedPrice: 900000 });
});
test('rush pickup marks the garment tight', async () => {
  const { take, order } = await setup();
  const r = await take(order({ priority: 'rush', pickupDate: addDaysYmd(today(), 3) }));
  expect(r.body.garments[0].tightSchedule).toBe(true);
  expect(r.body.tight).toBe(true);
  for (const s of r.body.garments[0].stagePlan.filter((s) => s.plannedDate)) expect(s.plannedDate >= today()).toBe(true);
});
test('double tap creates one order', async () => {
  const { take } = await setup();
  const [a, b] = [await take(undefined, 'same-key'), await take(undefined, 'same-key')];
  expect(b.body.orderNo).toBe(a.body.orderNo);
  expect(await Order.countDocuments({})).toBe(1);
  expect((await take(undefined, '')).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
});
test('rejects pickup in the past, due after pickup, non-designer designer', async () => {
  const { take, order, user, customer } = await setup();
  expect((await take(order({ pickupDate: addDaysYmd(today(), -1) }))).body.error.code).toBe('PICKUP_IN_PAST');
  const pickupDate = addDaysYmd(today(), 10);
  expect((await take(order({ pickupDate, garments: [{ type: 'blouse', description: 'B', agreedPrice: 1, dueDate: addDaysYmd(pickupDate, 1) }] }))).body.error.code).toBe('DUE_AFTER_PICKUP');
  const notDesigner = await take(order({ designerId: String(user._id) }));
  expect(notDesigner.status).toBe(400);
  expect(notDesigner.body.error.details).toEqual([{ path: 'designerId', message: expect.any(String) }]);
  expect((await take(order({ customerId: '000000000000000000000000' }))).body.error.details[0].path).toBe('customerId');
  expect((await take(order({ garments: [{ type: 'saree', description: 'S', agreedPrice: 1 }] }))).body.error.details[0].path).toBe('garments.0.type');
  expect(customer.id).toBeTruthy();
});
test('measurements and reference photos must belong to the customer and branch', async () => {
  const { take, order, agent, customer } = await setup();
  const other = (await agent.post('/v1/customers').send({ name: 'Other', phone: '9123456789' })).body;
  const m = (await agent.post(`/v1/customers/${other.id}/measurements`).send({ garmentType: 'blouse', values: [{ name: 'Bust', value: 34, unit: 'in' }] })).body;
  expect((await take(order({ garments: [{ type: 'blouse', description: 'B', agreedPrice: 1, measurementId: m.id }] }))).body.error.details[0].path).toBe('garments.0.measurementId');
  const own = (await agent.post(`/v1/customers/${customer.id}/measurements`).send({ garmentType: 'blouse', values: [{ name: 'Bust', value: 34, unit: 'in' }] })).body;
  expect((await take(order({ garments: [{ type: 'blouse', description: 'B', agreedPrice: 1, measurementId: own.id }] }))).status).toBe(201);
  expect((await take(order({ garments: [{ type: 'blouse', description: 'B', agreedPrice: 1, referenceKeys: ['000000000000000000000000/garment_reference/2026/x.png'] }] }))).body.error.details[0].path).toBe('garments.0.referenceKeys.0');
});
test('designers cannot take orders; GET /v1/designers lists active designers', async () => {
  const { agent, take, order } = await setup();
  await createTestUser({ roles: ['designer'], name: 'Anu', active: false });
  expect((await agent.get('/v1/designers')).body.items.map((d) => d.name)).toEqual(['Meera']);
  const { agent: designer } = await loginAs(app, { roles: ['designer'] });
  expect((await designer.post('/v1/orders').set('Idempotency-Key', 'd1').send(order())).status).toBe(403);
  expect((await designer.get('/v1/designers')).status).toBe(403);
  expect(take).toBeTruthy();
});
test('garment reference uploads: operations may upload; designers read only their own orders', async () => {
  const { agent, take, order, designer } = await setup();
  const upload = await agent.post('/v1/files/upload-url').send({ purpose: 'garment_reference', contentType: 'image/jpeg', size: 1000 });
  expect(upload.status).toBe(200);
  const r = await take(order({ garments: [{ type: 'blouse', description: 'B', agreedPrice: 1, referenceKeys: [upload.body.key] }] }));
  expect(r.status).toBe(201);
  const own = await loginAs(app, { roles: ['designer'] });
  expect((await own.agent.get('/v1/files/url').query({ key: upload.body.key })).status).toBe(404);
  expect((await agent.get('/v1/files/url').query({ key: upload.body.key })).status).toBe(200);
  expect(designer).toBeTruthy();
});
test('a failed read after the order is saved still answers 201, so a retry never makes a second order', async () => {
  const { take } = await setup();
  vi.spyOn(Garment, 'find').mockImplementationOnce(() => { throw new Error('transient read failure'); });
  const first = await take(undefined, 'after-commit');
  expect(first.status).toBe(201);
  expect(first.body).toMatchObject({ id: expect.any(String), orderNo: expect.stringMatching(/^VS\/ORD\//) });
  const retry = await take(undefined, 'after-commit');
  expect(retry.body.orderNo).toBe(first.body.orderNo);
  expect(await Order.countDocuments({})).toBe(1);
});
