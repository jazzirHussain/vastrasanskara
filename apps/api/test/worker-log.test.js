import { test, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, createTestUser } from './helpers/app.js';
import { logger } from '../src/logger.js';
import { defineJob } from '../src/core/jobs/registry.js';
import { runJob } from '../src/core/jobs/runJob.js';
import { startWorker } from '../src/core/jobs/worker.js';
import '../src/jobs.js';
import { emit } from '../src/core/notify/emit.js';
import { deliverDue } from '../src/core/notify/deliver.js';
import { registerAdapter, resetAdapters } from '../src/core/notify/adapters/registry.js';
useTestDb();
afterEach(() => { vi.restoreAllMocks(); resetAdapters(); });

// Every log call as [level, fields, message].
function spyLogs() {
  const calls = [];
  for (const level of ['debug', 'info', 'warn', 'error']) {
    vi.spyOn(logger, level).mockImplementation((fields, msg) => { calls.push([level, fields, msg]); });
  }
  return calls;
}

test('each job run is logged with its duration; quiet jobs only at debug', async () => {
  defineJob('t-log-ok', { schedule: null, handler: async () => {} });
  defineJob('t-log-quiet', { schedule: null, quiet: true, handler: async () => {} });
  const calls = spyLogs();
  await runJob('t-log-ok', {});
  await runJob('t-log-quiet', {});
  expect(calls).toContainEqual(['info', expect.objectContaining({ job: 't-log-ok', ms: expect.any(Number) }), expect.stringMatching(/^job t-log-ok done in \d+ms$/)]);
  expect(calls.find(([, f]) => f?.job === 't-log-quiet')[0]).toBe('debug');
});
test('heartbeat and deliver-outbox are quiet jobs', async () => {
  const calls = spyLogs();
  await runJob('heartbeat', {});
  expect(calls.filter(([, f]) => f?.job === 'heartbeat').map(([level]) => level)).toEqual(['debug']);
});
test('worker start lists the scheduled jobs', async () => {
  const calls = spyLogs();
  const { stop } = await startWorker({ config: { env: 'test' } });
  await stop();
  const start = calls.find(([, , msg]) => msg?.startsWith('worker started'));
  expect(start[0]).toBe('info');
  expect(start[1].jobs).toEqual(expect.arrayContaining(['heartbeat', 'deliver-outbox', 'backup', 'storage-check']));
});
test('queued, sent and failed notifications are logged without addresses', async () => {
  const u = await createTestUser({ roles: ['admin'], email: 'owner-log@x.com' });
  registerAdapter({ channel: 'email', provider: 'fake', capabilities: {}, send: async () => { throw new Error('smtp down'); } });
  registerAdapter({ channel: 'in_app', provider: 'fake-in-app', capabilities: {}, send: async () => ({ providerMessageId: 'm', status: 'delivered' }) });
  const calls = spyLogs();
  await emit('system.backup_failed', { branchId: u.branchId, refId: 'r', vars: { error: 'x' } });
  await deliverDue();
  expect(calls).toContainEqual(['info', expect.objectContaining({ event: 'system.backup_failed', queued: 2 }), 'queued 2 notifications for system.backup_failed']);
  expect(calls).toContainEqual(['info', expect.objectContaining({ channel: 'in_app', event: 'system.backup_failed', recipient: `user:${u._id}` }), expect.stringMatching(/^delivered in_app system\.backup_failed/)]);
  expect(calls).toContainEqual(['warn', expect.objectContaining({ channel: 'email', attempts: 1, error: 'smtp down' }), expect.stringMatching(/^email system\.backup_failed failed \(attempt 1\), retrying at /)]);
  expect(JSON.stringify(calls)).not.toContain('owner-log@x.com');
});
test('webhook deliveries are logged', async () => {
  registerAdapter({ channel: 'sms', provider: 'fake-sms', capabilities: {}, send: async () => ({}), parseWebhook: async (req) => req.body.events });
  const calls = spyLogs();
  await request(buildTestApp()).post('/v1/webhooks/fake-sms').send({ events: [{ providerMessageId: 'p', status: 'delivered' }] });
  expect(calls).toContainEqual(['info', expect.objectContaining({ provider: 'fake-sms', events: 1 }), 'webhook from fake-sms: 1 status update']);
});
