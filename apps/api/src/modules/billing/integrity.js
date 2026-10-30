import { createHash } from 'node:crypto';
import { Router } from 'express';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { recordAudit, verifyAuditChain } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { clock } from '../../clock.js';
import { Allocation, CreditNote, Invoice, BillingDocument } from './model.js';
import { settlementOf } from './allocations.js';

const MAX_PROBLEMS = 50;

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

async function checkBalances(branchId) {
  const out = { checked: 0, problems: [] };
  const cursor = Invoice.find({ branchId, status: { $in: ['issued', 'cancelled'] } }, { number: 1, status: 1, totals: 1, settlement: 1 })
    .lean()
    .cursor();
  for await (const invoice of cursor) {
    out.checked += 1;
    const [rows, notes] = await Promise.all([
      Allocation.find({ invoiceId: invoice._id }, { amount: 1, reason: 1 }).lean(),
      CreditNote.find({ invoiceId: invoice._id, status: 'issued' }, { 'totals.total': 1 }).lean(),
    ]);
    const expected = settlementOf(invoice, rows, notes);
    const stored = invoice.settlement ?? {};
    const fields = Object.keys(expected).filter((f) => stored[f] !== expected[f]);
    if (fields.length) {
      collect(out, {
        id: String(invoice._id),
        number: invoice.number,
        fields,
        stored: Object.fromEntries(Object.keys(expected).map((f) => [f, stored[f] ?? null])),
        expected,
      });
    }
  }
  return out;
}

/** Checks the audit chain, stored PDFs and bill balances without changing any of them. */
export async function verifyBillingIntegrity(branchId, storage) {
  const checkedAt = clock.now().toISOString();
  const audit = await verifyAuditChain(branchId);
  const pdfs = await checkPdfs(branchId, storage);
  const balances = await checkBalances(branchId);
  return {
    checkedAt,
    ok: audit.ok && pdfs.problems.length === 0 && balances.problems.length === 0,
    audit: { ok: audit.ok, checked: audit.checked, firstBreak: audit.firstBreak ?? null },
    pdfs,
    balances,
  };
}

export function integrityRouter(storage) {
  const router = Router();
  router.use(requirePermission('audit.verify'));

  router.post('/verify', async (req, res) => {
    const { branchId } = req.user;
    const result = await verifyBillingIntegrity(branchId, storage);
    await withTransaction((session) =>
      recordAudit(
        {
          branchId,
          entityType: 'audit',
          entityId: branchId,
          action: 'verify',
          changes: [{ path: 'result', before: null, after: result }],
          actor: actorFrom(req),
        },
        session,
      ),
    );
    res.json(result);
  });

  return router;
}
