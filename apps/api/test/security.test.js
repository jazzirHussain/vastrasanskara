import { describe, test, expect } from 'vitest';
import request from 'supertest';
import { buildTestApp, api, loginAs } from './helpers/app.js';
import { useTestDb } from './helpers/db.js';
const app = buildTestApp({ mount: (a) => {
  a.post('/t/echo', (req, res) => res.json({ ok: true }));
  a.delete('/t/echo', (req, res) => res.json({ ok: true }));
} });

test('preflight allows app origin only', async () => {
  const ok = await request(app).options('/t/echo').set('Origin', 'https://app.test').set('Access-Control-Request-Method', 'POST');
  expect(ok.headers['access-control-allow-origin']).toBe('https://app.test');
  expect(ok.headers['access-control-allow-credentials']).toBe('true');
  expect(ok.headers['access-control-max-age']).toBe('7200');
  const evil = await request(app).options('/t/echo').set('Origin', 'https://evil.test').set('Access-Control-Request-Method', 'POST');
  expect(evil.headers['access-control-allow-origin']).toBeUndefined();
});
test('POST without app header rejected', async () => {
  const r = await request(app).post('/t/echo').send({});
  expect(r.status).toBe(403); expect(r.body.error.code).toBe('CSRF_HEADER_MISSING');
});
test('non-JSON body rejected', async () => {
  const r = await request(app).post('/t/echo').set('X-Requested-With', 'vs-app').set('Content-Type', 'text/plain').send('hi');
  expect(r.status).toBe(415);
});
test('helmet headers', async () => {
  const r = await request(app).get('/v1/health');
  expect(r.headers['x-content-type-options']).toBe('nosniff');
});

test('wrong app header value rejected', async () => {
  const r = await request(app).post('/t/echo').set('X-Requested-With', 'XMLHttpRequest').send({});
  expect(r.status).toBe(403);
});
test('empty-body POST with the header is allowed', async () => {
  const r = await request(app).post('/t/echo').set('X-Requested-With', 'vs-app');
  expect(r.status).toBe(200);
});
test('DELETE needs the header too; api() helper sends it', async () => {
  expect((await request(app).delete('/t/echo')).status).toBe(403);
  expect((await api(app).delete('/t/echo')).status).toBe(200);
  expect((await api(request.agent(app)).post('/t/echo').send({ a: 1 })).status).toBe(200);
});

describe('M9 hardening', () => {
  useTestDb();

  test('too many requests are slowed with a plain message', async () => {
    const anonymous = buildTestApp({ config: { rateLimits: { user: 1000, anonymous: 5 } } });
    for (let i = 0; i < 5; i++) expect((await request(anonymous).get('/v1/auth/me')).status).toBe(401);
    const r = await request(anonymous).get('/v1/auth/me');
    expect(r.status).toBe(429);
    expect(r.body.error).toEqual({ code: 'RATE_LIMITED', message: 'Too many requests. Wait a minute and try again.' });
    expect(r.headers['ratelimit']).toBeDefined();
    for (let i = 0; i < 8; i++) expect((await request(anonymous).get('/v1/health')).status).not.toBe(429);

    const signedIn = buildTestApp({ config: { rateLimits: { user: 5, anonymous: 1000 } } });
    const a = await loginAs(signedIn, { roles: ['admin'] });
    const b = await loginAs(signedIn, { roles: ['admin'] });
    for (let i = 0; i < 5; i++) expect((await a.agent.get('/v1/auth/me')).status).toBe(200);
    expect((await a.agent.get('/v1/auth/me')).status).toBe(429);
    expect((await b.agent.get('/v1/auth/me')).status).toBe(200);
  });

  test('API responses are never cached and cannot be framed', async () => {
    const plain = buildTestApp();
    for (const path of ['/v1/health', '/v1/auth/me']) {
      const r = await request(plain).get(path);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(r.headers['content-security-policy']).toContain("default-src 'none'");
      expect(r.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
      expect(r.headers['cross-origin-resource-policy']).toBe('same-site');
    }
  });

  test('only the app origin may call with credentials', async () => {
    const evil = await request(app).get('/v1/health').set('Origin', 'https://evil.test');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const ours = await request(app).get('/v1/health').set('Origin', 'https://app.test');
    expect(ours.headers['access-control-allow-origin']).toBe('https://app.test');
    expect(ours.headers['access-control-allow-credentials']).toBe('true');
  });
});
