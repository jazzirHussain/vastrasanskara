import { verifyAuditChain } from '../audit/service.js';

/**
 * Checks a restored copy of the database on its own connection (never the app's): counts every
 * collection, re-hashes each branch's audit chain and finds the newest audit entry. Problems are
 * plain sentences for the person running the drill.
 */
export async function checkRestoredDatabase(connection) {
  const names = (await connection.db.listCollections().toArray()).map((c) => c.name).sort();
  const collections = [];
  for (const name of names) collections.push({ name, count: await connection.db.collection(name).countDocuments() });
  const count = (name) => collections.find((c) => c.name === name)?.count ?? 0;

  const problems = [];
  const branches = [];
  for (const branch of await connection.db.collection('branches').find({}, { projection: { name: 1 } }).toArray()) {
    const branchId = String(branch._id);
    const chain = await verifyAuditChain(branchId, { connection });
    branches.push({
      branchId,
      auditEntries: await connection.db.collection('auditLog').countDocuments({ branchId }),
      chainOk: chain.ok,
      firstBreak: chain.ok ? null : chain.firstBreak,
    });
    if (!chain.ok) problems.push(`Audit chain broken at entry ${chain.firstBreak.seq} of branch ${branch.name ?? branchId}`);
  }

  if (branches.length === 0) problems.push('No branches in the backup');
  if (count('users') === 0) problems.push('No users in the backup');
  const newest = await connection.db.collection('auditLog').find({}, { projection: { at: 1 } }).sort({ at: -1 }).limit(1).next();

  return { ok: problems.length === 0, collections, branches, newestRecordAt: newest?.at ?? null, problems };
}
