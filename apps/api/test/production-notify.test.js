import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { productionHelpers } from './helpers/production.js';
import { Outbox } from '../src/core/notify/models.js';
useTestDb();
const app = buildTestApp();

const { world, send, act, advanceTo } = productionHelpers(app);
const outbox = (event) => Outbox.find({ event }).sort({ _id: 1 }).lean();

async function setup() {
  const w = await world();
  const owner = await loginAs(app, { roles: ['admin'], name: 'Owner' });
  return { ...w, owner };
}

test('reaching trials notifies the designer and owner', async () => {
  const { d1, owner, take } = await setup();
  const order = await take();
  await advanceTo(d1, order.garments[0], 'trials_fittings');
  const rows = await outbox('garment.fitting_reached');
  expect(rows.map((r) => `${r.recipient.id}:${r.channel}`).sort()).toEqual(
    [`${d1.user._id}:email`, `${d1.user._id}:in_app`, `${owner.user._id}:email`, `${owner.user._id}:in_app`].sort(),
  );
  expect(rows[0].vars).toMatchObject({
    garmentNo: order.garments[0].garmentNo, description: 'Blouse', customerName: 'Asha Rao', orderNo: order.orderNo, link: `/orders/${order.id}`,
  });
});

test('QC fail notifies the designer and owner with the remarks', async () => {
  const { d1, take } = await setup();
  const atQc = await advanceTo(d1, (await take()).garments[0], 'quality_check');
  await act(d1, atQc, { action: 'qc_fail', reworkStage: 'handwork', remarks: 'Loose beads' });
  const rows = await outbox('qc.failed');
  expect(rows).toHaveLength(4);
  expect(rows[0].vars).toMatchObject({ stage: 'Quality check', reworkStage: 'Handwork', remarks: 'Loose beads' });
});

test('a ready garment emails a consenting client and skips one without consent', async () => {
  const { ops, d1, take } = await setup();
  const consenting = (
    await ops.agent.post('/v1/customers').send({
      name: 'Bhavna', phone: '9123456789', email: 'bhavna@example.com',
      consent: { email: true, whatsapp: false, sms: false }, consentNote: 'Asked at the counter',
    })
  ).body.id;
  for (const customer of [consenting, undefined]) {
    const order = await take(customer ? { customer } : {});
    await act(d1, await advanceTo(d1, order.garments[0], 'packaging'), { action: 'complete' });
  }
  const rows = await outbox('garment.ready_for_pickup');
  expect(rows.map((r) => [r.recipient.name, r.channel, r.status, r.skipReason ?? null])).toEqual([
    ['Bhavna', 'email', 'pending', null],
    ['Asha Rao', 'email', 'skipped', 'no_consent'],
  ]);
});

test('a failed action queues nothing', async () => {
  const { d1, take } = await setup();
  const atPackaging = await advanceTo(d1, (await take()).garments[0], 'packaging');
  const stale = await send(d1, [{ ...atPackaging, version: atPackaging.version - 1 }], { action: 'complete' });
  expect(stale.status).toBe(409);
  expect(await Outbox.countDocuments({ event: 'garment.ready_for_pickup' })).toBe(0);
});

test('the client message contains no price', async () => {
  const { d1, take } = await setup();
  await act(d1, await advanceTo(d1, (await take()).garments[0], 'packaging'), { action: 'complete' });
  const [row] = await outbox('garment.ready_for_pickup');
  const text = JSON.stringify(row);
  expect(text).not.toContain('450000');
  expect(text).not.toContain('4,500');
  expect(text).not.toContain('agreedPrice');
});
