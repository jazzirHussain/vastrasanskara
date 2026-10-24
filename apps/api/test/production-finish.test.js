import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { productionHelpers } from './helpers/production.js';
import { AuditLog } from '../src/core/audit/model.js';
useTestDb();
const app = buildTestApp();

const { world, send, act, advanceTo, makeReady, history } = productionHelpers(app);
const orderOf = async (who, order) => (await who.agent.get(`/v1/orders/${order.id}`)).body;
const pickUp = (who, g) => act(who, g, { action: 'picked_up', stage: 'ready_for_pickup' });

test('a garment goes from order taken to picked up', async () => {
  const { ops, d1, take } = await world();
  const order = await take();
  const started = await act(d1, order.garments[0], { action: 'start' });
  const ready = await makeReady(d1, started);
  const done = await pickUp(d1, ready);
  expect(done).toMatchObject({ currentStage: 'picked_up', status: 'picked_up', alterationOpen: false });
  expect((await history(d1, done)).map((e) => `${e.stage}:${e.action}`)).toEqual([
    'materials_ready:start', 'materials_ready:complete', 'pattern_making:complete', 'handwork:complete', 'quality_check:qc_pass',
    'masters_cutting:complete', 'tailors:complete', 'trials_fittings:complete', 'finishing:complete', 'branding:complete',
    'final_qc:qc_pass', 'packaging:complete', 'ready_for_pickup:picked_up',
  ]);
  expect((await orderOf(ops, order)).status).toBe('completed');
  const audit = await AuditLog.findOne({ entityType: 'order', entityId: order.id, action: 'complete' }).lean();
  expect(audit).not.toBeNull();
});

test('alteration at trials returns the garment to tailors', async () => {
  const { d1, take } = await world();
  const atTrials = await advanceTo(d1, (await take()).garments[0], 'trials_fittings');
  const altered = await act(d1, atTrials, { action: 'alteration', stage: 'trials_fittings', remarks: 'Take in the waist' });
  expect(altered).toMatchObject({ currentStage: 'tailors', stageState: 'pending', status: 'in_progress', alterationOpen: false });
});

test('alteration after pickup reopens the garment and the order', async () => {
  const { ops, d1, take } = await world();
  const order = await take();
  const done = await pickUp(d1, await makeReady(d1, order.garments[0]));
  const reopened = await act(d1, done, { action: 'alteration', stage: 'picked_up', chargeable: true });
  expect(reopened).toMatchObject({ currentStage: 'tailors', status: 'in_progress', alterationOpen: true, readyDate: null });
  expect((await orderOf(ops, order)).status).toBe('active');
  expect(await AuditLog.exists({ entityType: 'order', entityId: order.id, action: 'reopen' })).not.toBeNull();
  const again = await pickUp(d1, await makeReady(d1, reopened));
  expect(again.alterationOpen).toBe(false);
  expect((await orderOf(ops, order)).status).toBe('completed');
});

test('operations can record a pickup but not a stage', async () => {
  const { ops, d1, take } = await world();
  const ready = await makeReady(d1, (await take()).garments[0]);
  expect((await send(ops, [ready], { action: 'rework', reworkStage: 'finishing' })).status).toBe(403);
  expect((await pickUp(ops, ready)).status).toBe('picked_up');
});

test('rejecting needs orders.write and a resolution', async () => {
  const { ops, d1, take } = await world();
  const [garment] = (await take()).garments;
  const reject = { action: 'rejected', stage: 'order_taken', reason: 'Client disliked the colour', resolution: 'refund' };
  expect((await send(d1, [garment], reject)).status).toBe(403);
  expect((await send(ops, [garment], { ...reject, resolution: undefined })).status).toBe(400);
  const rejected = await act(ops, garment, reject);
  expect(rejected).toMatchObject({ status: 'rejected', rejection: { resolution: 'refund', reason: 'Client disliked the colour', remakeGarmentId: null } });
  const audit = await AuditLog.findOne({ entityType: 'garment', entityId: garment.id, action: 'reject' }).lean();
  expect(audit.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'status', before: 'in_progress', after: 'rejected' })]));
});

test('remake adds a new garment linked to the rejected one', async () => {
  const { ops, d1, take } = await world();
  const order = await take();
  const atTailors = await advanceTo(d1, order.garments[0], 'tailors');
  const rejected = await act(ops, atTailors, { action: 'rejected', stage: 'tailors', reason: 'Wrong fit', resolution: 'remake' });
  const detail = await orderOf(ops, order);
  expect(detail.garments).toHaveLength(2);
  const remake = detail.garments[1];
  expect(remake).toMatchObject({
    garmentNo: `${order.orderNo}-02`, remakeOf: rejected.id, currentStage: 'order_taken', status: 'in_progress',
    description: 'Blouse', agreedPrice: 450000,
  });
  expect(remake.stagePlan.find((s) => s.stage === 'ready_for_pickup').plannedDate).toBe(order.pickupDate);
  expect(rejected.rejection.remakeGarmentId).toBe(remake.id);
  expect(detail.status).toBe('active');
});

test('refund and write-off leave no new garment', async () => {
  const { ops, take } = await world();
  for (const resolution of ['refund', 'write_off']) {
    const order = await take();
    await act(ops, order.garments[0], { action: 'rejected', stage: 'order_taken', reason: 'Refused', resolution });
    expect((await orderOf(ops, order)).garments).toHaveLength(1);
  }
});

test('a rejected garment does not hold the order open', async () => {
  const { ops, d1, take } = await world();
  const order = await take({ quantity: 2 });
  await act(ops, order.garments[0], { action: 'rejected', stage: 'order_taken', reason: 'Refused', resolution: 'refund' });
  expect((await orderOf(ops, order)).status).toBe('active');
  await pickUp(d1, await makeReady(d1, order.garments[1]));
  expect((await orderOf(ops, order)).status).toBe('completed');
});

test('two last hand-overs at the same moment still complete the order', async () => {
  const { ops, d1, take } = await world();
  for (let round = 0; round < 3; round++) {
    const order = await take({ quantity: 2 });
    const ready = [await makeReady(d1, order.garments[0]), await makeReady(d1, order.garments[1])];
    const results = await Promise.all(ready.map((g) => send(ops, [g], { action: 'picked_up', stage: 'ready_for_pickup' })));
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect((await orderOf(ops, order)).status).toBe('completed');
  }
});
