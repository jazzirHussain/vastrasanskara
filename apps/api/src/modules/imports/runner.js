// Claiming, checking and adding import runs. The API (small files, at once) and the worker
// (every minute) both claim through one atomic update, so a run is never worked twice at once;
// an interrupted run is reclaimed after 10 minutes and resumes where it stopped.
import { Readable } from 'node:stream';
import { cellsByKey, matchHeaders, parseRow, rowKey } from '@vs/shared';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { logger } from '../../logger.js';
import { readSettings } from '../settings/service.js';
import { listDesigners } from '../users/service.js';
import { getKindAdapter } from './kinds/index.js';
import { COUNT_KEYS, ImportRow, ImportRun } from './model.js';
import { ImportFileError, readImportFile } from './sheets.js';
import './kinds/customers.js';
import './kinds/vendors.js';
import './kinds/workers.js';
import './kinds/catalog.js';
import './kinds/stock.js';

export const STALE_AFTER_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
export const CHECK_KEEP_DAYS = 7;
export const DONE_KEEP_DAYS = 30;
const BATCH = 500;
const SAVE_EVERY = 25;
const DAY_MS = 86_400_000;
const STOPPED = { code: 'IMPORT_FAILED', message: 'Adding stopped part way. Tap "Continue adding" to finish.' };
const CHECK_FAILED = { code: 'IMPORT_FAILED', message: 'This file could not be checked. Upload it again.' };

const later = (days) => new Date(clock.now().getTime() + days * DAY_MS);
const emptyCounts = () => Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
const log = (run, fields, message) => logger.info({ runId: String(run._id), kind: run.kind, ...fields }, message);

/** The file's bytes from storage. */
export async function readStoredFile(storage, key) {
  const body = await storage.getObject(key);
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of Readable.from(body)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Takes a run to work on (the given one, or the oldest waiting): `checking` or `importing`,
 * unclaimed or claimed more than 10 minutes ago. Runs that have had 3 attempts become `failed`.
 */
export async function claimRun({ id } = {}) {
  const now = clock.now();
  const free = { $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now.getTime() - STALE_AFTER_MS) } }] };
  const waiting = { status: { $in: ['checking', 'importing'] }, ...free };
  await ImportRun.updateMany(
    { ...waiting, attempts: { $gte: MAX_ATTEMPTS } },
    [{ $set: { status: 'failed', finishedAt: now, claimedAt: null, fileError: { $cond: [{ $eq: ['$phase', 'commit'] }, STOPPED, CHECK_FAILED] } } }],
  );
  return ImportRun.findOneAndUpdate(
    { ...(id && { _id: id }), ...waiting, attempts: { $lt: MAX_ATTEMPTS } },
    { $set: { claimedAt: now }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  ).lean();
}

/** What every kind's rows are read against: garment types and designers of the branch. */
async function contextFor(run) {
  const branchId = String(run.branchId);
  const [settings, designers] = await Promise.all([readSettings(branchId), listDesigners(branchId)]);
  const base = { branchId, run, garmentTypes: settings.garmentTypes ?? [], designers };
  return { ...base, ...(await getKindAdapter(run.kind).context(branchId, run, base)) };
}

async function finishCheck(run, update) {
  await ImportRun.updateOne(
    { _id: run._id, status: 'checking', claimedAt: run.claimedAt },
    { $set: { status: 'checked', phase: 'check', claimedAt: null, attempts: 0, ...update } },
  );
}

const missingMessage = (missing) =>
  `The file has no ${missing.map((h) => `'${h}'`).join(' or ')} column. Download the template and copy your data into it.`;

/**
 * Reads the file and checks every row against current data, writing nothing but the preview:
 * each row is ready, already in the system, or needs fixing (with the column and why).
 */
export async function checkRun(run, { storage }) {
  if (!run) return null;
  try {
    let file;
    try {
      file = await readImportFile(await readStoredFile(storage, run.fileKey));
    } catch (err) {
      if (!(err instanceof ImportFileError)) throw err;
      log(run, { phase: 'check', code: err.code }, 'import file refused');
      await finishCheck(run, { fileError: { code: err.code, message: err.message }, counts: emptyCounts(), rowCount: 0 });
      return ImportRun.findById(run._id).lean();
    }
    const { map, missing, unused } = matchHeaders(run.kind, file.headers);
    if (missing.length) {
      log(run, { phase: 'check', code: 'IMPORT_COLUMNS_MISSING' }, 'import file refused');
      await finishCheck(run, {
        fileError: { code: 'IMPORT_COLUMNS_MISSING', message: missingMessage(missing) },
        counts: emptyCounts(),
        rowCount: file.rows.length,
        headers: file.headers,
        unusedColumns: unused,
      });
      return ImportRun.findById(run._id).lean();
    }

    const adapter = getKindAdapter(run.kind);
    const ctx = await contextFor(run);
    const expiresAt = later(CHECK_KEEP_DAYS);
    const counts = emptyCounts();
    const seen = new Map();
    await ImportRow.deleteMany({ runId: run._id });
    let batch = [];
    for (const { rowNo, cells } of file.rows) {
      const parsed = parseRow(run.kind, cellsByKey(map, cells), ctx);
      const row = { runId: run._id, branchId: run.branchId, rowNo, cells, expiresAt, data: null, key: null, groupKey: null, label: '', errors: [] };
      if (parsed.errors.length) {
        Object.assign(row, { status: 'error', errors: parsed.errors, label: firstText(cells, map) });
      } else {
        const key = rowKey(run.kind, parsed.data);
        const groupKey = adapter.group ? adapter.group(parsed.data) : null;
        Object.assign(row, { data: parsed.data, key, groupKey });
        if (!groupKey && seen.has(key)) {
          Object.assign(row, { status: 'error', errors: [{ column: null, message: `Same as row ${seen.get(key)}.` }], label: firstText(cells, map) });
        } else {
          if (!groupKey) seen.set(key, rowNo);
          const result = await adapter.check({ data: parsed.data, key, rowNo, groupKey }, ctx);
          Object.assign(row, { status: result.status, label: result.label ?? '', errors: result.errors ?? [] });
        }
      }
      counts[row.status] += 1;
      batch.push(row);
      if (batch.length >= BATCH) {
        await ImportRow.insertMany(batch, { ordered: true });
        batch = [];
      }
    }
    if (batch.length) await ImportRow.insertMany(batch, { ordered: true });
    await finishCheck(run, { counts, rowCount: file.rows.length, headers: file.headers, unusedColumns: unused, fileError: null });
    log(run, { phase: 'check', counts }, 'import checked');
  } catch (err) {
    logger.error({ runId: String(run._id), kind: run.kind, phase: 'check', code: 'IMPORT_FAILED', errName: err?.name }, 'import check failed');
    await ImportRun.updateOne(
      { _id: run._id, status: 'checking', claimedAt: run.claimedAt },
      { $set: { status: 'failed', finishedAt: clock.now(), claimedAt: null, fileError: CHECK_FAILED } },
    );
  }
  return ImportRun.findById(run._id).lean();
}

// A short label for a row that needs fixing: the first column's text (the name, phone or number).
function firstText(cells, map) {
  const firstIndex = Object.entries(map).find(([, key]) => key)?.[0];
  const value = firstIndex === undefined ? null : cells[Number(firstIndex)];
  return value === null || value === undefined ? '' : String(value).slice(0, 100);
}

async function recount(runId) {
  const groups = await ImportRow.aggregate([{ $match: { runId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const counts = emptyCounts();
  for (const g of groups) counts[g._id] = g.n;
  return counts;
}

/**
 * Adds the run's ready rows in spreadsheet order through the kind's adapter (whole groups at
 * once). A service's refusal fails just that row; anything else stops the run as `failed`, to
 * be continued. Progress is saved every 25 rows.
 */
export async function commitRun(run, { storage }) {
  void storage;
  if (!run) return null;
  const mine = { _id: run._id, status: 'importing' };
  const adapter = getKindAdapter(run.kind);
  const actor = { userId: run.actor.userId, ip: run.actor.ip, userAgent: run.actor.userAgent };
  let counts = await recount(run._id);
  let sinceSave = 0;
  let nextRow = run.nextRow;
  const save = async () => {
    const { modifiedCount } = await ImportRun.updateOne(mine, { $set: { counts, nextRow, claimedAt: clock.now() } });
    sinceSave = 0;
    return modifiedCount > 0;
  };
  try {
    const ctx = await contextFor(run);
    for (;;) {
      const rows = await ImportRow.find({ runId: run._id, status: 'ready', rowNo: { $gte: nextRow } }).sort({ rowNo: 1 }).limit(100).lean();
      if (!rows.length) break;
      for (const row of rows) {
        const fresh = await ImportRow.findOne({ _id: row._id }, { status: 1 }).lean();
        if (fresh?.status !== 'ready') continue; // added already, with its group
        const members = row.groupKey
          ? await ImportRow.find({ runId: run._id, groupKey: row.groupKey, status: 'ready' }).sort({ rowNo: 1 }).lean()
          : [row];
        let outcome;
        try {
          outcome = await adapter.commit(members, ctx, actor);
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          outcome = { status: 'failed', entityId: null, errors: [{ column: null, message: err.message }] };
        }
        const ids = members.map((m) => m._id);
        await ImportRow.updateMany(
          { _id: { $in: ids } },
          { $set: { status: outcome.status, entityId: outcome.entityId ?? null, ...(outcome.errors && { errors: outcome.errors }) } },
        );
        counts.ready -= ids.length;
        counts[outcome.status] += ids.length;
        nextRow = row.rowNo + 1;
        sinceSave += ids.length;
        if (sinceSave >= SAVE_EVERY && !(await save())) return ImportRun.findById(run._id).lean();
      }
    }
    counts = await recount(run._id);
    const finishedAt = clock.now();
    await withTransaction(async (session) => {
      const { modifiedCount } = await ImportRun.updateOne(mine, {
        $set: { status: 'done', finishedAt, counts, nextRow, claimedAt: null, fileError: null },
      }).session(session);
      if (!modifiedCount) return;
      await recordAudit(
        { branchId: run.branchId, entityType: 'import', entityId: run._id, action: 'finish', after: { kind: run.kind, counts }, actor },
        session,
      );
    });
    await ImportRow.updateMany({ runId: run._id }, { $set: { expiresAt: new Date(finishedAt.getTime() + DONE_KEEP_DAYS * DAY_MS) } });
    log(run, { phase: 'commit', counts }, 'import finished');
  } catch (err) {
    logger.error({ runId: String(run._id), kind: run.kind, phase: 'commit', code: 'IMPORT_FAILED', errName: err?.name }, 'import stopped');
    await ImportRun.updateOne(mine, {
      $set: { status: 'failed', counts: await recount(run._id), nextRow, claimedAt: null, finishedAt: clock.now(), fileError: STOPPED },
    });
  }
  return ImportRun.findById(run._id).lean();
}

/** Works a claimed run: checks it or adds its rows, by status. */
export function workRun(run, { storage }) {
  if (!run) return null;
  return run.status === 'checking' ? checkRun(run, { storage }) : commitRun(run, { storage });
}
