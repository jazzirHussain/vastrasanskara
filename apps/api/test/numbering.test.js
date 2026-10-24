import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { withTransaction } from '../src/core/db.js';
import { nextDocumentNumber } from '../src/core/numbering.js';
useTestDb();

const branchId = new mongoose.Types.ObjectId();
const take = (now, start) => withTransaction((session) => nextDocumentNumber({ branchId, docType: 'order', now, start }, session));

test('numbers run per financial year from the start number', async () => {
  const march = new Date('2027-03-31T18:29:00Z'); // 23:59 IST
  const april = new Date('2027-03-31T18:31:00Z'); // 00:01 IST, next FY
  expect(await take(march)).toEqual({ number: 1, fy: expect.objectContaining({ code: '2627' }) });
  expect((await take(march)).number).toBe(2);
  expect(await take(april, 101)).toEqual({ number: 101, fy: expect.objectContaining({ code: '2728' }) });
  expect((await take(april, 101)).number).toBe(102);
});
test('an aborted transaction does not use up a number', async () => {
  const now = new Date('2026-10-24T06:00:00Z');
  await expect(withTransaction(async (session) => {
    await nextDocumentNumber({ branchId, docType: 'order', now }, session);
    throw new Error('abort');
  })).rejects.toThrow('abort');
  expect((await take(now)).number).toBe(1);
});
test('needs a transaction', async () => {
  await expect(nextDocumentNumber({ branchId, docType: 'order', now: new Date() })).rejects.toThrow(/transaction/);
});
