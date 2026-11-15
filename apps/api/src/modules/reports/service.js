// Report runs: asking for a file, listing and reading runs, the audited download link, and the
// worker's pass over the queue.
import mongoose from 'mongoose';
import { isLight } from '@vs/shared/reports/catalog.js';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, notFound } from '../../core/errors.js';
import { paginate } from '../../core/pagination.js';
import { logger } from '../../logger.js';
import { ReportRun } from './model.js';
import { buildRun, claimRun } from './runner.js';

export const RUN_LIST_DAYS = 90;
export const LINK_SECONDS = 300;

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/** Builds one run now, in the background of this process (light kinds). */
function buildSoon(id, { storage }) {
  setImmediate(() => {
    claimRun({ id })
      .then((run) => buildRun(run, { storage }))
      .catch((err) => logger.error({ runId: String(id), errName: err?.name }, 'report build failed to start'));
  });
}

/** Records a request for a report file; light kinds start at once, the rest wait for the worker. */
export async function requestReport(branchId, input, actor, { storage }) {
  const run = await withTransaction(async (session) => {
    const [created] = await ReportRun.create(
      [
        {
          branchId,
          kind: input.kind,
          format: input.format,
          params: input.params,
          source: 'manual',
          requestedBy: actor.userId,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      ],
      { session },
    );
    await recordAudit(
      { branchId, entityType: 'report', entityId: created._id, action: 'request', after: { kind: input.kind, format: input.format, params: input.params }, actor },
      session,
    );
    return created;
  });
  if (isLight({ kind: input.kind, params: input.params })) buildSoon(run._id, { storage });
  return run.toObject();
}

/** One run of the branch, or 404. */
export async function getRun(branchId, id) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const run = await ReportRun.findOne({ _id: id, branchId: oid(branchId) }).lean();
  if (!run) throw notFound();
  return run;
}

/** The runs of the last 90 days, newest first (`recent`; exported for the index test). */
export const recentRunsFilter = (branchId, now = clock.now()) => ({
  branchId: oid(branchId),
  createdAt: { $gte: new Date(now.getTime() - RUN_LIST_DAYS * 86_400_000) },
});

export function listRuns(branchId, { cursor, limit } = {}) {
  return paginate(ReportRun, recentRunsFilter(branchId), { sort: ['createdAt', -1], cursor, limit });
}

/** A 5-minute link to a finished report file, audited each time it is given. */
export async function downloadLink(branchId, id, actor, { storage }) {
  const run = await getRun(branchId, id);
  if (run.status !== 'done' || !run.file) throw businessRule('REPORT_NOT_READY', 'This report is not ready yet');
  await withTransaction((session) =>
    recordAudit({ branchId, entityType: 'report', entityId: run._id, action: 'download', after: { filename: run.file.filename }, actor }, session),
  );
  const url = await storage.presignGet(run.file.key, { expiresIn: LINK_SECONDS });
  return { url, filename: run.file.filename, expiresIn: LINK_SECONDS };
}

/** The worker: builds up to `limit` queued runs, oldest first. */
export async function runPendingReports({ storage, limit = 3 } = {}) {
  for (let i = 0; i < limit; i += 1) {
    const run = await claimRun();
    if (!run) return;
    await buildRun(run, { storage });
  }
}
