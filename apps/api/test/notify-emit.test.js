import { test, expect, vi } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { createTestUser } from './helpers/app.js';
import { emit } from '../src/core/notify/emit.js';
import { defineEvent, registerRecipientResolver } from '../src/core/notify/catalog.js';
import { Outbox, NotificationRule } from '../src/core/notify/models.js';
import { withTransaction } from '../src/core/db.js';
import { clock } from '../src/clock.js';
import mongoose from 'mongoose';
useTestDb();
const B = new mongoose.Types.ObjectId().toString();

defineEvent('test.client', { recipients: ['client'], channels: ['email'], templates: { email: { subject: 'S', body: 'B' } } });
let client;
registerRecipientResolver('client', async () => [client]);

test('fans out to owners on all channels, once', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  const args = { branchId: u.branchId, refId: 'r1', vars: { error: 'x' } };
  expect(await emit('system.backup_failed', args)).toBe(2);
  expect(await emit('system.backup_failed', args)).toBe(0);
  expect((await Outbox.find()).map((o) => o.channel).sort()).toEqual(['email', 'in_app']);
});
test('disabled rule sends nothing', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  await NotificationRule.create({ branchId: u.branchId, event: 'system.backup_failed', recipients: ['owner'], channels: ['email'], enabled: false });
  expect(await emit('system.backup_failed', { branchId: u.branchId, refId: 'r' })).toBe(0);
});
test('client email held until quiet hours end', async () => {
  vi.spyOn(clock, 'now').mockReturnValue(new Date('2026-10-22T16:30:00Z'));
  client = { kind: 'client', id: 'c1', name: 'Asha', addresses: { email: 'asha@x.com' }, consent: { email: true } };
  await emit('test.client', { branchId: B, refId: 'r' });
  expect((await Outbox.findOne()).scheduledFor).toEqual(new Date('2026-10-23T03:30:00Z'));
  vi.restoreAllMocks();
});
test('skips client without consent', async () => {
  client = { kind: 'client', id: 'c2', name: 'B', addresses: { email: 'b@x.com' }, consent: { email: false } };
  await emit('test.client', { branchId: B, refId: 'r' });
  expect(await Outbox.findOne()).toMatchObject({ status: 'skipped', skipReason: 'no_consent' });
});
test('skips recipient without address', async () => {
  client = { kind: 'client', id: 'c3', name: 'C', addresses: {}, consent: { email: true } };
  await emit('test.client', { branchId: B, refId: 'r' });
  expect(await Outbox.findOne()).toMatchObject({ status: 'skipped', skipReason: 'no_address' });
});
test('nothing written when transaction aborts', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  await expect(withTransaction(async (session) => { await emit('system.job_failed', { branchId: u.branchId, refId: 'r' }, { session }); throw new Error('abort'); })).rejects.toThrow();
  expect(await Outbox.countDocuments()).toBe(0);
});
test('unknown event', async () => { await expect(emit('nope', { branchId: B, refId: 'r' })).rejects.toThrow('Unknown notification event'); });

test('a user matching two roles gets one message per channel', async () => {
  const u = await createTestUser({ roles: ['admin', 'operations'] });
  defineEvent('test.staff', { recipients: ['owner', 'operations'], channels: ['in_app'], templates: { in_app: { body: 'x' } } });
  expect(await emit('test.staff', { branchId: u.branchId, refId: 'r' })).toBe(1);
});
test('a new sequence number creates new entries (e.g. a second reminder)', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  expect(await emit('system.storage_warning', { branchId: u.branchId, refId: 'r', sequence: 1 })).toBe(2);
  expect(await emit('system.storage_warning', { branchId: u.branchId, refId: 'r', sequence: 2 })).toBe(2);
  const keys = (await Outbox.find().lean()).map((o) => o.dedupeKey).sort();
  expect(keys[0]).toMatch(/^system\.storage_warning:r:1:email:user:/);
});
test('password reset goes to the user from data.userId, on time and with addresses kept', async () => {
  const u = await createTestUser({ roles: ['designer'], email: 'd@x.com' });
  vi.spyOn(clock, 'now').mockReturnValue(new Date('2026-10-22T16:30:00Z')); // 22:00 IST: staff are never held
  expect(await emit('auth.password_reset', { branchId: u.branchId, refId: 'reset1', data: { userId: u._id } })).toBe(1);
  const entry = await Outbox.findOne().lean();
  vi.restoreAllMocks();
  expect(entry).toMatchObject({
    branchId: String(u.branchId), channel: 'email', status: 'pending', isFallback: false, attempts: 0,
    recipient: { kind: 'user', id: String(u._id), address: 'd@x.com', addresses: { email: 'd@x.com', in_app: String(u._id) } },
  });
  expect(entry.scheduledFor).toEqual(new Date('2026-10-22T16:30:00Z'));
});
test('notBefore holds a message', async () => {
  const now = new Date('2026-10-22T06:30:00Z');
  vi.spyOn(clock, 'now').mockReturnValue(now);
  const u = await createTestUser({ roles: ['admin'] });
  client = { kind: 'client', id: 'c3', name: 'C', addresses: { email: 'c@x.com' }, consent: { email: true } };
  const later = new Date(now.getTime() + 120_000);
  await emit('test.client', { branchId: B, refId: 'nb1' }, { notBefore: later });
  await emit('system.backup_failed', { branchId: u.branchId, refId: 'nb2' }, { notBefore: later });
  await emit('test.client', { branchId: B, refId: 'nb3' }, { notBefore: new Date(now.getTime() - 60_000) });
  const when = async (refId) => (await Outbox.findOne({ dedupeKey: new RegExp(`:${refId}:`) })).scheduledFor;
  expect(await when('nb1')).toEqual(later);
  expect(await when('nb2')).toEqual(later);
  expect(await when('nb3')).toEqual(now);
  vi.restoreAllMocks();
});
