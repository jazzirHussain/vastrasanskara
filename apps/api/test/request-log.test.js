import { test, expect } from 'vitest';
import request from 'supertest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { captureLogger } from './helpers/logs.js';
import { recordHeartbeat } from '../src/core/jobs/service.js';
useTestDb();

const { logger, lines } = captureLogger();
const app = buildTestApp({
  logger,
  mount: (a) => a.get('/t/boom', () => { throw new Error('secret detail'); }),
});
const requestLines = () => lines.filter((l) => l.msg?.match(/^(GET|POST|PUT|PATCH|DELETE) /));

test('every API request is logged once with method, path, status, duration and request id', async () => {
  lines.length = 0;
  const r = await request(app).get('/v1/missing');
  const [entry] = requestLines();
  expect(requestLines()).toHaveLength(1);
  expect(entry).toMatchObject({ level: 40, method: 'GET', path: '/v1/missing', status: 404, reqId: r.headers['x-request-id'] });
  expect(entry.ms).toBeTypeOf('number');
  expect(entry.msg).toMatch(/^GET \/v1\/missing 404 \d+ms$/);
});
test('levels follow the status: 2xx info, 4xx warn, 5xx error; healthy health checks only at debug', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  await recordHeartbeat();
  lines.length = 0;
  await agent.get('/v1/auth/me');
  await request(app).get('/t/boom');
  await request(app).get('/v1/health');
  const byPath = Object.fromEntries(requestLines().map((l) => [l.path, l]));
  expect(byPath['/v1/auth/me'].level).toBe(30);
  expect(byPath['/v1/auth/me'].userId).toMatch(/^[0-9a-f]{24}$/);
  expect(byPath['/t/boom'].level).toBe(50);
  expect(byPath['/v1/health'].level).toBe(20);
});
test('query strings and request bodies are never logged', async () => {
  lines.length = 0;
  await request(app).post('/v1/auth/login').set('X-Requested-With', 'vs-app').send({ email: 'who@x.com', password: 'hunter2-hunter2' });
  await request(app).get('/v1/files/url?key=some/secret/key.png');
  const text = JSON.stringify(lines);
  for (const secret of ['who@x.com', 'hunter2', 'secret/key']) expect(text).not.toContain(secret);
  expect(requestLines().map((l) => l.path)).toEqual(['/v1/auth/login', '/v1/files/url']);
});
test('a failing health check (503) is still an error, so an outage is visible', async () => {
  lines.length = 0;
  await request(app).get('/v1/health'); // no worker heartbeat in this test → 503
  expect(requestLines()[0]).toMatchObject({ path: '/v1/health', status: 503, level: 50 });
});
