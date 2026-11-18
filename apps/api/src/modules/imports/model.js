import mongoose from 'mongoose';
import { commonFields } from '../../core/commonFields.js';

const { ObjectId, Mixed } = mongoose.Schema.Types;

export const IMPORT_STATUSES = ['checking', 'checked', 'importing', 'done', 'failed', 'cancelled', 'expired'];
export const ROW_STATUSES = ['ready', 'exists', 'error', 'added', 'skipped', 'failed'];
export const COUNT_KEYS = ROW_STATUSES;

const countsSchema = new mongoose.Schema(
  Object.fromEntries(COUNT_KEYS.map((k) => [k, { type: Number, default: 0 }])),
  { _id: false },
);
const problemSchema = new mongoose.Schema({ code: String, message: String }, { _id: false });

// One uploaded file of old records: checked (nothing written), previewed, confirmed by the
// admin, then added row by row in the background. Kept for good (counts, who, when, hash).
const importRunSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    kind: { type: String, required: true },
    fileKey: { type: String, required: true },
    fileName: { type: String, required: true },
    fileSha256: { type: String, default: null },
    // The latest earlier run of the same kind with the same file, if any.
    sameFileAs: { type: ObjectId, default: null },
    // The cut-over date, for opening balances.
    asOf: { type: String, default: null },
    status: { type: String, enum: IMPORT_STATUSES, default: 'checking' },
    phase: { type: String, enum: ['check', 'commit'], default: 'check' },
    rowCount: { type: Number, default: null },
    // Commit resumes from this spreadsheet row after an interruption.
    nextRow: { type: Number, default: 0 },
    counts: { type: countsSchema, default: () => ({}) },
    // How many rows were ready when the admin confirmed (the progress total).
    toAdd: { type: Number, default: 0 },
    // The file's own header row, for "rows to fix".
    headers: { type: [String], default: [] },
    unusedColumns: { type: [String], default: [] },
    fileError: { type: problemSchema, default: null },
    attempts: { type: Number, default: 0 },
    claimedAt: { type: Date, default: null },
    requestedBy: { type: ObjectId, ref: 'User', required: true },
    confirmedBy: { type: ObjectId, ref: 'User', default: null },
    confirmedAt: { type: Date, default: null },
    // Who the added records are audited as: the confirming admin, from the confirm request.
    actor: {
      type: new mongoose.Schema({ userId: ObjectId, ip: String, userAgent: String }, { _id: false }),
      default: null,
    },
    finishedAt: { type: Date, default: null },
  },
  { collection: 'importRuns', minimize: false },
);
importRunSchema.plugin(commonFields);
importRunSchema.index({ branchId: 1, createdAt: 1, _id: 1 }, { name: 'recent' });
importRunSchema.index(
  { status: 1, claimedAt: 1 },
  { name: 'queue', partialFilterExpression: { status: { $in: ['checking', 'importing'] } } },
);
importRunSchema.index({ branchId: 1 }, { name: 'one_importing', unique: true, partialFilterExpression: { status: 'importing' } });
importRunSchema.index({ branchId: 1, kind: 1, fileSha256: 1 }, { name: 'by_hash' });

export const ImportRun = mongoose.models.ImportRun ?? mongoose.model('ImportRun', importRunSchema);

// One spreadsheet row of a run and what became of it. Holds personal data, so it is deleted
// 7 days after an unconfirmed check and 30 days after the run finishes.
const importRowSchema = new mongoose.Schema(
  {
    runId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    rowNo: { type: Number, required: true },
    key: { type: String, default: null },
    status: { type: String, enum: ROW_STATUSES, required: true },
    errors: { type: [new mongoose.Schema({ column: String, message: String }, { _id: false })], default: [] },
    data: { type: Mixed, default: null },
    // The row's original values, for "rows to fix".
    cells: { type: [Mixed], default: [] },
    label: { type: String, default: '' },
    entityId: { type: ObjectId, default: null },
    // Rows sharing a group (one open order over several garments) are added together.
    groupKey: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'importRows', versionKey: false, minimize: false, suppressReservedKeysWarning: true },
);
importRowSchema.index({ runId: 1, rowNo: 1 }, { name: 'row', unique: true });
importRowSchema.index({ runId: 1, status: 1, rowNo: 1 }, { name: 'by_status' });
importRowSchema.index({ runId: 1, groupKey: 1 }, { name: 'by_group', partialFilterExpression: { groupKey: { $type: 'string' } } });
importRowSchema.index({ expiresAt: 1 }, { name: 'expires', expireAfterSeconds: 0 });

export const ImportRow = mongoose.models.ImportRow ?? mongoose.model('ImportRow', importRowSchema);
