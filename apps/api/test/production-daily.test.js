import { test, expect } from 'vitest';
import { addDaysYmd, atIstTime } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { productionHelpers, today } from './helpers/production.js';
import { Outbox } from '../src/core/notify/models.js';
import { Garment } from '../src/modules/orders/model.js';
import { runDailyProductionChecks } from '../src/modules/production/daily.js';
useTestDb();
const app = buildTestApp();

const { world, act, advanceTo, makeReady } = productionHelpers(app);
const at = (hhmm, days = 0) => atIstTime(addDaysYmd(today(), days), hhmm);
const run = (hhmm = '08:00', days = 0) => runDailyProductionChecks({ now: at(hhmm, days) });
const rows = (event) => Outbox.find({ event }).sort({ _id: 1 }).lean();

async function makeLate(garment) {
  await Garment.updateOne(
    { _id: garment.id, 'stagePlan.stage': 'materials_ready' },
    { $set: { 'stagePlan.$.plannedDate': addDaysYmd(today(), -1) } },
  );
}

async function setup() {
  const w = await world();
  const owner = await loginAs(app, { roles: ['admin'], name: 'Owner' });
  return { ...w, owner };
}

test('late garments reach their designer in one morning digest', async () => {
  const { d1, d2, take } = await setup();
  const order = await take({ quantity: 2 });
  for (const g of order.garments) await makeLate(g);
  await take({ designer: d2 });
  await run();
  const digest = await rows('stage.late_digest');
  expect(digest.map((r) => `${r.recipient.id}:${r.channel}`).sort()).toEqual([`${d1.user._id}:email`, `${d1.user._id}:in_app`]);
  expect(digest[0].vars).toMatchObject({ count: 2, link: '/production' });
  for (const g of order.garments) expect(digest[0].vars.list).toContain(g.garmentNo);
  expect(digest[0].vars.list).toContain('Materials ready, planned');
});

test('pickup in three days not nearly ready alerts owner and designer', async () => {
  const { d1, owner, take } = await setup();
  const atRisk = await take({ days: 2 });
  const fine = await take({ days: 3 });
  await advanceTo(d1, fine.garments[0], 'final_qc');
  await take({ days: 4 });
  await run();
  const alerts = await rows('pickup.at_risk');
  expect([...new Set(alerts.map((r) => r.vars.orderNo))]).toEqual([atRisk.orderNo]);
  expect([...new Set(alerts.map((r) => r.recipient.id))].sort()).toEqual([String(d1.user._id), String(owner.user._id)].sort());
  expect(alerts[0].vars).toMatchObject({ customerName: 'Asha Rao', pickupDate: atRisk.pickupDate, link: `/orders/${atRisk.id}` });
});

test('vendor past due-back date is reported', async () => {
  const { ops, d1, vendor, take } = await setup();
  const [garment] = (await take()).garments;
  await act(d1, garment, { action: 'sent_to_vendor', vendorId: vendor.id, dueBackDate: today() });
  await run('08:00', 0);
  expect(await rows('vendor.overdue')).toEqual([]);
  await run('08:00', 1);
  const overdue = await rows('vendor.overdue');
  expect([...new Set(overdue.map((r) => r.recipient.id))].sort()).toEqual([String(d1.user._id), String(ops.user._id)].sort());
  expect(overdue[0].vars).toMatchObject({ count: 1 });
  expect(overdue[0].vars.list).toContain('Zari works');
});

test('ready garments uncollected past the flag days are reported', async () => {
  const { ops, d1, take } = await setup();
  const old = await makeReady(d1, (await take()).garments[0]);
  const recent = await makeReady(d1, (await take()).garments[0]);
  await Garment.updateOne({ _id: old.id }, { readyDate: addDaysYmd(today(), -8) });
  await Garment.updateOne({ _id: recent.id }, { readyDate: addDaysYmd(today(), -7) });
  await run();
  const uncollected = await rows('garment.uncollected');
  expect(uncollected.map((r) => r.recipient.id)).toEqual([String(ops.user._id), String(ops.user._id)]);
  expect(uncollected[0].vars).toMatchObject({ count: 1, days: 7 });
  expect(uncollected[0].vars.list).toContain(old.garmentNo);
});

test('waits for the daily job time in IST', async () => {
  const { owner, take } = await setup();
  await makeLate((await take()).garments[0]);
  expect(await run('07:59')).toEqual({ branches: 0, queued: 0 });
  expect((await run('08:00')).queued).toBeGreaterThan(0);
  await Outbox.deleteMany({});
  await owner.agent.put('/v1/settings').send({ dailyJobTime: '09:30' });
  expect((await run('09:29', 1)).queued).toBe(0);
  expect((await run('09:30', 1)).queued).toBeGreaterThan(0);
});

test('re-running the checks queues nothing new', async () => {
  const { take } = await setup();
  await makeLate((await take()).garments[0]);
  const first = await run('08:00');
  expect(first.queued).toBeGreaterThan(0);
  expect(await run('08:15')).toEqual({ branches: 1, queued: 0 });
  expect((await run('08:00', 1)).queued).toBe(first.queued);
});

test('held orders are left out of every check', async () => {
  const { ops, d1, vendor, take } = await setup();
  const order = await take({ days: 2 });
  await makeLate(order.garments[0]);
  const away = await act(d1, order.garments[0], { action: 'sent_to_vendor', vendorId: vendor.id, dueBackDate: today() });
  const fresh = (await ops.agent.get(`/v1/orders/${order.id}`)).body;
  await ops.agent.post(`/v1/orders/${order.id}/hold`).send({ version: fresh.version, reason: 'Client travelling' });
  expect(away.stageState).toBe('with_vendor');
  expect((await run('08:00', 1)).queued).toBe(0);
});

test('pickup risk follows the order pickup date, not a garment due date', async () => {
  const { take } = await setup();
  const soon = await take({ days: 2 });
  await Garment.updateOne({ _id: soon.garments[0].id }, { dueDate: addDaysYmd(today(), -1) });
  const later = await take({ days: 20 });
  await Garment.updateOne({ _id: later.garments[0].id }, { dueDate: addDaysYmd(today(), 2) });
  await run();
  expect([...new Set((await rows('pickup.at_risk')).map((r) => r.vars.orderNo))]).toEqual([soon.orderNo]);
});

test('inactive designers get no digests', async () => {
  const { owner, d1, take } = await setup();
  await makeLate((await take()).garments[0]);
  await owner.agent.patch(`/v1/users/${d1.user._id}`).send({ active: false });
  await run();
  expect(await rows('stage.late_digest')).toEqual([]);
});
