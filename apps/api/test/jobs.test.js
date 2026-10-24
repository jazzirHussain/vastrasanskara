import { test, expect, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, createTestUser, loginAs } from './helpers/app.js';
import { defineJob, getJobDefinitions } from '../src/core/jobs/registry.js';
import { runJob } from '../src/core/jobs/runJob.js';
import '../src/jobs.js';
import { startWorker } from '../src/core/jobs/worker.js';
import { Outbox } from '../src/core/notify/models.js';
import { emit } from '../src/core/notify/emit.js';
import { registerAdapter, resetAdapters } from '../src/core/notify/adapters/registry.js';
import { clock } from '../src/clock.js';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
useTestDb();
const app = buildTestApp();

test('failed job is recorded and alerts the owner', async () => {
  await createTestUser({ roles: ['admin'] });
  defineJob('t-fail', { schedule: '1 hour', handler: async () => { throw new Error('boom'); } });
  expect(await runJob('t-fail', {})).toEqual({ ok: false });
  expect(await mongoose.connection.collection('jobFailures').countDocuments({ job: 't-fail' })).toBe(1);
  expect(await Outbox.countDocuments({ event: 'system.job_failed' })).toBe(2);
});
test('health reports stale worker, then ok after heartbeat', async () => {
  expect((await request(app).get('/v1/health')).status).toBe(503);
  await runJob('heartbeat', {});
  const r = await request(app).get('/v1/health');
  expect(r.status).toBe(200); expect(r.body).toEqual({ db: 'ok', worker: 'ok' });
});
test('worker schedules core jobs', async () => {
  const { stop } = await startWorker({ config: { env: 'test' } });
  expect([...getJobDefinitions().keys()]).toEqual(expect.arrayContaining(['heartbeat', 'deliver-outbox']));
  await stop();
});

test('a failing one-off job retries after 1, 5 and 15 minutes, then stops', async () => {
  vi.spyOn(clock, 'now').mockReturnValue(new Date('2026-10-22T06:00:00Z'));
  defineJob('t-once', { schedule: null, retries: 3, handler: async () => { throw new Error('flaky'); } });
  const agenda = { schedule: vi.fn() };
  for (const attempt of [1, 2, 3, 4]) await runJob('t-once', { agenda, attempt });
  vi.mocked(clock.now).mockRestore();
  expect(agenda.schedule.mock.calls).toEqual([
    [new Date('2026-10-22T06:01:00Z'), 't-once', { attempt: 2 }],
    [new Date('2026-10-22T06:05:00Z'), 't-once', { attempt: 3 }],
    [new Date('2026-10-22T06:15:00Z'), 't-once', { attempt: 4 }],
  ]);
  expect(await mongoose.connection.collection('jobFailures').find({ job: 't-once' }).map((f) => f.attempt).toArray()).toEqual([1, 2, 3, 4]);
});
test('a heartbeat older than 3 minutes is stale', async () => {
  await runJob('heartbeat', {});
  vi.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + 4 * 60_000));
  const r = await request(app).get('/v1/health');
  vi.restoreAllMocks();
  expect(r.status).toBe(503);
  expect(r.body).toEqual({ db: 'ok', worker: 'stale' });
});
test('admins see job failures newest first; others are refused', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  defineJob('t-a', { schedule: '1 hour', handler: async () => { throw new Error('first'); } });
  defineJob('t-b', { schedule: '1 hour', handler: async () => { throw new Error('second'); } });
  await runJob('t-a', {});
  await runJob('t-b', {});
  const r = await agent.get('/v1/admin/jobs/failures');
  expect(r.status).toBe(200);
  expect(r.body.items.map((f) => [f.job, f.error])).toEqual([['t-b', 'second'], ['t-a', 'first']]);
  const { agent: ops } = await loginAs(app, { roles: ['operations'] });
  expect((await ops.get('/v1/admin/jobs/failures')).status).toBe(403);
});
test('deliver-outbox sends due messages', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  resetAdapters();
  const send = vi.fn(async () => ({ providerMessageId: 'm', status: 'sent' }));
  registerAdapter({ channel: 'email', provider: 'fake', capabilities: { attachments: false }, send });
  registerAdapter({ channel: 'in_app', provider: 'fake-in-app', capabilities: { attachments: false }, send });
  await emit('system.backup_failed', { branchId: u.branchId, refId: 'r', vars: { error: 'x' } });
  expect(await runJob('deliver-outbox', {})).toEqual({ ok: true });
  expect(send).toHaveBeenCalledTimes(2);
  resetAdapters();
});
test('every jobs.js file is listed in src/jobs.js', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const jobFiles = readdirSync(src, { recursive: true })
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => f.endsWith('/jobs.js'));
  const list = readFileSync(path.join(src, 'jobs.js'), 'utf8');
  expect(jobFiles.length).toBeGreaterThanOrEqual(3);
  for (const file of jobFiles) expect(list).toContain(`import './${file}';`);
});
