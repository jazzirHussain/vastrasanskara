import { test, expect, vi } from 'vitest';
import request from 'supertest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, api, createTestUser, loginAs } from './helpers/app.js';
import { clock } from '../src/clock.js';
import { requirePermission } from '../src/core/auth/middleware.js';
import { ensureSessionIndexes, revokeUserSessions } from '../src/core/auth/sessions.js';
import mongoose from 'mongoose';
import { AuditLog } from '../src/core/audit/model.js';
import { Outbox } from '../src/core/notify/models.js';
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
test('session expiry index is created at startup (expired sessions are removed by MongoDB)', async () => {
  await ensureSessionIndexes();
  const indexes = await mongoose.connection.collection('sessions').indexes();
  expect(indexes).toEqual(expect.arrayContaining([expect.objectContaining({ key: { expires: 1 }, expireAfterSeconds: 0 })]));
});

test('logging out clears a secure cookie in production', async () => {
  const prod = buildTestApp({ config: { cookie: { name: '__Host-sid', secure: true } } });
  await createTestUser({ roles: ['admin'], email: 'owner@example.com' });
  const agent = request.agent(prod);
  const signedIn = await api(agent).post('/v1/auth/login').set('X-Forwarded-Proto', 'https').send({ email: 'owner@example.com', password: 'correct-horse-1' });
  expect(signedIn.status).toBe(200);
  const r = await api(agent).post('/v1/auth/logout').set('X-Forwarded-Proto', 'https');
  expect(r.status).toBe(204);
  const cookie = r.headers['set-cookie'].find((c) => c.startsWith('__Host-sid='));
  expect(cookie).toMatch(/^__Host-sid=;/);
  expect(cookie).toMatch(/; Secure/i);
  expect(cookie).toMatch(/; HttpOnly/i);
  expect(cookie).toMatch(/; SameSite=Strict/i);
  expect(cookie).toMatch(/; Path=\//i);
});

test('unknown emails lock exactly like real ones', async () => {
  await createTestUser({ roles: ['admin'], email: 'real@x.com' });
  const outcomes = async (email) => {
    const seen = [];
    for (let i = 0; i < 11; i++) {
      const r = await login(email, 'wrong-pass-12');
      seen.push(`${r.status} ${r.body.error.code}`);
    }
    return seen;
  };
  const real = await outcomes('real@x.com');
  expect(real.at(-1)).toBe('423 ACCOUNT_LOCKED');
  expect(await outcomes('Ghost@X.com')).toEqual(real);
  // The lock ends after 15 minutes for both.
  vi.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + 16 * 60_000));
  expect((await login('ghost@x.com', 'wrong-pass-12')).body.error.code).toBe('INVALID_CREDENTIALS');
  vi.restoreAllMocks();
});

test('asking to reset a password answers the same for any email', async () => {
  await createTestUser({ roles: ['admin'], email: 'real@x.com' });
  const ask = (email) => api(request(app)).post('/v1/auth/password-reset/request').send({ email });
  const unknown = await ask('nobody@x.com');
  const known = await ask('real@x.com');
  expect(unknown.status).toBe(202);
  expect(known.status).toBe(202);
  expect(known.body).toEqual(unknown.body);
  expect(Object.keys(known.headers).filter((h) => !['date', 'x-request-id', 'etag', 'ratelimit', 'ratelimit-policy'].includes(h)).sort())
    .toEqual(Object.keys(unknown.headers).filter((h) => !['date', 'x-request-id', 'etag', 'ratelimit', 'ratelimit-policy'].includes(h)).sort());
  await expect.poll(() => Outbox.countDocuments({ event: 'auth.password_reset' })).toBe(1);
});
