import { test, expect } from 'vitest';
import request from 'supertest';
import { useTestDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
useTestDb();
test('health ok', async () => {
  const r = await request(createApp({ config: loadConfig({ NODE_ENV: 'test' }) })).get('/v1/health');
  expect(r.status).toBe(200);
  expect(r.body.db).toBe('ok');
});
