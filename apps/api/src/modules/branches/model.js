import mongoose from 'mongoose';
import { commonFields } from '../../core/commonFields.js';

const branchSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  legalName: { type: String, required: true, trim: true },
  gstin: { type: String, default: null },
  stateCode: { type: String, required: true },
  address: {
    line1: { type: String, default: '' },
    line2: { type: String, default: '' },
    city: { type: String, default: '' },
    pincode: { type: String, default: '' },
  },
  phone: { type: String, default: null },
  email: { type: String, default: null, lowercase: true, trim: true },
  logoKey: { type: String, default: null },
  prefixes: {
    invoice: { type: String, default: 'INV' },
    creditNote: { type: String, default: 'CN' },
    receiptVoucher: { type: String, default: 'RV' },
    receipt: { type: String, default: 'RCPT' },
    refund: { type: String, default: 'RF' },
    expense: { type: String, default: 'EXP' },
    order: { type: String, default: 'VS/ORD' },
  },
});
branchSchema.plugin(commonFields);

export const Branch = mongoose.models.Branch ?? mongoose.model('Branch', branchSchema);
