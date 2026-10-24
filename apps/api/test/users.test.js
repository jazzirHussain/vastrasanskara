import { test, expect, vi } from 'vitest';
import request from 'supertest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs, api } from './helpers/app.js';
import { Outbox } from '../src/core/notify/models.js';
import { AuditLog } from '../src/core/audit/model.js';
import { clock } from '../src/clock.js';
import { deliverDue } from '../src/core/notify/deliver.js';
import { registerAdapter, resetAdapters } from '../src/core/notify/adapters/registry.js';
useTestDb();
const app = buildTestApp();
const tokenFromOutbox = async () => new URL((await Outbox.findOne({ event: { $in: ['auth.password_reset', 'auth.invite'] } }).sort({ _id: -1 })).vars.resetUrl).searchParams.get('token');

test('admin creates user and invite is queued', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  const r = await agent.post('/v1/users').send({ name: 'Riya', email: 'Riya@X.com', roles: ['designer'] });
  expect(r.status).toBe(201); expect(r.body.email).toBe('riya@x.com');
  expect(await tokenFromOutbox()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await agent.post('/v1/users').send({ name: 'R', email: 'riya@x.com', roles: ['designer'] })).body.error.code).toBe('EMAIL_TAKEN');
});
test('role change logs the user out', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  const { agent: d, user } = await loginAs(app, { roles: ['designer'] });
  await agent.patch(`/v1/users/${user._id}`).send({ roles: ['operations'] });
  expect((await d.get('/v1/auth/me')).status).toBe(401);
});
test('guards self-deactivation and last admin', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  expect((await agent.patch(`/v1/users/${user._id}`).send({ active: false })).body.error.code).toBe('CANNOT_DEACTIVATE_SELF');
  expect((await agent.patch(`/v1/users/${user._id}`).send({ roles: ['operations'] })).body.error.code).toBe('LAST_ADMIN');
});
test('password reset flow', async () => {
  const { user } = await loginAs(app, { roles: ['operations'] });
  const anon = api(request(app));
  expect((await anon.post('/v1/auth/password-reset/request').send({ email: 'nobody@x.com' })).status).toBe(204);
  expect(await Outbox.countDocuments({ event: 'auth.password_reset' })).toBe(0);
  await anon.post('/v1/auth/password-reset/request').send({ email: user.email });
  const token = await tokenFromOutbox();
  expect((await anon.post('/v1/auth/password-reset/confirm').send({ token, password: 'short' })).status).toBe(400);
  expect((await anon.post('/v1/auth/password-reset/confirm').send({ token, password: 'brand-new-pass-1' })).status).toBe(204);
  expect((await anon.post('/v1/auth/password-reset/confirm').send({ token, password: 'brand-new-pass-2' })).body.error.code).toBe('RESET_TOKEN_INVALID');
  expect((await anon.post('/v1/auth/login').send({ email: user.email, password: 'brand-new-pass-1' })).status).toBe(200);
});
test('expired reset token', async () => {
  const { user } = await loginAs(app, { roles: ['operations'] });
  const anon = api(request(app));
  await anon.post('/v1/auth/password-reset/request').send({ email: user.email });
  const token = await tokenFromOutbox();
  vi.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + 31 * 60_000));
  expect((await anon.post('/v1/auth/password-reset/confirm').send({ token, password: 'brand-new-pass-1' })).body.error.code).toBe('RESET_TOKEN_INVALID');
  vi.restoreAllMocks();
});

test('only users.manage may manage users; listing shows the branch without secrets', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  const list = await agent.get('/v1/users');
  expect(list.body.items).toEqual([{ id: String(user._id), name: user.name, email: user.email, roles: ['admin'], active: true, createdAt: expect.any(String) }]);
  const { agent: ops } = await loginAs(app, { roles: ['operations'] });
  expect((await ops.get('/v1/users')).status).toBe(403);
  expect((await ops.post('/v1/users').send({ name: 'x', email: 'x@x.com', roles: ['admin'] })).status).toBe(403);
});
test('user changes are audited; deactivation logs out; another admin can be demoted', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  const { agent: other, user: second } = await loginAs(app, { roles: ['admin'] });
  const r = await agent.patch(`/v1/users/${second._id}`).send({ roles: ['operations'], name: 'Second' });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ roles: ['operations'], name: 'Second' });
  const audit = await AuditLog.findOne({ entityType: 'user', action: 'update' }).lean();
  expect(audit.changes.map((c) => c.path)).toEqual(['name', 'roles']);
  await agent.patch(`/v1/users/${second._id}`).send({ active: false });
  expect((await other.get('/v1/auth/me')).status).toBe(401);
  expect((await agent.patch('/v1/users/000000000000000000000000').send({ name: 'x' })).status).toBe(404);
});
test('invite links last 3 days; a reset clears lockout and signs out everywhere', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  await agent.post('/v1/users').send({ name: 'Riya', email: 'riya@x.com', roles: ['designer'] });
  const invite = await tokenFromOutbox();
  const anon = api(request(app));
  vi.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + 2 * 24 * 3600_000));
  expect((await anon.post('/v1/auth/password-reset/confirm').send({ token: invite, password: 'brand-new-pass-1' })).status).toBe(204);
  vi.restoreAllMocks();
  const { agent: d, user } = await loginAs(app, { roles: ['designer'] });
  for (let i = 0; i < 10; i++) await anon.post('/v1/auth/login').send({ email: user.email, password: 'wrong-password-1' });
  expect((await anon.post('/v1/auth/login').send({ email: user.email, password: 'correct-horse-1' })).status).toBe(423);
  await anon.post('/v1/auth/password-reset/request').send({ email: user.email });
  expect((await anon.post('/v1/auth/password-reset/confirm').send({ token: await tokenFromOutbox(), password: 'brand-new-pass-1' })).status).toBe(204);
  expect((await d.get('/v1/auth/me')).status).toBe(401);
  expect((await anon.post('/v1/auth/login').send({ email: user.email, password: 'brand-new-pass-1' })).status).toBe(200);
});
test('reset emails are rendered with the user name and link', async () => {
  const { user } = await loginAs(app, { roles: ['operations'], name: 'Asha' });
  await api(request(app)).post('/v1/auth/password-reset/request').send({ email: user.email });
  const entry = await Outbox.findOne({ event: 'auth.password_reset' }).lean();
  expect(entry.vars).toEqual({ name: 'Asha', resetUrl: expect.stringMatching(/^https:\/\/app\.test\/reset-password\?token=/), expiresIn: '30 minutes' });
  expect(entry.recipient.address).toBe(user.email);
});
test('new users get an invite email, not a reset email', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  await agent.post('/v1/users').send({ name: 'Riya', email: 'riya@x.com', roles: ['designer'] });
  const entry = await Outbox.findOne({ event: 'auth.invite' }).lean();
  expect(entry.vars).toMatchObject({ name: 'Riya', expiresIn: '3 days' });
  expect(await Outbox.countDocuments({ event: 'auth.password_reset' })).toBe(0);
  let sent;
  registerAdapter({ channel: 'email', provider: 'fake-email', capabilities: {}, send: async (m) => { sent = m; return { providerMessageId: 'i1', status: 'sent' }; } });
  await deliverDue();
  resetAdapters();
  expect(sent.subject).toBe('Set up your Vastrasanskara account');
  expect(sent.text).toContain('reset-password?token=');
  expect(sent.text).toContain('3 days');
});
