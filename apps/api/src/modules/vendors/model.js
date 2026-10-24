import mongoose from 'mongoose';
import { commonFields } from '../../core/commonFields.js';

// Outside workshops and suppliers that take on stage work.
const vendorSchema = new mongoose.Schema({
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  name: { type: String, required: true, trim: true },
  // Lower-case name for sorting.
  searchName: { type: String, required: true },
  phone: { type: String, default: null },
  gstin: { type: String, default: null },
  stateCode: { type: String, required: true },
  services: { type: [String], default: [] },
  active: { type: Boolean, default: true },
});
vendorSchema.plugin(commonFields);
vendorSchema.index({ branchId: 1, searchName: 1 });

export const Vendor = mongoose.models.Vendor ?? mongoose.model('Vendor', vendorSchema);
