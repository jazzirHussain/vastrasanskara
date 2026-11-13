import mongoose from 'mongoose';
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES } from '@vs/shared';
import { commonFields } from '../../core/commonFields.js';

const { ObjectId } = mongoose.Schema.Types;

// A consultation, measurement, fitting or pickup with one designer. Personal data: never audited.
const appointmentSchema = new mongoose.Schema({
  branchId: { type: ObjectId, ref: 'Branch', required: true },
  type: { type: String, enum: APPOINTMENT_TYPES, required: true },
  designerId: { type: ObjectId, ref: 'User', required: true },
  // Exactly one of customerId / enquiryId. An enquiry converted later resolves its customer at read time.
  customerId: { type: ObjectId, ref: 'Customer', default: null },
  enquiryId: { type: ObjectId, ref: 'Enquiry', default: null },
  // IST day of `start` (appointments never cross midnight).
  date: { type: String, required: true },
  start: { type: Date, required: true },
  end: { type: Date, required: true },
  minutes: { type: Number, required: true },
  status: { type: String, enum: APPOINTMENT_STATUSES, default: 'booked' },
  garmentIds: { type: [ObjectId], default: [] },
  note: { type: String, default: '' },
  // When booked or last moved: reminders compare it with the start.
  scheduledAt: { type: Date, required: true },
  statusAt: { type: Date, default: null },
  statusBy: { type: ObjectId, ref: 'User', default: null },
  cancelReason: { type: String, default: null },
});
appointmentSchema.plugin(commonFields);

const objectIdOnly = (path) => ({ [path]: { $type: 'objectId' } });
appointmentSchema.index({ branchId: 1, date: 1, start: 1 }, { name: 'by_day' });
appointmentSchema.index({ branchId: 1, designerId: 1, date: 1, start: 1 }, { name: 'by_designer_day' });
appointmentSchema.index({ status: 1, start: 1 }, { name: 'reminders' });
appointmentSchema.index({ branchId: 1, customerId: 1, start: 1 }, { name: 'by_customer', partialFilterExpression: objectIdOnly('customerId') });
appointmentSchema.index({ branchId: 1, enquiryId: 1, start: 1 }, { name: 'by_enquiry', partialFilterExpression: objectIdOnly('enquiryId') });

export const Appointment = mongoose.models.Appointment ?? mongoose.model('Appointment', appointmentSchema);

// One document per (branch, designer, IST day). Every booking or move writes the documents of the
// days it touches inside its transaction, so two writes to one designer-day conflict and the
// loser is retried against the committed data (spec §7.2).
const appointmentLockSchema = new mongoose.Schema({ _id: { type: String }, n: { type: Number, default: 0 } }, { versionKey: false });
export const AppointmentLock =
  mongoose.models.AppointmentLock ?? mongoose.model('AppointmentLock', appointmentLockSchema, 'appointmentLocks');

export const lockKey = (branchId, designerId, date) => `${branchId}:${designerId}:${date}`;

/**
 * Makes sure the lock documents exist, outside any transaction: two transactions inserting the
 * same new document could fail on the unique _id instead of conflicting and retrying.
 */
export async function ensureDesignerDayLocks(keys) {
  await Promise.all(keys.map((_id) => AppointmentLock.updateOne({ _id }, { $setOnInsert: { n: 0 } }, { upsert: true })));
}

/** Writes the (designer, day) lock inside `session`; throws outside a transaction. */
export async function lockDesignerDay(branchId, designerId, date, session) {
  if (!session?.inTransaction()) throw new Error('lockDesignerDay must run in a transaction');
  await AppointmentLock.updateOne({ _id: lockKey(branchId, designerId, date) }, { $inc: { n: 1 } }, { upsert: true, session });
}
