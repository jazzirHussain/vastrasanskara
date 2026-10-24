import mongoose from 'mongoose';
import { commonFields } from '../../core/commonFields.js';

const customerSchema = new mongoose.Schema({
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  name: { type: String, required: true, trim: true },
  // Lower-case name for prefix search.
  searchName: { type: String, required: true },
  // E.164, unique per branch.
  phone: { type: String, required: true },
  email: { type: String, default: null },
  type: { type: String, enum: ['individual', 'business', 'film_production'], default: 'individual' },
  gstin: { type: String, default: null },
  stateCode: { type: String, required: true },
  billingAddress: {
    line1: { type: String, default: '' },
    line2: { type: String, default: '' },
    city: { type: String, default: '' },
    pincode: { type: String, default: '' },
  },
  source: { type: String, default: 'walk_in' },
  consent: {
    email: { type: Boolean, default: false },
    whatsapp: { type: Boolean, default: false },
    sms: { type: Boolean, default: false },
  },
  consentNote: { type: String, default: '' },
  preferredChannel: { type: String, enum: ['email', 'whatsapp', 'sms', null], default: null },
});
customerSchema.plugin(commonFields);
customerSchema.index({ branchId: 1, phone: 1 }, { unique: true });
customerSchema.index({ branchId: 1, searchName: 1 });

export const Customer = mongoose.models.Customer ?? mongoose.model('Customer', customerSchema);
