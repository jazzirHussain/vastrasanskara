// Bringing in old records: starting a check of an uploaded file, reading runs and their rows,
// confirming, cancelling and continuing, and the worker's pass over waiting runs.
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { IMPORT_KIND_KEYS, IMPORT_LIGHT_ROWS } from '@vs/shared';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { AppError, businessRule, conflict, notFound, validationError } from '../../core/errors.js';
import { paginate } from '../../core/pagination.js';
import { logger } from '../../logger.js';
import { ImportRow, ImportRun } from './model.js';
import { CHECK_KEEP_DAYS, claimRun, readStoredFile, workRun } from './runner.js';
import { ImportFileError, problemsXlsx, readImportFile } from './sheets.js';

const DAY_MS = 86_400_000;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const busy = () => conflict('IMPORT_BUSY', 'Another import is running. Wait for it to finish.');
const isDuplicateKey = (err) => err?.code === 11000;

/** Works one run now, in the background of this process (small files). */
function workSoon(id, { storage }) {
  setImmediate(() => {
    claimRun({ id })
      .then((run) => workRun(run, { storage }))
      .catch((err) => logger.error({ runId: String(id), errName: err?.name }, 'import failed to start'));
  });
}

/**
 * Records an uploaded file to check. The file must be this branch's `import_file` upload.
 * Small files (up to 200 rows) are checked at once; larger ones by the worker within a minute.
 */
export async function startImport(branchId, input, actor, { storage }) {
  if (!input.fileKey.startsWith(`${branchId}/import_file/`)) {
    throw validationError([{ path: 'fileKey', message: 'Upload the file first' }]);
  }
  const head = await storage.headObject(input.fileKey);
  if (!head) throw new AppError(400, 'ATTACHMENT_NOT_UPLOADED', 'The file has not finished uploading. Try again.');

  const buffer = await readStoredFile(storage, input.fileKey);
  const fileSha256 = head.sha256 || createHash('sha256').update(buffer).digest('hex');
  let rowCount = null;
  try {
    rowCount = (await readImportFile(buffer)).rows.length;
  } catch (err) {
    if (!(err instanceof ImportFileError)) throw err;
    rowCount = 0; // the check records the file's problem
  }
  const previous = await ImportRun.findOne({ branchId: oid(branchId), kind: input.kind, fileSha256 }, { _id: 1 })
    .sort({ createdAt: -1, _id: -1 })
    .lean();

  const run = await withTransaction(async (session) => {
    const [created] = await ImportRun.create(
      [
        {
          branchId,
          kind: input.kind,
          fileKey: input.fileKey,
          fileName: input.fileName,
          fileSha256,
          sameFileAs: previous?._id ?? null,
          asOf: input.asOf ?? null,
          rowCount,
          requestedBy: actor.userId,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      ],
      { session },
    );
    await recordAudit(
      { branchId, entityType: 'import', entityId: created._id, action: 'request', after: { kind: input.kind, rows: rowCount, asOf: input.asOf ?? null }, actor },
      session,
    );
    return created;
  });
  if (rowCount <= IMPORT_LIGHT_ROWS) workSoon(run._id, { storage });
  return run.toObject();
}

/** One run of the branch, or 404. */
export async function getImport(branchId, id) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const run = await ImportRun.findOne({ _id: id, branchId: oid(branchId) }).lean();
  if (!run) throw notFound();
  return run;
}

/** When the same file was uploaded before (the run named by `sameFileAs`), or null. */
export async function sameFileDate(run) {
  if (!run.sameFileAs) return null;
  const same = await ImportRun.findOne({ _id: run.sameFileAs, branchId: run.branchId }, { createdAt: 1 }).lean();
  return same?.createdAt ?? null;
}

/** The branch's runs, newest first; `kind` narrows to one kind. */
export function listImports(branchId, { kind, cursor, limit } = {}) {
  const filter = { branchId: oid(branchId), ...(kind && { kind }) };
  return paginate(ImportRun, filter, { sort: ['createdAt', -1], cursor, limit });
}

/** One run's rows in spreadsheet order; `status` narrows to one outcome. */
export async function listImportRows(branchId, id, { status, cursor, limit } = {}) {
  const run = await getImport(branchId, id);
  return paginate(ImportRow, { runId: run._id, ...(status && { status }) }, { sort: ['rowNo', 1], cursor, limit });
}

/** "Rows to fix": an Excel file of the rows that need fixing or could not be added. */
export async function problemsFile(branchId, id) {
  const run = await getImport(branchId, id);
  const rows = await ImportRow.find({ runId: run._id, status: { $in: ['error', 'failed'] } }, { rowNo: 1, cells: 1, errors: 1 })
    .sort({ rowNo: 1 })
    .lean();
  return { run, buffer: await problemsXlsx(run.headers ?? [], rows) };
}

const expired = (run, now = clock.now()) => run.createdAt.getTime() < now.getTime() - CHECK_KEEP_DAYS * DAY_MS;

// Moves a run on from `from` at `version`, recording `action` in the same transaction.
async function transition(branchId, id, { version, from, set, action, actor, after }) {
  try {
    return await withTransaction(async (session) => {
      const run = await ImportRun.findOne({ _id: id, branchId: oid(branchId) }).session(session);
      if (!run) throw notFound();
      if (run.__v !== version) throw conflict();
      if (!from.includes(run.status)) throw businessRule('IMPORT_NOT_ALLOWED', 'This can no longer be done for this file.');
      run.set({ ...set, updatedBy: actor.userId });
      run.increment();
      await run.save({ session });
      if (action) {
        await recordAudit({ branchId, entityType: 'import', entityId: run._id, action, after, actor }, session);
      }
      return run.toObject();
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw busy();
    throw err;
  }
}

async function assertNoneImporting(branchId, exceptId) {
  if (await ImportRun.exists({ branchId: oid(branchId), status: 'importing', _id: { $ne: oid(exceptId) } })) throw busy();
}

/** The admin adds the ready rows. The added records are audited as them, marked with this import. */
export async function confirmImport(branchId, id, { version }, actor, { storage }) {
  const run = await getImport(branchId, id);
  if (run.status === 'checked' && expired(run)) {
    throw businessRule('IMPORT_EXPIRED', 'This check is more than a week old. Upload the file again.');
  }
  if (run.status === 'checked' && !(run.counts?.ready > 0)) {
    throw businessRule('NOTHING_TO_IMPORT', 'There are no rows ready to add.');
  }
  await assertNoneImporting(branchId, id);
  const now = clock.now();
  const confirmed = await transition(branchId, id, {
    version,
    from: ['checked'],
    set: {
      status: 'importing',
      phase: 'commit',
      confirmedBy: actor.userId,
      confirmedAt: now,
      actor: { userId: actor.userId, ip: actor.ip ?? null, userAgent: `import:${id}` },
      toAdd: run.counts.ready,
      nextRow: 0,
      attempts: 0,
      claimedAt: null,
    },
    action: 'confirm',
    actor,
    after: { kind: run.kind, ready: run.counts.ready },
  });
  if (run.counts.ready <= IMPORT_LIGHT_ROWS) workSoon(confirmed._id, { storage });
  return confirmed;
}

/** Leaves a checked file without adding anything. */
export function cancelImport(branchId, id, { version }, actor) {
  return transition(branchId, id, { version, from: ['checked'], set: { status: 'cancelled', finishedAt: clock.now() }, action: 'cancel', actor, after: {} });
}

/** "Continue adding" after adding stopped part way. */
export async function resumeImport(branchId, id, { version }, actor, { storage }) {
  const run = await getImport(branchId, id);
  if (run.status === 'failed' && run.phase !== 'commit') {
    throw businessRule('IMPORT_NOT_ALLOWED', 'This file could not be checked. Upload it again.');
  }
  await assertNoneImporting(branchId, id);
  const resumed = await transition(branchId, id, {
    version,
    from: ['failed'],
    set: { status: 'importing', attempts: 0, claimedAt: null, finishedAt: null, fileError: null },
    action: 'resume',
    actor,
    after: {},
  });
  if (run.toAdd <= IMPORT_LIGHT_ROWS) workSoon(resumed._id, { storage });
  return resumed;
}

/** The worker: expires week-old unconfirmed checks, then works up to `limit` waiting runs. */
export async function runPendingImports({ storage, limit = 2, now = clock.now() } = {}) {
  await ImportRun.updateMany(
    { status: 'checked', createdAt: { $lt: new Date(now.getTime() - CHECK_KEEP_DAYS * DAY_MS) } },
    { $set: { status: 'expired', finishedAt: now } },
  );
  for (let i = 0; i < limit; i += 1) {
    const run = await claimRun();
    if (!run) return;
    await workRun(run, { storage });
  }
}

/** Per kind: the latest run and how many records it has brought in so far (for the go-live checklist). */
export async function importSummary(branchId) {
  const branch = oid(branchId);
  const [latest, added] = await Promise.all([
    ImportRun.aggregate([
      { $match: { branchId: branch, status: { $nin: ['cancelled', 'expired'] } } },
      { $sort: { createdAt: -1, _id: -1 } },
      { $group: { _id: '$kind', run: { $first: '$$ROOT' } } },
    ]),
    ImportRun.aggregate([
      { $match: { branchId: branch, status: { $in: ['done', 'failed', 'importing'] } } },
      { $group: { _id: '$kind', added: { $sum: '$counts.added' } } },
    ]),
  ]);
  const byKind = new Map(latest.map((l) => [l._id, l.run]));
  const addedByKind = new Map(added.map((a) => [a._id, a.added]));
  return Object.fromEntries(
    IMPORT_KIND_KEYS.map((kind) => {
      const run = byKind.get(kind);
      return [
        kind,
        {
          lastRun: run ? { id: String(run._id), status: run.status, counts: run.counts, finishedAt: run.finishedAt ?? null } : null,
          added: addedByKind.get(kind) ?? 0,
        },
      ];
    }),
  );
}
