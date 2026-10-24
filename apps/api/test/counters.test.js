import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { withTransaction } from '../src/core/db.js';
import { nextSequence } from '../src/core/counters.js';
useTestDb();

test('sequential from 1', async () => {
  const a = await withTransaction((s) => nextSequence('t', s));
  const b = await withTransaction((s) => nextSequence('t', s));
  expect([a, b]).toEqual([1, 2]);
});
test('concurrent transactions get unique contiguous numbers', async () => {
  const nums = await Promise.all(Array.from({ length: 20 }, () => withTransaction((s) => nextSequence('c', s))));
  expect([...nums].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
});
test('aborted transaction does not consume a number', async () => {
  await withTransaction((s) => nextSequence('g', s));
  await expect(withTransaction(async (s) => { await nextSequence('g', s); throw new Error('abort'); })).rejects.toThrow();
  expect(await withTransaction((s) => nextSequence('g', s))).toBe(2);
});
test('refuses to run outside a transaction', async () => {
  await expect(nextSequence('x')).rejects.toThrow(/transaction/);
  const session = await mongoose.connection.startSession();
  try {
    await expect(nextSequence('x', session)).rejects.toThrow(/transaction/);
  } finally {
    await session.endSession();
  }
});
