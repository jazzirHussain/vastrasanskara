import { test, expect } from 'vitest';
import request from 'supertest';
import { useTestDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
useTestDb();
// The worker heartbeat part of health is covered in jobs.test.js.
test('health reports the database as ok', async () => {
  const r = await request(createApp({ config: loadConfig({ NODE_ENV: 'test' }) })).get('/v1/health');
  expect(r.body).toMatchObject({ db: 'ok' });
});
