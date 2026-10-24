import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { withTransaction } from '../src/core/db.js';
useTestDb();
const Thing = mongoose.model('Thing', new mongoose.Schema({ n: Number }));

test('commits', async () => {
  await withTransaction((session) => Thing.create([{ n: 1 }], { session }));
  expect(await Thing.countDocuments()).toBe(1);
});
test('rolls back on throw', async () => {
  await expect(withTransaction(async (session) => { await Thing.create([{ n: 2 }], { session }); throw new Error('x'); })).rejects.toThrow('x');
  expect(await Thing.countDocuments()).toBe(0);
});
test('retries transient errors', async () => {
  let calls = 0;
  await withTransaction(async (session) => {
    calls++;
    await Thing.create([{ n: 3 }], { session });
    if (calls === 1) { const e = new mongoose.mongo.MongoError('transient'); e.addErrorLabel('TransientTransactionError'); throw e; }
  });
  expect(calls).toBe(2);
  expect(await Thing.countDocuments()).toBe(1);
});
test('returns the callback result', async () => {
  expect(await withTransaction(async () => 42)).toBe(42);
});
