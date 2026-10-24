import { test, expect } from 'vitest';
import { addDaysYmd } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { productionHelpers, today } from './helpers/production.js';
import { Garment } from '../src/modules/orders/model.js';
useTestDb();
const app = buildTestApp();

const { world, act, makeReady } = productionHelpers(app);
const board = async (who) => Object.fromEntries((await who.agent.get('/v1/production/board')).body.stages.map((s) => [s.stage, s]));
const rows = async (who, query = {}) => (await who.agent.get('/v1/production/garments').query(query)).body;

/** A batch of three: one moved to Pattern making, one with the vendor, one untouched. */
async function floor() {
  const w = await world();
  const order = await w.take({ quantity: 3 });
  const [a, b, c] = order.garments;
  const moved = await act(w.d1, a, { action: 'complete' });
  const away = await act(w.d1, b, { action: 'sent_to_vendor', vendorId: w.vendor.id, dueBackDate: addDaysYmd(today(), 4) });
  return { ...w, order, moved, away, untouched: c };
}

test('board counts garments per working stage, in house and with vendors', async () => {
  const { ops } = await floor();
  const stages = await board(ops);
  expect(Object.keys(stages)).toEqual([
    'materials_ready', 'pattern_making', 'handwork', 'quality_check', 'masters_cutting', 'tailors', 'trials_fittings',
    'finishing', 'branding', 'final_qc', 'packaging', 'ready_for_pickup',
  ]);
  expect(stages.materials_ready).toEqual({ stage: 'materials_ready', inHouse: 1, withVendor: 1, late: 0 });
  expect(stages.pattern_making).toEqual({ stage: 'pattern_making', inHouse: 1, withVendor: 0, late: 0 });
});

test('designers see only their own garments on the board', async () => {
  const { d2, take } = await floor();
  await take({ designer: d2 });
  const stages = await board(d2);
  expect(stages.materials_ready).toMatchObject({ inHouse: 1, withVendor: 0 });
  expect(stages.pattern_making.inHouse).toBe(0);
  expect((await rows(d2)).items).toHaveLength(1);
});

test('garment list filters by stage, late, vendor and designer', async () => {
  const { ops, d1, d2, vendor, moved, away, untouched, take } = await floor();
  const ids = async (query) => (await rows(ops, query)).items.map((r) => r.garment.id).sort();
  expect(await ids({ stage: 'pattern_making' })).toEqual([moved.id]);
  expect(await ids({ withVendor: 'true' })).toEqual([away.id]);
  expect(await ids({ vendorId: vendor.id })).toEqual([away.id]);
  await Garment.updateOne({ _id: untouched.id, 'stagePlan.stage': 'materials_ready' }, { $set: { 'stagePlan.$.plannedDate': addDaysYmd(today(), -1) } });
  expect(await ids({ late: 'true' })).toEqual([untouched.id]);
  const other = await take({ designer: d2 });
  expect(await ids({ designerId: String(d2.user._id) })).toEqual([other.garments[0].id]);
  const row = (await rows(d1, { withVendor: 'true' })).items[0];
  expect(row).toMatchObject({
    order: { orderNo: expect.any(String), pickupDate: expect.any(String), priority: 'normal' },
    customer: { name: 'Asha Rao' }, designer: { name: 'Meera' }, workingStage: 'materials_ready', late: false, nearlyReady: false,
    vendor: { id: vendor.id, name: 'Zari works' },
  });
  expect(JSON.stringify(row)).not.toContain('agreedPrice');
  expect((await rows(ops)).truncated).toBe(false);
});

test('ready garments wait under ready for pickup', async () => {
  const { ops, d1, take } = await world();
  await makeReady(d1, (await take()).garments[0]);
  expect((await board(ops)).ready_for_pickup).toMatchObject({ inHouse: 1 });
  expect((await rows(ops, { stage: 'ready_for_pickup' })).items[0].nearlyReady).toBe(true);
});

test('held orders are left off the board', async () => {
  const { ops, order } = await floor();
  await ops.agent.post(`/v1/orders/${order.id}/hold`).send({ version: order.version, reason: 'Client travelling' });
  const stages = await board(ops);
  expect(Object.values(stages).every((s) => s.inHouse === 0 && s.withVendor === 0)).toBe(true);
  expect((await rows(ops)).items).toEqual([]);
});
