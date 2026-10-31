import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { recordAudit, verifyAuditChain } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { clock } from '../../clock.js';
import { logger } from '../../logger.js';
import { Allocation, BillingDocument, CreditNote, IntegrityRun, Invoice } from './model.js';
import { settlementOf } from './allocations.js';

const MAX_PROBLEMS = 50;
// A run the worker claimed this long ago without finishing (a crashed worker) is claimed again.
const STALE_CLAIM_MS = 30 * 60_000;
// A run nobody has finished after this long (no worker running) gives way to a new one.
const ABANDONED_MS = 2 * 60 * 60_000;
const BALANCE_FIELDS = { number: 1, status: 1, totals: 1, settlement: 1 };

const isMissing = (err) =>
  err?.code === 'NOT_FOUND' || err?.code === 'ENOENT' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;

async function sha256Of(storage, key) {
  const hash = createHash('sha256');
  for await (const chunk of await storage.getObject(key)) hash.update(chunk);
  return hash.digest('hex');
}

function collect(section, problem) {
  if (section.problems.length < MAX_PROBLEMS) section.problems.push(problem);
  else section.truncated = true;
}

async function checkPdfs(branchId, storage) {
  const out = { checked: 0, pending: 0, problems: [] };
  out.pending = await BillingDocument.countDocuments({ branchId, status: { $in: ['issued', 'cancelled'] }, 'pdf.status': { $in: ['pending', 'rendering'] } });
  const cursor = BillingDocument.find(
    { branchId, status: { $in: ['issued', 'cancelled'] }, 'pdf.status': 'ready' },
    { type: 1, number: 1, pdf: 1 },
  ).lean().cursor();
  for await (const doc of cursor) {
    out.checked += 1;
    let reason = null;
    try {
      if ((await sha256Of(storage, doc.pdf.key)) !== doc.pdf.sha256) reason = 'hash_mismatch';
    } catch (err) {
      if (!isMissing(err)) throw err;
      reason = 'missing';
    }
    if (reason) collect(out, { id: String(doc._id), type: doc.type, number: doc.number, reason });
  }
  return out;
}

/** The bill's stored settlement against the one its payments and credit notes give; null when they agree. */
async function balanceProblem(invoice) {
  const [rows, notes] = await Promise.all([
    Allocation.find({ invoiceId: invoice._id }, { amount: 1, reason: 1 }).lean(),
    CreditNote.find({ invoiceId: invoice._id, status: 'issued' }, { 'totals.total': 1 }).lean(),
  ]);
  const expected = settlementOf(invoice, rows, notes);
  const stored = invoice.settlement ?? {};
  const fields = Object.keys(expected).filter((f) => stored[f] !== expected[f]);
  if (!fields.length) return null;
  return {
    id: String(invoice._id),
    number: invoice.number,
    fields,
    stored: Object.fromEntries(Object.keys(expected).map((f) => [f, stored[f] ?? null])),
    expected,
  };
}

async function checkBalances(branchId) {
  const out = { checked: 0, problems: [] };
  const cursor = Invoice.find({ branchId, status: { $in: ['issued', 'cancelled'] } }, BALANCE_FIELDS).lean().cursor();
  for await (const invoice of cursor) {
    out.checked += 1;
    if (!(await balanceProblem(invoice))) continue;
    // A payment may have been committing while the bill was read: read it once more, and report
    // it only if it still does not add up.
    const again = await Invoice.findById(invoice._id, BALANCE_FIELDS).lean();
    const problem = again && (await balanceProblem(again));
    if (problem) collect(out, problem);
  }
  return out;
}

/** The audit chain's first break, with the document's number when the entry is a billing document's. */
async function auditSection(branchId) {
  const audit = await verifyAuditChain(branchId);
  const firstBreak = audit.firstBreak ?? null;
  if (firstBreak?.entityId && mongoose.isValidObjectId(firstBreak.entityId)) {
    const doc = await BillingDocument.findOne({ _id: firstBreak.entityId, branchId }, { number: 1 }).lean();
    if (doc?.number) firstBreak.number = doc.number;
  }
  return { ok: audit.ok, checked: audit.checked, firstBreak };
}

/** Checks the audit chain, stored PDFs and bill balances without changing any of them. */
export async function verifyBillingIntegrity(branchId, storage) {
  const checkedAt = clock.now().toISOString();
  const audit = await auditSection(branchId);
  const pdfs = await checkPdfs(branchId, storage);
  const balances = await checkBalances(branchId);
  return {
    checkedAt,
    ok: audit.ok && pdfs.problems.length === 0 && balances.problems.length === 0,
    audit,
    pdfs,
    balances,
  };
}

// --- Background runs ---------------------------------------------------------------------------

/** The branch's latest check run (lean), or null. */
export function latestIntegrityCheck(branchId) {
  return IntegrityRun.findOne({ branchId }).sort({ startedAt: -1, _id: -1 }).lean();
}

/**
 * Starts a check of the branch's records for the worker to run, or answers the one already
 * running. A run left unfinished for two hours (no worker) is marked failed and a new one starts.
 */
export async function startIntegrityCheck(branchId, actor) {
  const now = clock.now();
  const running = await IntegrityRun.findOne({ branchId, status: 'running' }).lean();
  if (running && now.getTime() - running.startedAt.getTime() < ABANDONED_MS) return running;
  if (running) {
    await IntegrityRun.updateOne(
      { _id: running._id, status: 'running' },
      { $set: { status: 'failed', finishedAt: now, error: 'not finished in time' } },
    );
  }
  try {
    const run = await IntegrityRun.create({ branchId, status: 'running', actor, startedAt: now });
    return run.toObject();
  } catch (err) {
    // Started at the same moment by someone else: answer theirs.
    if (err?.code !== 11000) throw err;
    return IntegrityRun.findOne({ branchId, status: 'running' }).lean();
  }
}

async function claimNext(now) {
  return IntegrityRun.findOneAndUpdate(
    { status: 'running', $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now.getTime() - STALE_CLAIM_MS) } }] },
    { $set: { claimedAt: now } },
    { sort: { startedAt: 1 }, new: true },
  ).lean();
}

async function finish(run, result) {
  await withTransaction(async (session) => {
    const { matchedCount } = await IntegrityRun.updateOne(
      { _id: run._id, status: 'running', claimedAt: run.claimedAt },
      { $set: { status: 'done', finishedAt: clock.now(), result } },
      { session },
    );
    // Someone else finished it (a stale claim taken over): nothing more to record.
    if (matchedCount !== 1) return;
    await recordAudit(
      {
        branchId: run.branchId,
        entityType: 'audit',
        entityId: run.branchId,
        action: 'verify',
        changes: [{ path: 'result', before: null, after: result }],
        actor: run.actor ?? {},
      },
      session,
    );
  });
}

/**
 * Runs every started check (the worker's billing-integrity job): each is claimed, checked and
 * finished with its result and an audit entry; a check that cannot finish is marked failed.
 */
export async function runPendingIntegrityChecks({ storage, now = clock.now() } = {}) {
  let ran = 0;
  for (let run = await claimNext(now); run; run = await claimNext(now)) {
    ran += 1;
    try {
      await finish(run, await verifyBillingIntegrity(run.branchId, storage));
    } catch (err) {
      logger.error({ err, integrityRunId: String(run._id) }, `records check failed: ${err.message}`);
      await IntegrityRun.updateOne(
        { _id: run._id, status: 'running', claimedAt: run.claimedAt },
        { $set: { status: 'failed', finishedAt: clock.now(), error: err.message } },
      );
    }
  }
  return { ran };
}
