import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { useTestDb } from './helpers/db.js';
import { createTestUser } from './helpers/app.js';
import { emit } from '../src/core/notify/emit.js';
import { defineEvent } from '../src/core/notify/catalog.js';
import { Notification, Outbox } from '../src/core/notify/models.js';
import { deliverDue } from '../src/core/notify/deliver.js';
import { registerAdapter, resetAdapters } from '../src/core/notify/adapters/registry.js';
import { createInAppAdapter } from '../src/core/notify/adapters/inApp.js';
import { clock } from '../src/clock.js';
useTestDb();
defineEvent('test.fb', { recipients: ['owner'], channels: ['email'], fallback: 'in_app', templates: { email: { subject: 'S {n}', body: 'B {n}' }, in_app: { body: 'B {n}' } } });
const fake = { channel: 'email', provider: 'fake', capabilities: { attachments: true, templatesOnly: false }, send: vi.fn() };
const now = new Date('2026-10-22T06:00:00Z');
// emit() schedules at clock.now(); pin it to `now` so entries are due regardless of the real date.
beforeEach(() => { resetAdapters(); registerAdapter(fake); registerAdapter(createInAppAdapter()); fake.send.mockReset(); vi.spyOn(clock, 'now').mockReturnValue(now); });
afterEach(() => { vi.restoreAllMocks(); });

test('sends due entries with rendered content', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  fake.send.mockResolvedValue({ providerMessageId: 'm1', status: 'sent' });
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: { n: '7' } });
  expect(await deliverDue({ now })).toMatchObject({ sent: 1 });
  expect(fake.send.mock.calls[0][0]).toMatchObject({ to: u.email, subject: 'S 7', text: expect.stringContaining('B 7') });
  expect(await Outbox.findOne()).toMatchObject({ status: 'sent', providerMessageId: 'm1' });
});
test('future entries wait', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: { n: 1 } });
  await Outbox.updateMany({}, { scheduledFor: new Date(now.getTime() + 60_000) });
  expect(await deliverDue({ now })).toMatchObject({ sent: 0 });
});
test('retries with backoff then falls back', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  fake.send.mockRejectedValue(new Error('down'));
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: { n: 1 } });
  await deliverDue({ now });
  expect((await Outbox.findOne({ channel: 'email' })).scheduledFor).toEqual(new Date(now.getTime() + 60_000));
  for (let i = 0; i < 4; i++) await deliverDue({ now: new Date(now.getTime() + 24 * 3600_000 * (i + 1)) });
  expect(await Outbox.findOne({ channel: 'email' })).toMatchObject({ status: 'failed', attempts: 5 });
  await deliverDue({ now: new Date(now.getTime() + 6 * 24 * 3600_000) });
  expect(await Notification.countDocuments({ userId: u._id })).toBe(1);
});
test('reclaims stale sending entries', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  fake.send.mockResolvedValue({ providerMessageId: 'm', status: 'sent' });
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: { n: 1 } });
  await Outbox.updateMany({}, { status: 'sending', lockedAt: new Date(now.getTime() - 11 * 60_000) });
  expect(await deliverDue({ now })).toMatchObject({ sent: 1 });
});
test('concurrent runs send once', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  fake.send.mockResolvedValue({ providerMessageId: 'm', status: 'sent' });
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: { n: 1 } });
  await Promise.all([deliverDue({ now }), deliverDue({ now })]);
  expect(fake.send).toHaveBeenCalledTimes(1);
});

test('backoff steps are 1, 5, 15 and 60 minutes', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  fake.send.mockRejectedValue(new Error('down'));
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: { n: 1 } });
  let at = now;
  for (const minutes of [1, 5, 15, 60]) {
    await deliverDue({ now: at });
    const entry = await Outbox.findOne({ channel: 'email' });
    expect(entry.scheduledFor).toEqual(new Date(at.getTime() + minutes * 60_000));
    at = entry.scheduledFor;
  }
});
test('a template that cannot render fails at once, without retries or fallback', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: {} });
  expect(await deliverDue({ now })).toMatchObject({ sent: 0, failed: 1 });
  expect(await Outbox.findOne({ channel: 'email' })).toMatchObject({ status: 'failed', attempts: 1, lastError: expect.stringContaining('n') });
  expect(fake.send).not.toHaveBeenCalled();
  expect(await Outbox.countDocuments()).toBe(1);
});
test('attachments are read from storage', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  fake.send.mockResolvedValue({ providerMessageId: 'm', status: 'sent' });
  const storage = { getObject: vi.fn(async () => Readable.from([Buffer.from('%PDF')])) };
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: { n: 1 }, attachments: [{ key: 'k/inv.pdf', filename: 'INV-1.pdf' }] });
  await deliverDue({ now, storage });
  expect(storage.getObject).toHaveBeenCalledWith('k/inv.pdf');
  const [attachment] = fake.send.mock.calls[0][0].attachments;
  expect(attachment.filename).toBe('INV-1.pdf');
});
test('in-app messages are delivered with the rendered text and link', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  await emit('system.job_failed', { branchId: u.branchId, refId: 'r', vars: { job: 'backup', error: 'disk', link: '/admin/jobs' } });
  fake.send.mockResolvedValue({ providerMessageId: 'm', status: 'sent' });
  await deliverDue({ now });
  expect(await Outbox.findOne({ channel: 'in_app' })).toMatchObject({ status: 'delivered' });
  expect(await Notification.findOne({ userId: u._id }).lean()).toMatchObject({
    event: 'system.job_failed', message: 'The background job "backup" failed: disk', link: '/admin/jobs', read: false,
  });
});
