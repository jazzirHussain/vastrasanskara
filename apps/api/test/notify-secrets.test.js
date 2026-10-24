import { test, expect, afterEach } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { Outbox } from '../src/core/notify/models.js';
import { emit } from '../src/core/notify/emit.js';
import { deliverDue } from '../src/core/notify/deliver.js';
import { registerAdapter, resetAdapters } from '../src/core/notify/adapters/registry.js';
import { User } from '../src/modules/users/model.js';
useTestDb();
afterEach(() => resetAdapters());
const app = buildTestApp();

const VARS = { name: 'Asha', resetUrl: 'https://app.test/reset-password?token=secret-token-value', expiresIn: '30 minutes' };
const fakeEmail = (send = async () => ({ providerMessageId: 'm1', status: 'sent' })) =>
  registerAdapter({ channel: 'email', provider: 'fake-email', capabilities: {}, send });

test('admin outbox never returns vars or addresses', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  await emit('auth.password_reset', { branchId: user.branchId, refId: 'r1', data: { userId: user._id }, vars: VARS });
  const r = await agent.get('/v1/admin/outbox');
  expect(r.status).toBe(200);
  expect(r.body.items).toHaveLength(1);
  expect(Object.keys(r.body.items[0]).sort()).toEqual(
    ['attempts', 'channel', 'createdAt', 'deliveredAt', 'event', 'id', 'isFallback', 'lastError', 'recipient', 'scheduledFor', 'sentAt', 'skipReason', 'status'],
  );
  expect(r.body.items[0].recipient).toEqual({ kind: 'user', id: String(user._id), name: user.name });
  expect(JSON.stringify(r.body)).not.toMatch(/token=|resetUrl|@/);
});
test('secret vars are removed once a message is final', async () => {
  const { user } = await loginAs(app, { roles: ['operations'] });
  let sent;
  fakeEmail(async (message) => { sent = message; return { providerMessageId: 'm1', status: 'sent' }; });
  await emit('auth.password_reset', { branchId: user.branchId, refId: 'r2', data: { userId: user._id }, vars: VARS });
  await deliverDue();
  expect(sent.text).toContain('token=secret-token-value');
  const entry = await Outbox.findOne({ event: 'auth.password_reset' }).lean();
  expect(entry.status).toBe('sent');
  expect(entry.vars).toEqual({ name: 'Asha', expiresIn: '30 minutes' });
});
test('a message that fails for good also loses its secret vars', async () => {
  const { user } = await loginAs(app, { roles: ['operations'] });
  fakeEmail(async () => { throw new Error('down'); });
  await Outbox.create({
    branchId: String(user.branchId), event: 'auth.password_reset', channel: 'email', dedupeKey: 'final',
    recipient: { kind: 'user', id: String(user._id), name: 'Asha', address: user.email }, vars: VARS,
    status: 'pending', attempts: 4, scheduledFor: new Date(0),
  });
  await deliverDue();
  const entry = await Outbox.findOne({ dedupeKey: 'final' }).lean();
  expect(entry.status).toBe('failed');
  expect(entry.vars.resetUrl).toBeUndefined();
});
test('a skipped message never stores secret vars', async () => {
  const { user } = await loginAs(app, { roles: ['operations'] });
  await User.collection.updateOne({ _id: user._id }, { $set: { email: null } });
  await emit('auth.password_reset', { branchId: user.branchId, refId: 'r3', data: { userId: user._id }, vars: VARS });
  const entry = await Outbox.findOne({ event: 'auth.password_reset' }).lean();
  expect(entry).toMatchObject({ status: 'skipped', skipReason: 'no_address' });
  expect(entry.vars).toEqual({ name: 'Asha', expiresIn: '30 minutes' });
});
