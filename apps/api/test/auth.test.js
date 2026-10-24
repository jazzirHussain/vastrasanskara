import { test, expect, vi } from 'vitest';
import request from 'supertest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, api, createTestUser, loginAs } from './helpers/app.js';
import { clock } from '../src/clock.js';
import { requirePermission } from '../src/core/auth/middleware.js';
import { revokeUserSessions } from '../src/core/auth/sessions.js';
import { AuditLog } from '../src/core/audit/model.js';
useTestDb();
const app = buildTestApp({ mount: (a) => a.get('/t/money', requirePermission('money.view'), (req, res) => res.json({ ok: 1 })) });
const login = (email, password) => api(request(app)).post('/v1/auth/login').send({ email, password });

test('logs in and sets strict cookie', async () => {
  await createTestUser({ roles: ['admin'], email: 'owner@example.com' });
  const r = await login('owner@example.com', 'correct-horse-1');
  expect(r.status).toBe(200);
  expect(r.body.user.permissions).toContain('settings.edit');
  expect(r.headers['set-cookie'][0]).toMatch(/^sid=.*HttpOnly.*SameSite=Strict/i);
});
test('logs in with differently-cased email', async () => {
  await createTestUser({ roles: ['admin'], email: 'owner@example.com' });
  expect((await login('Owner@Example.com', 'correct-horse-1')).status).toBe(200);
});
test('wrong password and inactive user', async () => {
  await createTestUser({ roles: ['admin'], email: 'a@x.com' });
  await createTestUser({ roles: ['admin'], email: 'b@x.com', active: false });
  expect((await login('a@x.com', 'wrong-pass-12')).body.error.code).toBe('INVALID_CREDENTIALS');
  expect((await login('b@x.com', 'correct-horse-1')).body.error.code).toBe('INVALID_CREDENTIALS');
  expect(await AuditLog.countDocuments({ action: 'login_failed' })).toBe(2); // every failed attempt on an existing account
});
test('locks after 10 failures for 15 minutes', async () => {
  await createTestUser({ roles: ['admin'], email: 'a@x.com' });
  for (let i = 0; i < 10; i++) await login('a@x.com', 'wrong-pass-12');
  expect((await login('a@x.com', 'correct-horse-1')).status).toBe(423);
  vi.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + 16 * 60_000));
  expect((await login('a@x.com', 'correct-horse-1')).status).toBe(200);
  vi.restoreAllMocks();
});
test('me, logout, absolute expiry', async () => {
  const { agent } = await loginAs(app, { roles: ['operations'] });
  expect((await agent.get('/v1/auth/me')).status).toBe(200);
  vi.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + 8 * 24 * 3600_000));
  expect((await agent.get('/v1/auth/me')).body.error.code).toBe('SESSION_EXPIRED');
  vi.restoreAllMocks();
});
test('permission check and revocation', async () => {
  const { agent, user } = await loginAs(app, { roles: ['designer'] });
  expect((await agent.get('/t/money')).status).toBe(403);
  await revokeUserSessions(user._id);
  expect((await agent.get('/v1/auth/me')).status).toBe(401);
});
test('unauthenticated me', async () => {
  expect((await request(app).get('/v1/auth/me')).body.error.code).toBe('NOT_AUTHENTICATED');
});

test('me returns the user without secrets; logout ends the session', async () => {
  const { agent, user } = await loginAs(app, { roles: ['designer'] });
  const me = await agent.get('/v1/auth/me');
  expect(me.body).toEqual({
    id: String(user._id), name: user.name, email: user.email, roles: ['designer'],
    permissions: [...me.body.permissions].sort(), branchId: String(user.branchId),
  });
  expect(me.body.permissions).not.toContain('money.view');
  expect((await agent.post('/v1/auth/logout')).status).toBe(204);
  expect((await agent.get('/v1/auth/me')).status).toBe(401);
});
test('login issues a fresh session id and audits without the email', async () => {
  await createTestUser({ roles: ['admin'], email: 'owner@example.com' });
  const agent = request.agent(app);
  const first = await api(agent).post('/v1/auth/login').send({ email: 'owner@example.com', password: 'correct-horse-1' });
  const second = await api(agent).post('/v1/auth/login').send({ email: 'owner@example.com', password: 'correct-horse-1' });
  const sid = (r) => r.headers['set-cookie'][0].split(';')[0];
  expect(sid(second)).not.toBe(sid(first));
  const entries = await AuditLog.find({ action: 'login' }).lean();
  expect(entries).toHaveLength(2);
  expect(JSON.stringify(entries)).not.toContain('owner@example.com');
});
test('an expired session does not block logging in again', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  vi.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + 8 * 24 * 3600_000));
  const r = await agent.post('/v1/auth/login').send({ email: user.email, password: 'correct-horse-1' });
  expect(r.status).toBe(200);
  expect((await agent.get('/v1/auth/me')).status).toBe(200);
  vi.restoreAllMocks();
});
test('login is rate limited per IP', async () => {
  const limited = buildTestApp({ config: { loginRateLimit: 2 } });
  const attempt = () => api(limited).post('/v1/auth/login').send({ email: 'nobody@x.com', password: 'whatever-123' });
  expect((await attempt()).status).toBe(401);
  expect((await attempt()).status).toBe(401);
  const r = await attempt();
  expect(r.status).toBe(429);
  expect(r.body.error.code).toBe('RATE_LIMITED');
});
