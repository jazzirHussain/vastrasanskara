import { test, expect } from 'vitest';
import request from 'supertest';
import { buildTestApp, api } from './helpers/app.js';
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
