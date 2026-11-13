import mongoose from 'mongoose';
import { CUSTOMER_SOURCES, ENQUIRY_STATUSES } from '@vs/shared';
import { commonFields } from '../../core/commonFields.js';

const { ObjectId } = mongoose.Schema.Types;

// What happened on the enquiry, newest last, at most MAX_ENQUIRY_LOG entries.
const logEntrySchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    by: { type: ObjectId, ref: 'User', default: null },
    kind: { type: String, enum: ['call', 'status', 'appointment', 'note'], required: true },
    text: { type: String, default: '' },
  },
  { _id: false },
);

// A phone or walk-in enquiry before it becomes an order. Holds personal data: never audited or logged.
const enquirySchema = new mongoose.Schema({
  branchId: { type: ObjectId, ref: 'Branch', required: true },
  name: { type: String, required: true, trim: true },
  // Lower-case name for prefix search.
  searchName: { type: String, required: true },
  // E.164.
  phone: { type: String, required: true },
  garmentTypes: { type: [String], default: [] },
  interest: { type: String, default: '' },
  // Paise; a rough figure.
  budget: { type: Number, default: null },
  source: { type: String, enum: CUSTOMER_SOURCES, default: 'walk_in' },
  occasionDate: { type: String, default: null },
  followUpDate: { type: String, default: null },
  status: { type: String, enum: ENQUIRY_STATUSES, default: 'new' },
  // status ∈ OPEN_ENQUIRY_STATUSES, stored so partial and equality indexes can use it.
  isOpen: { type: Boolean, default: true },
  lostReason: { type: String, default: null },
  // IST date of capture.
  enquiryDate: { type: String, required: true },
  convertedCustomerId: { type: ObjectId, ref: 'Customer', default: null },
  convertedOrderId: { type: ObjectId, ref: 'Order', default: null },
  convertedAt: { type: Date, default: null },
  log: { type: [logEntrySchema], default: [] },
});
enquirySchema.plugin(commonFields);

const objectIdOnly = (path) => ({ [path]: { $type: 'objectId' } });
// One open enquiry per phone: a second capture of the same caller is refused.
enquirySchema.index({ branchId: 1, phone: 1 }, { name: 'open_phone', unique: true, partialFilterExpression: { isOpen: true } });
enquirySchema.index({ branchId: 1, isOpen: 1, followUpDate: 1, _id: 1 }, { name: 'follow_ups' });
enquirySchema.index({ branchId: 1, isOpen: 1, enquiryDate: 1, _id: 1 }, { name: 'by_open' });
enquirySchema.index({ branchId: 1, status: 1, enquiryDate: 1, _id: 1 }, { name: 'by_status' });
enquirySchema.index({ branchId: 1, enquiryDate: 1, _id: 1 }, { name: 'by_date' });
enquirySchema.index({ branchId: 1, searchName: 1 }, { name: 'by_name' });
enquirySchema.index({ branchId: 1, phone: 1, enquiryDate: 1 }, { name: 'by_phone' });
enquirySchema.index(
  { branchId: 1, convertedCustomerId: 1 },
  { name: 'converted_customer', partialFilterExpression: objectIdOnly('convertedCustomerId') },
);

export const Enquiry = mongoose.models.Enquiry ?? mongoose.model('Enquiry', enquirySchema);
