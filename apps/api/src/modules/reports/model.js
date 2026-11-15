import mongoose from 'mongoose';
import { commonFields } from '../../core/commonFields.js';

const { ObjectId } = mongoose.Schema.Types;

export const RUN_STATUSES = ['queued', 'running', 'done', 'failed'];

const fileSchema = new mongoose.Schema(
  { key: String, filename: String, contentType: String, size: Number, sha256: String },
  { _id: false },
);

// One report file asked for (by the admin, or by the monthly schedule): queued, built in the
// background (or at once for light kinds), then downloadable through an audited 5-minute link.
const reportRunSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    kind: { type: String, required: true },
    format: { type: String, enum: ['xlsx', 'csv', 'pdf'], required: true },
    params: {
      month: { type: String, default: null },
      from: { type: String, default: null },
      to: { type: String, default: null },
      customerId: { type: ObjectId, default: null },
    },
    status: { type: String, enum: RUN_STATUSES, default: 'queued' },
    source: { type: String, enum: ['manual', 'schedule'], default: 'manual' },
    attempts: { type: Number, default: 0 },
    claimedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    error: { type: new mongoose.Schema({ code: String, message: String }, { _id: false }), default: null },
    file: { type: fileSchema, default: null },
    extraFiles: { type: [fileSchema], default: [] },
    rows: { type: Number, default: null },
    rowsHash: { type: String, default: null },
    // Null for scheduled runs (shown as "Automatic").
    requestedBy: { type: ObjectId, ref: 'User', default: null },
  },
  { collection: 'reportRuns', minimize: false },
);
reportRunSchema.plugin(commonFields);
reportRunSchema.index({ branchId: 1, createdAt: 1, _id: 1 }, { name: 'recent' });
reportRunSchema.index({ status: 1, createdAt: 1 }, { name: 'queue', partialFilterExpression: { status: { $in: ['queued', 'running'] } } });
reportRunSchema.index(
  { branchId: 1, kind: 1, 'params.month': 1, source: 1 },
  { name: 'schedule_unique', unique: true, partialFilterExpression: { source: 'schedule' } },
);

export const ReportRun = mongoose.models.ReportRun ?? mongoose.model('ReportRun', reportRunSchema);
