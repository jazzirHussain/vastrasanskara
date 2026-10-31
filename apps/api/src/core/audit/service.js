import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { clock } from '../../clock.js';
import { nextSequence } from '../counters.js';
import { canonicalJson, normalize } from './canonical.js';
import { diff } from './diff.js';
import { AuditLog } from './model.js';

const GENESIS_HASH = '0'.repeat(64);
const counterName = (branchId) => `audit:${branchId}`;

function entryHash(prevHash, entry) {
  const { seq, branchId, entityType, entityId, action, changes, userId, at, ip, userAgent } = entry;
  const payload = canonicalJson({
    seq, branchId, entityType, entityId, action, changes, userId, at: at.toISOString(), ip, userAgent,
  });
  return createHash('sha256').update(prevHash + payload).digest('hex');
}

/**
 * Appends an audit entry to the branch's hash chain. Must run inside the same
 * transaction as the change it records.
 */
export async function recordAudit(
  { branchId, entityType, entityId, action, before = null, after = null, changes, actor = {} },
  session,
) {
  if (!session?.inTransaction()) throw new Error('recordAudit must be called inside a transaction');
  const { userId = null, ip = null, userAgent = null } = actor;
  const branch = normalize(branchId);

  const seq = await nextSequence(counterName(branch), session);
  let prevHash = GENESIS_HASH;
  if (seq > 1) {
    const prev = await AuditLog.findOne({ branchId: branch, seq: seq - 1 }, { hash: 1 }).session(session).lean();
    if (!prev) throw new Error(`Audit chain broken: entry ${seq - 1} of branch ${branch} is missing`);
    prevHash = prev.hash;
  }

  const entry = {
    seq,
    branchId: branch,
    entityType,
    entityId: String(normalize(entityId)),
    action,
    changes: normalize(changes ?? diff(before, after)),
    userId: normalize(userId),
    at: clock.now(),
    ip,
    userAgent,
  };
  const [doc] = await AuditLog.create([{ ...entry, prevHash, hash: entryHash(prevHash, entry) }], { session });
  return doc.toObject();
}

/**
 * Re-hashes the branch's chain in order and reports the first break, if any. The newest seq
 * issued is read first and only entries up to it are checked, so entries committed while the
 * check runs are left for the next one.
 */
export async function verifyAuditChain(branchId) {
  const branch = normalize(branchId);
  const counter = await mongoose.connection.collection('counters').findOne({ _id: counterName(branch) });
  const last = counter?.value ?? 0;
  let checked = 0;
  let prevHash = GENESIS_HASH;
  const fail = (seq, reason, entry) => ({
    ok: false,
    checked,
    firstBreak: { seq, reason, ...(entry ? { entityType: entry.entityType, entityId: entry.entityId } : {}) },
  });

  const cursor = AuditLog.find({ branchId: branch, seq: { $lte: last } }).sort({ seq: 1 }).lean().cursor();
  for await (const entry of cursor) {
    const expectedSeq = checked + 1;
    if (entry.seq !== expectedSeq) return fail(expectedSeq, 'missing_seq');
    if (entry.prevHash !== prevHash) return fail(entry.seq, 'prev_mismatch', entry);
    if (entryHash(prevHash, entry) !== entry.hash) return fail(entry.seq, 'hash_mismatch', entry);
    prevHash = entry.hash;
    checked += 1;
  }

  // Entries deleted from the end of the chain are visible only because the counter knows them.
  if (last > checked) return fail(checked + 1, 'missing_seq');

  return { ok: true, checked };
}
