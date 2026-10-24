import { test, expect, vi, afterEach } from 'vitest';
import { addDaysYmd, istDate, workingStage, QC_STAGES } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { clock } from '../src/clock.js';
import { StageEvent } from '../src/modules/production/model.js';
useTestDb();
afterEach(() => vi.restoreAllMocks());
const app = buildTestApp();

let keys = 0;
const today = () => istDate(clock.now());

async function world() {
  const ops = await loginAs(app, { roles: ['operations'] });
  const d1 = await loginAs(app, { roles: ['designer'], name: 'Meera' });
  const d2 = await loginAs(app, { roles: ['designer'], name: 'Nila' });
  const customerId = (await ops.agent.post('/v1/customers').send({ name: 'Asha Rao', phone: '9876543210' })).body.id;
  const worker = (await ops.agent.post('/v1/workers').send({ name: 'Ravi' })).body;
  const vendor = (await ops.agent.post('/v1/vendors').send({ name: 'Zari works' })).body;
  const take = async ({ designer = d1, quantity = 1 } = {}) =>
    (await ops.agent.post('/v1/orders').set('Idempotency-Key', `p${++keys}`).send({
      customerId, designerId: String(designer.user._id), pickupDate: addDaysYmd(today(), 40),
      garments: [{ type: 'blouse', description: 'Blouse', agreedPrice: 450000, quantity }],
    })).body;
  return { ops, d1, d2, worker, vendor, take };
}

const send = (who, garments, body) =>
  who.agent.post('/v1/production/actions').send({
    stage: workingStage(garments[0]),
    garments: garments.map((g) => ({ id: g.id, version: g.version })),
    ...body,
  });

/** Acts on one garment and returns it as the API answers (fails the test on an error). */
async function act(who, garment, body) {
  const r = await send(who, [garment], body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.garments[0];
}

/** Completes (or passes QC on) stages until the garment works on `stage`. */
async function advanceTo(who, garment, stage) {
  let g = garment;
  while (workingStage(g) !== stage) g = await act(who, g, { action: QC_STAGES.includes(workingStage(g)) ? 'qc_pass' : 'complete' });
  return g;
}

const history = async (who, garment) => (await who.agent.get(`/v1/production/garments/${garment.id}/events`)).body.items;

async function stagePhoto(who) {
  const r = await who.agent.post('/v1/files/upload-url').send({ purpose: 'stage_photo', contentType: 'image/jpeg', size: 1000 });
  expect(r.status).toBe(200);
  return r.body.key;
}

test('a designer starts and completes a stage with workers and a photo', async () => {
  const { d1, worker, take } = await world();
  const [garment] = (await take()).garments;
  const started = await act(d1, garment, { action: 'start', workerIds: [worker.id] });
  expect(started).toMatchObject({ currentStage: 'materials_ready', stageState: 'in_progress', version: 1 });
  const key = await stagePhoto(d1);
  const done = await act(d1, started, { action: 'complete', remarks: 'Silk arrived', photoKeys: [key] });
  expect(done).toMatchObject({ currentStage: 'pattern_making', stageState: 'pending', status: 'in_progress' });
  const events = await history(d1, garment);
  expect(events.map((e) => [e.stage, e.action])).toEqual([['materials_ready', 'start'], ['materials_ready', 'complete']]);
  expect(events[0]).toMatchObject({ workers: [{ id: worker.id, name: 'Ravi' }], by: { name: 'Meera' } });
  expect(events[1]).toMatchObject({ remarks: 'Silk arrived', photoKeys: [key] });
});

test('skip records the reason on the plan', async () => {
  const { d1, ops, take } = await world();
  const order = await take();
  const g = await act(d1, order.garments[0], { action: 'skip', reason: 'Fabric from client' });
  expect(g.currentStage).toBe('pattern_making');
  const detail = (await ops.agent.get(`/v1/orders/${order.id}`)).body;
  expect(detail.garments[0].stagePlan.find((s) => s.stage === 'materials_ready')).toMatchObject({ skipped: true, skipReason: 'Fabric from client' });
});

test('QC fail sends the garment back for rework', async () => {
  const { d1, take } = await world();
  const atQc = await advanceTo(d1, (await take()).garments[0], 'quality_check');
  const back = await act(d1, atQc, { action: 'qc_fail', reworkStage: 'handwork', remarks: 'Loose beads' });
  expect(back).toMatchObject({ currentStage: 'handwork', stageState: 'pending' });
  expect((await history(d1, back)).at(-1)).toMatchObject({ stage: 'quality_check', action: 'qc_fail', reworkStage: 'handwork' });
  const wrong = await send(d1, [back], { action: 'rework', reworkStage: 'tailors' });
  expect(wrong.body.error.code).toBe('REWORK_TARGET_INVALID');
});

test('vendor work out and back', async () => {
  const { d1, vendor, take } = await world();
  const g = await advanceTo(d1, (await take()).garments[0], 'handwork');
  const dueBackDate = addDaysYmd(today(), 5);
  const away = await act(d1, g, { action: 'sent_to_vendor', vendorId: vendor.id, dueBackDate });
  expect(away).toMatchObject({ stageState: 'with_vendor', vendorWork: { vendorId: vendor.id, dueBackDate, sentOn: today() } });
  expect((await send(d1, [away], { action: 'complete' })).body.error.code).toBe('WITH_VENDOR');
  const back = await act(d1, away, { action: 'returned_from_vendor' });
  expect(back).toMatchObject({ stageState: 'in_progress', vendorWork: null });
  expect((await history(d1, back)).at(-2)).toMatchObject({ vendor: { id: vendor.id, name: 'Zari works' }, dueBackDate });
});

test("completing packaging makes the garment ready with today's readyDate", async () => {
  const { d1, take } = await world();
  const atPackaging = await advanceTo(d1, (await take()).garments[0], 'packaging');
  const ready = await act(d1, atPackaging, { action: 'complete' });
  expect(ready).toMatchObject({ currentStage: 'ready_for_pickup', status: 'ready', readyDate: today() });
});

test('operations cannot record stage actions', async () => {
  const { ops, take } = await world();
  const [garment] = (await take()).garments;
  expect((await send(ops, [garment], { action: 'complete' })).status).toBe(403);
});

test("designers act only on their own orders' garments", async () => {
  const { d2, take } = await world();
  const [garment] = (await take()).garments;
  expect((await send(d2, [garment], { action: 'complete' })).status).toBe(404);
  expect((await d2.agent.get(`/v1/production/garments/${garment.id}/events`)).status).toBe(404);
});

test('acting on another stage is a stage order violation', async () => {
  const { d1, take } = await world();
  const [garment] = (await take()).garments;
  const r = await send(d1, [garment], { action: 'complete', stage: 'tailors' });
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('STAGE_ORDER_VIOLATION');
});

test('a stale version is refused and records no event', async () => {
  const { d1, take } = await world();
  const [garment] = (await take()).garments;
  const results = await Promise.all([send(d1, [garment], { action: 'complete' }), send(d1, [garment], { action: 'complete' })]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await StageEvent.countDocuments()).toBe(1);
});

test('bulk is all or nothing', async () => {
  const { d1, take } = await world();
  const batch = (await take({ quantity: 3 })).garments;
  const moved = await act(d1, batch[0], { action: 'complete' });
  const mixed = await send(d1, [batch[1], batch[2], moved], { action: 'complete' });
  expect(mixed.status).toBe(422);
  expect(mixed.body.error.code).toBe('STAGE_ORDER_VIOLATION');
  expect(await StageEvent.countDocuments()).toBe(1);
  const stale = await send(d1, [batch[1], batch[2], batch[0]], { action: 'complete' });
  expect(stale.status).toBe(409);
  const fresh = (await take({ quantity: 3 })).garments;
  const all = await send(d1, fresh, { action: 'complete' });
  expect(all.status).toBe(200);
  expect(all.body.garments.map((g) => g.currentStage)).toEqual(['pattern_making', 'pattern_making', 'pattern_making']);
  const events = await StageEvent.find({ garmentId: { $in: fresh.map((g) => g.id) } }).lean();
  expect(events).toHaveLength(3);
  expect(new Set(events.map((e) => String(e.bulkId))).size).toBe(1);
  expect(events[0].bulkId).not.toBeNull();
});

test('actions are refused while the order is on hold', async () => {
  const { ops, d1, take } = await world();
  const order = await take();
  await ops.agent.post(`/v1/orders/${order.id}/hold`).send({ version: order.version, reason: 'Client travelling' });
  const r = await send(d1, order.garments, { action: 'complete' });
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('INVALID_STATUS');
});

test('inactive workers and unknown vendors are refused', async () => {
  const { ops, d1, worker, take } = await world();
  await ops.agent.patch(`/v1/workers/${worker.id}`).send({ version: 0, active: false });
  const [garment] = (await take()).garments;
  const r = await send(d1, [garment], { action: 'start', workerIds: [worker.id] });
  expect(r.status).toBe(400);
  expect(r.body.error.details[0].path).toBe('workerIds');
  const v = await send(d1, [garment], { action: 'sent_to_vendor', vendorId: '0123456789abcdef01234567', dueBackDate: addDaysYmd(today(), 3) });
  expect(v.body.error.details[0].path).toBe('vendorId');
  const photo = await send(d1, [garment], { action: 'complete', photoKeys: [`${garment.id}/garment_reference/2026/x.jpg`] });
  expect(photo.body.error.details[0].path).toBe('photoKeys.0');
});

test('designers cannot price a rework and never see charges', async () => {
  const { d1, take } = await world();
  const admin = await loginAs(app, { roles: ['admin'] });
  const atQc = await advanceTo(d1, (await take()).garments[0], 'quality_check');
  const priced = await send(d1, [atQc], { action: 'qc_fail', reworkStage: 'handwork', chargeable: true, chargeAmount: 50000 });
  expect(priced.status).toBe(403);
  await act(admin, atQc, { action: 'qc_fail', reworkStage: 'handwork', chargeable: true, chargeAmount: 50000 });
  const designerView = await history(d1, atQc);
  expect(JSON.stringify(designerView)).not.toContain('chargeAmount');
  expect(designerView.at(-1).chargeable).toBe(true);
  expect((await history(admin, atQc)).at(-1).chargeAmount).toBe(50000);
});

test('stage events cannot be changed', async () => {
  const { d1, take } = await world();
  await act(d1, (await take()).garments[0], { action: 'complete' });
  await expect(StageEvent.updateOne({}, { remarks: 'edited' })).rejects.toThrow('append-only');
  await expect(StageEvent.deleteOne({})).rejects.toThrow('append-only');
});

test('stage photos are readable only within scope', async () => {
  const { d1, d2, take } = await world();
  const [garment] = (await take()).garments;
  const key = await stagePhoto(d1);
  await act(d1, garment, { action: 'complete', photoKeys: [key] });
  expect((await d1.agent.get('/v1/files/url').query({ key })).status).toBe(200);
  expect((await d2.agent.get('/v1/files/url').query({ key })).status).toBe(404);
});
