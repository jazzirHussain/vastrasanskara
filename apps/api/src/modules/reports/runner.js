// Claiming and building report runs. The API (light kinds, at once) and the worker (every minute)
// both claim through one atomic queued → running update, so a run is never built twice.
import { createHash, randomUUID } from 'node:crypto';
import { monthName, reportFilename } from '@vs/shared/reports/catalog.js';
import { istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { canonicalJson } from '../../core/audit/canonical.js';
import { withTransaction } from '../../core/db.js';
import { emit } from '../../core/notify/emit.js';
import { logger } from '../../logger.js';
import { getCustomer } from '../customers/service.js';
import { getBuilder } from './builders/index.js';
import { ReportRun } from './model.js';
import { CONTENT_TYPES, REPORT_MAX_ROWS, ReportError, checkRowLimit, toCsvBuffer, toXlsx } from './writers.js';
import './builders/registers.js';
import './builders/gst.js';
import './builders/ledgers.js';
import './builders/business.js';
import './notifications.js';

export const STUCK_AFTER_MS = 30 * 60_000;
export const MAX_ATTEMPTS = 2;
const FAILED_MESSAGE = 'This report could not be made. Ask for it again.';

/**
 * Takes a queued run (the given one, or the oldest) for building: atomically queued → running.
 * First, runs stuck `running` for more than 30 minutes go back to the queue, or fail (STUCK)
 * once they have had two attempts. Answers the claimed run, or null.
 */
export async function claimRun({ id } = {}) {
  const now = clock.now();
  const stuck = { status: 'running', claimedAt: { $lt: new Date(now.getTime() - STUCK_AFTER_MS) } };
  await ReportRun.updateMany(
    { ...stuck, attempts: { $gte: MAX_ATTEMPTS } },
    { $set: { status: 'failed', finishedAt: now, error: { code: 'STUCK', message: 'This report took too long. Ask for it again.' } } },
  );
  await ReportRun.updateMany({ ...stuck, attempts: { $lt: MAX_ATTEMPTS } }, { $set: { status: 'queued' } });
  return ReportRun.findOneAndUpdate(
    { ...(id && { _id: id }), status: 'queued' },
    { $set: { status: 'running', claimedAt: now, startedAt: now }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  ).lean();
}

// The scheduled GST pack tells the owner when it is ready (with both files) or when it failed.
const isScheduledPack = (run) => run.kind === 'gst_pack' && run.source === 'schedule';
const packRef = (run) => `gst_pack:${run.params.month}`;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const packVars = (run, link) => ({
  month: monthName(run.params.month),
  monthShort: `${SHORT_MONTHS[Number(run.params.month.slice(5, 7)) - 1]} ${run.params.month.slice(0, 4)}`,
  link,
});

/** `attachment; filename="…"`, with an RFC 5987 UTF-8 name beside an ASCII one when needed. */
export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const plain = `attachment; filename="${ascii}"`;
  return ascii === filename ? plain : `${plain}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function writeFile(run, file, filename, { storage }) {
  const format = file.pdf ? 'pdf' : run.format;
  let body;
  if (file.pdf) body = file.pdf;
  else if (format === 'csv') body = toCsvBuffer(file.sheets[0]);
  else body = await toXlsx(file.sheets, { created: run.startedAt ?? clock.now() });
  const key = `${run.branchId}/reports/${istDate(clock.now()).slice(0, 4)}/${randomUUID()}.${format}`;
  const contentType = CONTENT_TYPES[format];
  await storage.putObject({ key, body, contentType, contentDisposition: contentDisposition(filename) });
  return { key, filename, contentType, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
}

/**
 * Builds a claimed run: its files go to storage and the run becomes `done` with its row count
 * and a hash of its rows. A failure becomes `failed` with a plain code; nothing personal is logged.
 */
export async function buildRun(run, { storage, maxRows = REPORT_MAX_ROWS } = {}) {
  if (!run) return null;
  const mine = { _id: run._id, status: 'running', attempts: run.attempts };
  try {
    const build = getBuilder(run.kind);
    if (!build) throw new ReportError('REPORT_FAILED', FAILED_MESSAGE);
    const params = { ...run.params, customerId: run.params?.customerId ? String(run.params.customerId) : null };
    const { files } = await build(String(run.branchId), params, { storage, maxRows, format: run.format });
    const sheets = files.flatMap((f) => f.sheets ?? []);
    const rows = sheets.reduce((n, s) => n + s.rows.length, 0);
    checkRowLimit(rows, maxRows);
    const customerName = params.customerId ? (await getCustomer(String(run.branchId), params.customerId)).name : undefined;
    const written = [];
    for (const [i, file] of files.entries()) {
      const filename = i === 0 ? reportFilename({ kind: run.kind, params, format: run.format }, { customerName }) : file.filename;
      written.push(await writeFile(run, file, filename, { storage }));
    }
    const rowsHash = createHash('sha256').update(canonicalJson(sheets.map((s) => ({ name: s.name, rows: s.rows })))).digest('hex');
    await withTransaction(async (session) => {
      const { modifiedCount } = await ReportRun.updateOne(mine, {
        $set: { status: 'done', finishedAt: clock.now(), file: written[0], extraFiles: written.slice(1), rows, rowsHash, error: null },
      }).session(session);
      if (modifiedCount && isScheduledPack(run)) {
        await emit(
          'reports.gst_pack',
          { branchId: run.branchId, refId: packRef(run), vars: packVars(run, '/accounts'), attachments: written.map(({ key, filename }) => ({ key, filename })) },
          { session },
        );
      }
    });
  } catch (err) {
    const known = err instanceof ReportError;
    logger.error({ runId: String(run._id), kind: run.kind, code: known ? err.code : 'REPORT_FAILED', errName: err?.name }, 'report failed');
    await withTransaction(async (session) => {
      const { modifiedCount } = await ReportRun.updateOne(mine, {
        $set: {
          status: 'failed',
          finishedAt: clock.now(),
          file: null,
          error: known ? { code: err.code, message: err.message } : { code: 'REPORT_FAILED', message: FAILED_MESSAGE },
        },
      }).session(session);
      if (modifiedCount && isScheduledPack(run)) {
        await emit('reports.gst_pack_failed', { branchId: run.branchId, refId: packRef(run), vars: packVars(run, '/reports') }, { session });
      }
    });
  }
  return ReportRun.findById(run._id).lean();
}
