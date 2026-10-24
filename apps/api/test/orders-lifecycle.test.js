import { test, expect } from 'vitest';
import { addDaysYmd, istDate } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { clock } from '../src/clock.js';
import { AuditLog } from '../src/core/audit/model.js';
useTestDb();
const app = buildTestApp();

let keys = 0;
const today = () => istDate(clock.now());
const planned = (garment, stage) => garment.stagePlan.find((s) => s.stage === stage);

async function world() {
  const ops = await loginAs(app, { roles: ['operations'] });
  const designer = await loginAs(app, { roles: ['designer'] });
  const customerId = (await ops.agent.post('/v1/customers').send({ name: 'Asha', phone: '9876543210' })).body.id;
  const take = async (garments = [{ type: 'blouse', description: 'Blouse', agreedPrice: 450000 }]) =>
    (await ops.agent.post('/v1/orders').set('Idempotency-Key', `l${++keys}`).send({
      customerId, designerId: String(designer.user._id), pickupDate: addDaysYmd(today(), 45), garments,
    })).body;
  return { ops, designer, take };
}

test('moving pickup keeps the original and replans', async () => {
  const { ops, take } = await world();
  const ownDue = addDaysYmd(today(), 20);
  const order = await take([
    { type: 'blouse', description: 'Follows pickup', agreedPrice: 1 },
    { type: 'blouse', description: 'Own due date', agreedPrice: 1, dueDate: ownDue },
  ]);
  const newPickup = addDaysYmd(today(), 30);
  const r = await ops.agent.patch(`/v1/orders/${order.id}`).send({ version: 0, pickupDate: newPickup, notes: 'Wedding moved' });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ pickupDate: newPickup, originalPickupDate: addDaysYmd(today(), 45), notes: 'Wedding moved', version: 1 });
  const [follows, own] = r.body.garments;
  expect(planned(follows, 'packaging')).toMatchObject({ plannedDate: newPickup, originalPlannedDate: addDaysYmd(today(), 45) });
  expect(planned(follows, 'ready_for_pickup').plannedDate).toBe(newPickup);
  expect(planned(follows, 'order_taken').plannedDate).toBe(today());
  expect(planned(own, 'packaging')).toMatchObject({ plannedDate: ownDue, originalPlannedDate: ownDue });
  const audit = await AuditLog.findOne({ entityType: 'order', action: 'update' }).lean();
  expect(audit.changes.map((c) => c.path)).toEqual(['notes', 'pickupDate']);
  expect((await ops.agent.patch(`/v1/orders/${order.id}`).send({ version: 1, pickupDate: addDaysYmd(today(), -1) })).body.error.code).toBe('PICKUP_IN_PAST');
  expect((await ops.agent.patch(`/v1/orders/${order.id}`).send({ version: 1, pickupDate: addDaysYmd(today(), 10) })).body.error.code).toBe('DUE_AFTER_PICKUP');
});
test('a rush pickup marks replanned garments tight', async () => {
  const { ops, take } = await world();
  const order = await take();
  const r = await ops.agent.patch(`/v1/orders/${order.id}`).send({ version: 0, pickupDate: addDaysYmd(today(), 2), priority: 'rush' });
  expect(r.body).toMatchObject({ priority: 'rush', tight: true });
  expect(r.body.garments[0].tightSchedule).toBe(true);
});
test('hold then resume records history', async () => {
  const { ops, take } = await world();
  const order = await take();
  const held = await ops.agent.post(`/v1/orders/${order.id}/hold`).send({ version: 0, reason: 'Client travelling' });
  expect(held.body).toMatchObject({ status: 'on_hold', holdHistory: [{ from: today(), to: null, reason: 'Client travelling', by: expect.any(String) }] });
  expect((await ops.agent.post(`/v1/orders/${order.id}/hold`).send({ version: 1, reason: 'Again' })).body.error.code).toBe('INVALID_STATUS');
  const resumed = await ops.agent.post(`/v1/orders/${order.id}/resume`).send({ version: 1 });
  expect(resumed.body).toMatchObject({ status: 'active', holdHistory: [{ from: today(), to: today() }] });
  expect((await ops.agent.post(`/v1/orders/${order.id}/resume`).send({ version: 2 })).body.error.code).toBe('INVALID_STATUS');
  expect(await AuditLog.countDocuments({ entityType: 'order', action: { $in: ['hold', 'resume'] } })).toBe(2);
});
test('cannot hold a cancelled order', async () => {
  const { ops, take } = await world();
  const order = await take();
  await ops.agent.post(`/v1/orders/${order.id}/cancel`).send({ version: 0, reason: 'Wedding called off' });
  expect((await ops.agent.post(`/v1/orders/${order.id}/hold`).send({ version: 1, reason: 'x' })).body.error.code).toBe('INVALID_STATUS');
  expect((await ops.agent.patch(`/v1/orders/${order.id}`).send({ version: 1, notes: 'x' })).body.error.code).toBe('INVALID_STATUS');
  expect((await ops.agent.post(`/v1/orders/${order.id}/cancel`).send({ version: 1, reason: 'again' })).body.error.code).toBe('INVALID_STATUS');
});
test('cancel uses the refund schedule', async () => {
  const { ops, take } = await world();
  await (await loginAs(app, { roles: ['admin'] })).agent.put('/v1/settings').send({ cancellationRefundSchedule: [
    { uptoStage: 'tailors', refundPercent: 40 },
    { uptoStage: 'pattern_making', refundPercent: 80 },
  ] });
  const order = await take([{ type: 'blouse', description: 'B', agreedPrice: 1, quantity: 2 }]);
  const r = await ops.agent.post(`/v1/orders/${order.id}/cancel`).send({ version: 0, reason: 'Wedding called off' });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ status: 'cancelled', cancellation: { reason: 'Wedding called off', furthestStage: 'order_taken', refundPercent: 80, by: expect.any(String) } });
  expect(r.body.garments.map((g) => g.status)).toEqual(['cancelled', 'cancelled']);
  expect(await AuditLog.countDocuments({ entityType: 'order', action: 'cancel' })).toBe(1);
});
test('no schedule means no refund', async () => {
  const { ops, take } = await world();
  const order = await take();
  expect((await ops.agent.post(`/v1/orders/${order.id}/cancel`).send({ version: 0, reason: 'x' })).body.cancellation.refundPercent).toBe(0);
});
test('stale version is a conflict', async () => {
  const { ops, take, designer } = await world();
  const order = await take();
  await ops.agent.patch(`/v1/orders/${order.id}`).send({ version: 0, notes: 'first' });
  const r = await ops.agent.patch(`/v1/orders/${order.id}`).send({ version: 0, notes: 'second' });
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe('CONFLICT');
  expect((await ops.agent.post(`/v1/orders/${order.id}/hold`).send({ version: 0, reason: 'x' })).status).toBe(409);
  expect((await designer.agent.post(`/v1/orders/${order.id}/hold`).send({ version: 1, reason: 'x' })).status).toBe(403);
});
test('changing the designer checks the new designer', async () => {
  const { ops, take } = await world();
  const order = await take();
  const r = await ops.agent.patch(`/v1/orders/${order.id}`).send({ version: 0, designerId: String(ops.user._id) });
  expect(r.body.error.details).toEqual([{ path: 'designerId', message: expect.any(String) }]);
});
