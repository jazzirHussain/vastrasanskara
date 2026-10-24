import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { api, buildTestApp, loginAs } from './helpers/app.js';
import { idempotent } from '../src/core/idempotency.js';
useTestDb();
let runs = 0;
const app = buildTestApp({ mount: (a) => {
  a.post('/t/pay', idempotent(), async (req, res) => { runs++; await new Promise((r) => setTimeout(r, 50)); res.status(201).json({ run: runs }); });
  a.post('/t/other', idempotent(), (req, res) => res.json({}));
  a.post('/t/fail', idempotent(), (req, res) => { runs++; res.status(422).json({ error: { code: 'X' } }); });
  a.post('/t/throw', idempotent(), () => { runs++; throw new Error('boom'); });
  a.post('/t/empty', idempotent(), (req, res) => { runs++; res.status(204).end(); });
}});

test('requires key', async () => {
  const { agent } = await loginAs(app, { roles: ['operations'] });
  expect((await agent.post('/t/pay').send({})).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
});
test('replays a finished request', async () => {
  runs = 0; const { agent } = await loginAs(app, { roles: ['operations'] });
  const a = await agent.post('/t/pay').set('Idempotency-Key', 'k1').send({});
  const b = await agent.post('/t/pay').set('Idempotency-Key', 'k1').send({});
  expect(b.status).toBe(201); expect(b.body).toEqual(a.body); expect(runs).toBe(1);
});
test('concurrent duplicate runs handler once', async () => {
  runs = 0; const { agent } = await loginAs(app, { roles: ['operations'] });
  const [x, y] = await Promise.all([1, 2].map(() => agent.post('/t/pay').set('Idempotency-Key', 'k2').send({})));
  expect([x.status, y.status].sort()).toEqual([201, 409]); expect(runs).toBe(1);
});
test('key reused on another route', async () => {
  const { agent } = await loginAs(app, { roles: ['operations'] });
  await agent.post('/t/pay').set('Idempotency-Key', 'k3').send({});
  expect((await agent.post('/t/other').set('Idempotency-Key', 'k3').send({})).status).toBe(422);
});
test('failed request can be retried', async () => {
  runs = 0; const { agent } = await loginAs(app, { roles: ['operations'] });
  await agent.post('/t/fail').set('Idempotency-Key', 'k4').send({});
  await agent.post('/t/fail').set('Idempotency-Key', 'k4').send({});
  expect(runs).toBe(2);
});

test('a handler that throws frees the key', async () => {
  runs = 0; const { agent } = await loginAs(app, { roles: ['operations'] });
  expect((await agent.post('/t/throw').set('Idempotency-Key', 'k5').send({})).status).toBe(500);
  expect((await agent.post('/t/throw').set('Idempotency-Key', 'k5').send({})).status).toBe(500);
  expect(runs).toBe(2);
});
test('an empty 204 response is replayed', async () => {
  runs = 0; const { agent } = await loginAs(app, { roles: ['operations'] });
  expect((await agent.post('/t/empty').set('Idempotency-Key', 'k6')).status).toBe(204);
  expect((await agent.post('/t/empty').set('Idempotency-Key', 'k6')).status).toBe(204);
  expect(runs).toBe(1);
});
test('keys are per user and need a signed-in user', async () => {
  runs = 0;
  const { agent: one } = await loginAs(app, { roles: ['operations'] });
  const { agent: two } = await loginAs(app, { roles: ['operations'] });
  await one.post('/t/pay').set('Idempotency-Key', 'shared').send({});
  await two.post('/t/pay').set('Idempotency-Key', 'shared').send({});
  expect(runs).toBe(2);
  expect((await api(app).post('/t/pay').set('Idempotency-Key', 'k7').send({})).status).toBe(401);
});
