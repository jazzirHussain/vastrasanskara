import mongoose from 'mongoose';
import { commonFields } from '../../core/commonFields.js';

// Tailors, masters and artisans of the branch. They have no login.
const workerSchema = new mongoose.Schema({
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  name: { type: String, required: true, trim: true },
  // Lower-case name for sorting.
  searchName: { type: String, required: true },
  skill: { type: String, default: '' },
  phone: { type: String, default: null },
  active: { type: Boolean, default: true },
});
workerSchema.plugin(commonFields);
workerSchema.index({ branchId: 1, searchName: 1 });

export const Worker = mongoose.models.Worker ?? mongoose.model('Worker', workerSchema);
