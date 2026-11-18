import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { assertDatabaseReady } from '../src/core/db.js';
useTestDb();

const stubAdmin = (buildInfo, hello) => ({ buildInfo: async () => buildInfo, command: async () => hello });

test('the database must be MongoDB 7 or later with transactions', async () => {
  await expect(assertDatabaseReady(stubAdmin({ version: '6.0.5' }, { setName: 'rs0' })))
    .rejects.toThrow('The database must be MongoDB 7.0 or later (found 6.0.5)');
  await expect(assertDatabaseReady(stubAdmin({ version: '7.0.2' }, {})))
    .rejects.toThrow('The database does not support transactions (it is not a replica set)');
  await expect(assertDatabaseReady(stubAdmin({ version: '8.0.1' }, { msg: 'isdbgrid' }))).resolves.toEqual({ version: '8.0.1' });
  const real = await assertDatabaseReady();
  expect(Number(real.version.split('.')[0])).toBeGreaterThanOrEqual(7);
});
