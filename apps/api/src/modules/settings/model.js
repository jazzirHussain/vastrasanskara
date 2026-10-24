import mongoose from 'mongoose';
import { commonFields } from '../../core/commonFields.js';

// One settings document per branch; `values` is validated by the shared settingsSchema.
const settingsSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, unique: true },
    values: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  // minimize: false keeps empty objects such as stageDurations.byGarmentType.
  { minimize: false },
);
settingsSchema.plugin(commonFields);

export const Settings = mongoose.models.Settings ?? mongoose.model('Settings', settingsSchema);
