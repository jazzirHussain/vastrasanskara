import { test, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

// No useTestDb(): mongoose is never connected in this file.
test('health reports 503 when the database is down', async () => {
  const r = await request(createApp({ config: loadConfig({ NODE_ENV: 'test' }) })).get('/v1/health');
  expect(r.status).toBe(503);
  expect(r.body).toEqual({ db: 'down', worker: 'stale' });
});
