import { test, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { withTransaction } from '../src/core/db.js';
import { recordAudit, verifyAuditChain } from '../src/core/audit/service.js';
import { diff } from '../src/core/audit/diff.js';
import { AuditLog } from '../src/core/audit/model.js';
useTestDb();
const branchId = new mongoose.Types.ObjectId().toString();
const write = (extra = {}) => withTransaction((s) => recordAudit({ branchId, entityType: 'setting', entityId: 'x', action: 'update', before: { a: 1 }, after: { a: 2 }, actor: {}, ...extra }, s));

test('chains entries', async () => {
  const e1 = await write(); const e2 = await write();
  expect(e1.seq).toBe(1); expect(e1.prevHash).toBe('0'.repeat(64));
  expect(e2.prevHash).toBe(e1.hash);
});
test('field-level diff', () => {
  expect(diff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: 4 })).toEqual([
    { path: 'b.c', before: 2, after: 3 }, { path: 'd', before: null, after: 4 },
  ]);
});
test('verifies after reload with dates and object ids', async () => {
  const id = new mongoose.Types.ObjectId();
  await write({ before: { at: new Date('2026-10-22T05:00:00.123Z'), ref: id, z: { b: 1, a: 2 } }, after: { at: new Date('2026-10-23T05:00:00Z'), ref: id, z: { a: 2, b: 3 } } });
  await write();
  expect(await verifyAuditChain(branchId)).toEqual({ ok: true, checked: 2 });
});
test('detects tampering', async () => {
  await write(); await write(); await write();
  await AuditLog.collection.updateOne({ branchId, seq: 2 }, { $set: { 'changes.0.after': 999 } });
  expect(await verifyAuditChain(branchId)).toMatchObject({ ok: false, firstBreak: { seq: 2, reason: 'hash_mismatch' } });
});
test('detects deletion', async () => {
  await write(); await write(); await write();
  await AuditLog.collection.deleteOne({ branchId, seq: 2 });
  expect(await verifyAuditChain(branchId)).toMatchObject({ ok: false, firstBreak: { seq: 2, reason: 'missing_seq' } });
});
test('aborted transaction leaves no entry', async () => {
  await expect(withTransaction(async (s) => { await recordAudit({ branchId, entityType: 't', entityId: '1', action: 'x', actor: {} }, s); throw new Error('abort'); })).rejects.toThrow();
  expect(await AuditLog.countDocuments()).toBe(0);
});

test('empty objects and arrays survive the round trip', async () => {
  await write({ before: { a: {}, l: [] }, after: { a: { x: {} }, l: [{}], n: null } });
  expect(await verifyAuditChain(branchId)).toEqual({ ok: true, checked: 1 });
});
test('detects deletion of the newest entries', async () => {
  await write(); await write(); await write();
  await AuditLog.collection.deleteOne({ branchId, seq: 3 });
  expect(await verifyAuditChain(branchId)).toMatchObject({ ok: false, firstBreak: { seq: 3, reason: 'missing_seq' } });
});
test('mongoose updates and deletes are refused', async () => {
  await write();
  await expect(AuditLog.updateOne({ branchId }, { $set: { action: 'x' } })).rejects.toThrow(/append-only/);
  await expect(AuditLog.deleteMany({ branchId })).rejects.toThrow(/append-only/);
  await expect(AuditLog.findOneAndDelete({ branchId })).rejects.toThrow(/append-only/);
  expect(await verifyAuditChain(branchId)).toEqual({ ok: true, checked: 1 });
});
test('a loaded entry cannot be changed and saved', async () => {
  await write();
  const loaded = await AuditLog.findOne({ branchId });
  loaded.action = 'tampered';
  await expect(loaded.save()).rejects.toThrow(/append-only/);
  expect(await verifyAuditChain(branchId)).toEqual({ ok: true, checked: 1 });
});
afterEach(() => vi.restoreAllMocks());
// Runs `before` once, just before the chain check reads the counters collection.
function beforeCounterRead(before) {
  const real = mongoose.connection.collection.bind(mongoose.connection);
  let armed = true;
  vi.spyOn(mongoose.connection, 'collection').mockImplementation((name) => {
    const coll = real(name);
    if (name !== 'counters') return coll;
    return new Proxy(coll, {
      get: (t, p) => {
        if (p === 'findOne' && armed) return async (...a) => { armed = false; return before(t, a); };
        return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
      },
    });
  });
}
test('an entry written while the check runs is not reported', async () => {
  await write(); await write(); await write(); await write();
  // Counter read says 3 although a fourth entry already exists: that entry belongs to a later check.
  beforeCounterRead(async () => ({ value: 3 }));
  const spied = await verifyAuditChain(branchId);
  vi.restoreAllMocks();
  expect(spied).toEqual({ ok: true, checked: 3 });
  expect(await verifyAuditChain(branchId)).toEqual({ ok: true, checked: 4 });
});
test('an entry committed just before the counter is read is not a missing entry', async () => {
  await write(); await write();
  beforeCounterRead(async (coll, a) => { await write(); return coll.findOne(...a); });
  expect(await verifyAuditChain(branchId)).toMatchObject({ ok: true });
});
test('the first break names the entry that broke', async () => {
  await write(); await write({ entityType: 'invoice', entityId: 'abc' }); await write();
  await AuditLog.collection.updateOne({ branchId, seq: 2 }, { $set: { action: 'tampered' } });
  expect(await verifyAuditChain(branchId)).toEqual({
    ok: false, checked: 1, firstBreak: { seq: 2, reason: 'hash_mismatch', entityType: 'invoice', entityId: 'abc' },
  });
});
test('requires a transaction session', async () => {
  await expect(recordAudit({ branchId, entityType: 't', entityId: '1', action: 'x', actor: {} })).rejects.toThrow(/transaction/);
});
test('concurrent writers keep one unbroken chain', async () => {
  await Promise.all(Array.from({ length: 10 }, () => write()));
  expect(await verifyAuditChain(branchId)).toEqual({ ok: true, checked: 10 });
});
