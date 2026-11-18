import mongoose from 'mongoose';
import { STAGE_KEYS } from '@vs/shared/stages.js';
import { commonFields } from '../../core/commonFields.js';

const { ObjectId } = mongoose.Schema.Types;

// Business dates ('YYYY-MM-DD', IST) are strings throughout, compared as strings.
const orderSchema = new mongoose.Schema({
  branchId: { type: ObjectId, ref: 'Branch', required: true },
  orderNo: { type: String, required: true },
  // The number in the old paper book, for orders brought in from earlier records ("Old no.").
  legacyRef: { type: String, default: null },
  customerId: { type: ObjectId, ref: 'Customer', required: true },
  designerId: { type: ObjectId, ref: 'User', required: true },
  priority: { type: String, enum: ['normal', 'rush'], default: 'normal' },
  expectedBudget: { type: Number, default: null },
  notes: { type: String, default: '' },
  orderDate: { type: String, required: true },
  pickupDate: { type: String, required: true },
  originalPickupDate: { type: String, required: true },
  occasionDate: { type: String, default: null },
  status: { type: String, enum: ['active', 'on_hold', 'completed', 'cancelled'], default: 'active' },
  holdHistory: [
    {
      _id: false,
      from: { type: String, required: true },
      to: { type: String, default: null },
      reason: { type: String, default: '' },
      by: { type: ObjectId, ref: 'User' },
    },
  ],
  // Bumped by every stage action on the order's garments, so two at once conflict and one
  // retries (and sees the other's garments) instead of both missing that the order is finished.
  stageSeq: { type: Number, default: 0 },
  cancellation: {
    type: new mongoose.Schema(
      {
        reason: String,
        furthestStage: String,
        refundPercent: Number,
        at: Date,
        by: { type: ObjectId, ref: 'User' },
      },
      { _id: false },
    ),
    default: null,
  },
});
orderSchema.plugin(commonFields);
orderSchema.index({ branchId: 1, orderNo: 1 }, { unique: true });
orderSchema.index({ branchId: 1, status: 1, pickupDate: 1 });
orderSchema.index({ branchId: 1, designerId: 1, pickupDate: 1 });
orderSchema.index({ branchId: 1, customerId: 1 });
orderSchema.index({ branchId: 1, orderDate: 1, _id: 1 }, { name: 'by_order_date' });
orderSchema.index({ branchId: 1, legacyRef: 1 }, { name: 'legacy_ref', unique: true, partialFilterExpression: { legacyRef: { $type: 'string' } } });

export const Order = mongoose.models.Order ?? mongoose.model('Order', orderSchema);

const stagePlanEntry = new mongoose.Schema(
  {
    stage: { type: String, enum: STAGE_KEYS, required: true },
    plannedDate: { type: String, default: null },
    originalPlannedDate: { type: String, default: null },
    skipped: { type: Boolean, default: false },
    skipReason: { type: String, default: null },
  },
  { _id: false },
);

const garmentSchema = new mongoose.Schema({
  branchId: { type: ObjectId, ref: 'Branch', required: true },
  orderId: { type: ObjectId, ref: 'Order', required: true },
  garmentNo: { type: String, required: true },
  index: { type: Number, required: true },
  type: { type: String, required: true },
  description: { type: String, required: true },
  fabric: { type: String, default: '' },
  designNotes: { type: String, default: '' },
  quantity: { type: Number, default: 1 },
  agreedPrice: { type: Number, required: true },
  catalogItemId: { type: ObjectId, default: null },
  dueDate: { type: String, default: null },
  originalDueDate: { type: String, default: null },
  batchId: { type: ObjectId, default: null },
  referenceKeys: { type: [String], default: [] },
  measurementId: { type: ObjectId, ref: 'Measurement', default: null },
  stagePlan: { type: [stagePlanEntry], default: [] },
  currentStage: { type: String, enum: STAGE_KEYS, default: 'order_taken' },
  stageState: { type: String, enum: ['pending', 'in_progress', 'with_vendor'], default: 'pending' },
  status: { type: String, enum: ['in_progress', 'ready', 'picked_up', 'rejected', 'cancelled'], default: 'in_progress' },
  alterationOpen: { type: Boolean, default: false },
  tightSchedule: { type: Boolean, default: false },
  // Set while a stage is with a vendor (stageState 'with_vendor').
  vendorWork: {
    type: new mongoose.Schema(
      { vendorId: { type: ObjectId, ref: 'Vendor' }, dueBackDate: String, sentOn: String },
      { _id: false },
    ),
    default: null,
  },
  // The day the garment last became ready for pickup.
  readyDate: { type: String, default: null },
  rejection: {
    type: new mongoose.Schema(
      {
        resolution: { type: String, enum: ['refund', 'remake', 'write_off'] },
        reason: String,
        remakeGarmentId: { type: ObjectId, default: null },
        at: Date,
        by: { type: ObjectId, ref: 'User' },
      },
      { _id: false },
    ),
    default: null,
  },
  // The rejected garment this one remakes.
  remakeOf: { type: ObjectId, default: null },
  materials: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Bumped by every change to the garment's materials (stock module), so a stage action or a
  // cancellation at the same moment conflicts with it and retries. Not the garment's version.
  materialsSeq: { type: Number, default: 0 },
});
garmentSchema.plugin(commonFields);
garmentSchema.index({ branchId: 1, garmentNo: 1 }, { unique: true });
garmentSchema.index({ orderId: 1, index: 1 });
garmentSchema.index({ branchId: 1, status: 1, dueDate: 1 });
garmentSchema.index({ branchId: 1, referenceKeys: 1 });
garmentSchema.index({ branchId: 1, readyDate: 1 }, { name: 'ready', partialFilterExpression: { readyDate: { $type: 'string' } } });
// Batch members, for expense costing (only garments of a batch carry a batchId).
garmentSchema.index({ branchId: 1, batchId: 1 }, { name: 'batch', partialFilterExpression: { batchId: { $type: 'objectId' } } });

export const Garment = mongoose.models.Garment ?? mongoose.model('Garment', garmentSchema);
