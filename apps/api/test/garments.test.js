import { test, expect, vi, afterEach } from 'vitest';
import { addDaysYmd, istDate } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { clock } from '../src/clock.js';
import { AuditLog } from '../src/core/audit/model.js';
useTestDb();
afterEach(() => vi.restoreAllMocks());
const app = buildTestApp();

let keys = 0;
const today = () => istDate(clock.now());
const planned = (garment, stage) => garment.stagePlan.find((s) => s.stage === stage);

async function world() {
  const ops = await loginAs(app, { roles: ['operations'] });
  const designer = await loginAs(app, { roles: ['designer'] });
  const other = await loginAs(app, { roles: ['designer'] });
  const customerId = (await ops.agent.post('/v1/customers').send({ name: 'Asha', phone: '9876543210' })).body.id;
  const order = (await ops.agent.post('/v1/orders').set('Idempotency-Key', `g${++keys}`).send({
    customerId, designerId: String(designer.user._id), pickupDate: addDaysYmd(today(), 45),
    garments: [{ type: 'blouse', description: 'Blouse', agreedPrice: 450000, quantity: 2 }],
  })).body;
  return { ops, designer, other, order, garment: order.garments[0] };
}

test('due date change keeps the original and replans', async () => {
  const { ops, garment, order } = await world();
  const due = addDaysYmd(today(), 30);
  const r = await ops.agent.patch(`/v1/garments/${garment.id}`).send({ version: 0, dueDate: due });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ dueDate: due, originalDueDate: order.pickupDate, version: 1 });
  expect(planned(r.body, 'packaging')).toMatchObject({ plannedDate: due, originalPlannedDate: order.pickupDate });
  expect((await ops.agent.patch(`/v1/garments/${garment.id}`).send({ version: 1, dueDate: addDaysYmd(today(), 46) })).body.error.code).toBe('DUE_AFTER_PICKUP');
  expect((await ops.agent.patch(`/v1/garments/${garment.id}`).send({ version: 0, fabric: 'Silk' })).status).toBe(409);
  const back = await ops.agent.patch(`/v1/garments/${garment.id}`).send({ version: 1, dueDate: null });
  expect(planned(back.body, 'packaging').plannedDate).toBe(order.pickupDate);
  expect(back.body.originalDueDate).toBe(order.pickupDate);
  expect(await AuditLog.countDocuments({ entityType: 'garment', action: 'update' })).toBe(2);
});
test('designer can edit design notes but not price', async () => {
  const { designer, other, garment } = await world();
  const r = await designer.agent.patch(`/v1/garments/${garment.id}`).send({ version: 0, designNotes: 'Boat neck, no sleeves' });
  expect(r.status).toBe(200);
  expect(r.body.designNotes).toBe('Boat neck, no sleeves');
  expect(r.body).not.toHaveProperty('agreedPrice');
  expect((await designer.agent.patch(`/v1/garments/${garment.id}`).send({ version: 1, agreedPrice: 1 })).status).toBe(403);
  expect((await other.agent.patch(`/v1/garments/${garment.id}`).send({ version: 1, designNotes: 'x' })).status).toBe(404);
});
test('planned date edits keep originals and reject out-of-order dates', async () => {
  const { designer, garment, order } = await world();
  const handwork = planned(garment, 'handwork').plannedDate;
  const newDate = addDaysYmd(handwork, 1);
  const r = await designer.agent.put(`/v1/garments/${garment.id}/plan`).send({ version: 0, changes: [{ stage: 'handwork', plannedDate: newDate }] });
  expect(r.status).toBe(200);
  expect(planned(r.body, 'handwork')).toMatchObject({ plannedDate: newDate, originalPlannedDate: handwork });
  const late = addDaysYmd(planned(garment, 'tailors').plannedDate, 1);
  expect((await designer.agent.put(`/v1/garments/${garment.id}/plan`).send({ version: 1, changes: [{ stage: 'pattern_making', plannedDate: late }] })).body.error.code).toBe('STAGE_ORDER_VIOLATION');
  expect((await designer.agent.put(`/v1/garments/${garment.id}/plan`).send({ version: 1, changes: [{ stage: 'packaging', plannedDate: addDaysYmd(order.pickupDate, 1) }] })).body.error.code).toBe('PLAN_OUT_OF_RANGE');
  expect((await designer.agent.put(`/v1/garments/${garment.id}/plan`).send({ version: 1, changes: [{ stage: 'materials_ready', plannedDate: addDaysYmd(today(), -1) }] })).body.error.code).toBe('PLAN_OUT_OF_RANGE');
  expect(await AuditLog.countDocuments({ entityType: 'garment', action: 'plan' })).toBe(1);
});
test('planned dates cannot be moved before today, even on an older order', async () => {
  const { designer, garment, order } = await world();
  const later = new Date(clock.now().getTime() + 3 * 86400000);
  vi.spyOn(clock, 'now').mockReturnValue(later);
  const put = (changes) => designer.agent.put(`/v1/garments/${garment.id}/plan`).send({ version: 0, changes });
  expect((await put([{ stage: 'materials_ready', plannedDate: addDaysYmd(order.orderDate, 1) }])).body.error.code).toBe('PLAN_OUT_OF_RANGE');
  expect((await put([{ stage: 'materials_ready', plannedDate: today() }])).status).toBe(200);
});
test('the order-taken date cannot be planned by hand', async () => {
  const { designer, garment } = await world();
  const r = await designer.agent.put(`/v1/garments/${garment.id}/plan`).send({ version: 0, changes: [{ stage: 'order_taken', plannedDate: today() }] });
  expect(r.status).toBe(400);
});
test('fixing a tight plan by hand clears the flag', async () => {
  const { ops, order: taken } = await world();
  const order = (await ops.agent.patch(`/v1/orders/${taken.id}`).send({ version: 0, pickupDate: addDaysYmd(today(), 3) })).body;
  const g = order.garments[0];
  expect(g.tightSchedule).toBe(true);
  const r = await ops.agent.put(`/v1/garments/${g.id}/plan`).send({ version: g.version, changes: [{ stage: 'handwork', plannedDate: planned(g, 'handwork').plannedDate }] });
  expect(r.body.tightSchedule).toBe(false);
});
test('adding garments continues the numbering', async () => {
  const { ops, designer, order } = await world();
  const add = (body, key) => ops.agent.post(`/v1/orders/${order.id}/garments`).set('Idempotency-Key', key).send(body);
  const r = await add({ garments: [{ type: 'lehenga', description: 'Lehenga', agreedPrice: 900000 }] }, 'add1');
  expect(r.status).toBe(201);
  expect(r.body.garments.map((g) => g.garmentNo)).toEqual(['-01', '-02', '-03'].map((s) => `${order.orderNo}${s}`));
  expect((await add({ garments: [{ type: 'lehenga', description: 'Lehenga', agreedPrice: 900000 }] }, 'add1')).body.garments).toHaveLength(3);
  expect((await designer.agent.post(`/v1/orders/${order.id}/garments`).set('Idempotency-Key', 'd').send({ garments: [{ type: 'blouse', description: 'B', agreedPrice: 1 }] })).status).toBe(403);
  await ops.agent.post(`/v1/orders/${order.id}/cancel`).send({ version: 0, reason: 'x' });
  expect((await add({ garments: [{ type: 'blouse', description: 'B', agreedPrice: 1 }] }, 'add2')).body.error.code).toBe('INVALID_STATUS');
});
