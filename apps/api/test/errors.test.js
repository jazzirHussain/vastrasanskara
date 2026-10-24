import { test, expect } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { validate } from '../src/core/validate.js';

const app = createApp({ config: loadConfig({ NODE_ENV: 'test' }), mount: (a) => {
  a.get('/t/version', () => { throw new mongoose.Error.VersionError({ _doc: { _id: 'x' } }, 1, ['n']); });
  a.get('/t/q', validate({ query: z.strictObject({ page: z.coerce.number().int() }) }), (req, res) =>
    res.json(req.validatedQuery));
  a.post('/t/echo', (req, res) => res.json(req.body));
}});

test('mongoose VersionError → 409 CONFLICT', async () => {
  const r = await request(app).get('/t/version');
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe('CONFLICT');
});
test('validated query lands on req.validatedQuery', async () => {
  const ok = await request(app).get('/t/q?page=2');
  expect(ok.body).toEqual({ page: 2 });
  const bad = await request(app).get('/t/q?page=x');
  expect(bad.status).toBe(400);
  expect(bad.body.error.details).toEqual([{ path: 'page', message: expect.any(String) }]);
});
test('malformed JSON → 400, not 500', async () => {
  const r = await request(app).post('/t/echo').set('Content-Type', 'application/json').send('{"n":');
  expect(r.status).toBe(400);
  expect(r.body.error.code).toBe('INVALID_JSON');
});
test('every response carries a request id', async () => {
  const r = await request(app).get('/v1/missing');
  expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
});
