import { test, expect } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { businessRule } from '../src/core/errors.js';
import { validate } from '../src/core/validate.js';

const app = createApp({ config: loadConfig({ NODE_ENV: 'test' }), mount: (a) => {
  a.get('/t/rule', () => { throw businessRule('X_RULE', 'nope'); });
  a.get('/t/boom', () => { throw new Error('secret detail'); });
  a.post('/t/v', validate({ body: z.strictObject({ n: z.number() }) }), (req, res) => res.json(req.body));
}});

test('404 shape', async () => {
  const r = await request(app).get('/v1/missing');
  expect(r.status).toBe(404);
  expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
});
test('business rule → 422', async () => {
  const r = await request(app).get('/t/rule');
  expect(r.status).toBe(422);
  expect(r.body.error).toMatchObject({ code: 'X_RULE', message: 'nope' });
});
test('unexpected error hides detail', async () => {
  const r = await request(app).get('/t/boom');
  expect(r.status).toBe(500);
  expect(r.body.error.code).toBe('INTERNAL');
  expect(JSON.stringify(r.body)).not.toContain('secret detail');
  expect(r.body.error.requestId).toBe(r.headers['x-request-id']);
});
test('strict validation rejects unknown keys', async () => {
  const r = await request(app).post('/t/v').send({ n: 1, extra: true });
  expect(r.status).toBe(400);
  expect(r.body.error.code).toBe('VALIDATION_FAILED');
});
