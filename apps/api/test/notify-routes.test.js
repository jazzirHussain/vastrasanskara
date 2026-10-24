import { test, expect } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { Notification } from '../src/core/notify/models.js';
import { Outbox } from '../src/core/notify/models.js';
import { registerAdapter } from '../src/core/notify/adapters/registry.js';
useTestDb();
const app = buildTestApp();

test('lists own notifications with unread count', async () => {
  const { agent, user } = await loginAs(app, { roles: ['operations'] });
  const { user: other } = await loginAs(app, { roles: ['operations'] });
  await Notification.create([{ branchId: user.branchId, userId: user._id, event: 'e', message: 'm' }, { branchId: user.branchId, userId: other._id, event: 'e', message: 'x' }]);
  const r = await agent.get('/v1/notifications');
  expect(r.body.items).toHaveLength(1); expect(r.body.unreadCount).toBe(1);
});
test('cannot mark another user notification', async () => {
  const { agent, user } = await loginAs(app, { roles: ['operations'] });
  const { user: other } = await loginAs(app, { roles: ['operations'] });
  const n = await Notification.create({ branchId: user.branchId, userId: other._id, event: 'e', message: 'x' });
  expect((await agent.post(`/v1/notifications/${n._id}/read`).send({})).status).toBe(404);
});
test('webhook updates delivery status', async () => {
  registerAdapter({ channel: 'whatsapp', provider: 'fakewa', capabilities: {}, send: async () => ({}), parseWebhook: async (req) => req.body.events });
  await Outbox.create({ branchId: 'b', event: 'e', channel: 'whatsapp', recipient: { kind: 'client', id: 'c' }, status: 'sent', providerMessageId: 'p1', dedupeKey: 'd', scheduledFor: new Date() });
  const r = await request(app).post('/v1/webhooks/fakewa').send({ events: [{ providerMessageId: 'p1', status: 'delivered', at: '2026-10-22T06:00:00Z' }] });
  expect(r.status).toBe(200);
  expect(await Outbox.findOne({ providerMessageId: 'p1' })).toMatchObject({ status: 'delivered' });
  expect((await request(app).post('/v1/webhooks/nope').send({})).status).toBe(404);
});
test('admin sees and retries failed entries', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  const o = await Outbox.create({ branchId: String(user.branchId), event: 'e', channel: 'email', recipient: { kind: 'user', id: 'u' }, status: 'failed', attempts: 5, dedupeKey: 'f', scheduledFor: new Date() });
  expect((await agent.get('/v1/admin/outbox').query({ status: 'failed' })).body.items).toHaveLength(1);
  await agent.post(`/v1/admin/outbox/${o._id}/retry`).send({});
  expect(await Outbox.findById(o._id)).toMatchObject({ status: 'pending', attempts: 0 });
  const { agent: ops } = await loginAs(app, { roles: ['operations'] });
  expect((await ops.get('/v1/admin/outbox')).status).toBe(403);
});

test('unread filter, mark read and read-all', async () => {
  const { agent, user } = await loginAs(app, { roles: ['operations'] });
  const [a] = await Notification.create([
    { branchId: user.branchId, userId: user._id, event: 'e', message: '1' },
    { branchId: user.branchId, userId: user._id, event: 'e', message: '2' },
    { branchId: user.branchId, userId: user._id, event: 'e', message: '3', read: true },
  ]);
  expect((await agent.get('/v1/notifications').query({ unread: 'true' })).body.items).toHaveLength(2);
  expect((await agent.post(`/v1/notifications/${a._id}/read`)).status).toBe(204);
  expect((await agent.get('/v1/notifications')).body).toMatchObject({ unreadCount: 1 });
  expect((await agent.post('/v1/notifications/read-all')).status).toBe(204);
  const all = await agent.get('/v1/notifications');
  expect(all.body.unreadCount).toBe(0);
  expect(all.body.items[0]).toEqual({ id: expect.any(String), event: 'e', message: expect.any(String), link: null, read: true, createdAt: expect.any(String) });
  expect((await agent.post('/v1/notifications/not-an-id/read')).status).toBe(404);
});
test('webhooks never move a message backwards and ignore unknown ids', async () => {
  registerAdapter({ channel: 'whatsapp', provider: 'fakewa2', capabilities: {}, send: async () => ({}), parseWebhook: async (req) => req.body.events });
  await Outbox.create({ branchId: 'b', event: 'e', channel: 'whatsapp', recipient: { kind: 'client', id: 'c' }, status: 'delivered', providerMessageId: 'p2', dedupeKey: 'd2', scheduledFor: new Date() });
  await Outbox.create({ branchId: 'b', event: 'e', channel: 'whatsapp', recipient: { kind: 'client', id: 'c' }, status: 'sent', providerMessageId: 'p3', dedupeKey: 'd3', scheduledFor: new Date() });
  const r = await request(app).post('/v1/webhooks/fakewa2').send({ events: [
    { providerMessageId: 'p2', status: 'sent', at: '2026-10-22T06:00:00Z' },
    { providerMessageId: 'p3', status: 'failed', at: '2026-10-22T06:00:00Z', error: 'number unreachable' },
    { providerMessageId: 'zzz', status: 'delivered', at: '2026-10-22T06:00:00Z' },
  ] });
  expect(r.status).toBe(200);
  expect(await Outbox.findOne({ providerMessageId: 'p2' })).toMatchObject({ status: 'delivered' });
  expect(await Outbox.findOne({ providerMessageId: 'p3' })).toMatchObject({ status: 'failed', lastError: 'number unreachable' });
});
test('webhook adapters receive the raw body for signature checks', async () => {
  let raw;
  registerAdapter({ channel: 'sms', provider: 'fakesms', capabilities: {}, send: async () => ({}), parseWebhook: async (req) => { raw = req.rawBody.toString(); return []; } });
  await request(app).post('/v1/webhooks/fakesms').set('Content-Type', 'application/json').send('{"a": 1}');
  expect(raw).toBe('{"a": 1}');
});
test('admin outbox is limited to the admin branch; only failed entries can be retried', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  const elsewhere = await Outbox.create({ branchId: new mongoose.Types.ObjectId().toString(), event: 'e', channel: 'email', recipient: { kind: 'user', id: 'u' }, status: 'failed', dedupeKey: 'x1', scheduledFor: new Date() });
  const sent = await Outbox.create({ branchId: String(user.branchId), event: 'e', channel: 'email', recipient: { kind: 'user', id: 'u' }, status: 'sent', dedupeKey: 'x2', scheduledFor: new Date() });
  expect((await agent.get('/v1/admin/outbox').query({ status: 'failed' })).body.items).toHaveLength(0);
  expect((await agent.post(`/v1/admin/outbox/${elsewhere._id}/retry`)).status).toBe(404);
  expect((await agent.post(`/v1/admin/outbox/${sent._id}/retry`)).status).toBe(409);
});
