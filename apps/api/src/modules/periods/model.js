import mongoose from 'mongoose';
import { commonFields } from '../../core/commonFields.js';

// One document per branch and month. A locked month takes no new billing writes (spec §5.7).
const historySchema = new mongoose.Schema(
  {
    action: { type: String, enum: ['lock', 'unlock'], required: true },
    note: { type: String, default: '' },
    reason: { type: String, default: '' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const periodLockSchema = new mongoose.Schema({
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  // IST month, 'YYYY-MM'.
  month: { type: String, required: true },
  locked: { type: Boolean, default: false },
  lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  lockedAt: { type: Date, default: null },
  note: { type: String, default: '' },
  history: { type: [historySchema], default: [] },
  // Bumped by every lock and by every write into a past month, so the two cannot interleave.
  guardSeq: { type: Number, default: 0 },
});
periodLockSchema.plugin(commonFields);
periodLockSchema.index({ branchId: 1, month: 1 }, { unique: true });

export const PeriodLock = mongoose.models.PeriodLock ?? mongoose.model('PeriodLock', periodLockSchema);
