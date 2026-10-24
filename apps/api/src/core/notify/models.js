import mongoose from 'mongoose';
import { commonFields } from '../commonFields.js';

const { ObjectId, Mixed } = mongoose.Schema.Types;

const ruleSchema = new mongoose.Schema({
  branchId: { type: ObjectId, ref: 'Branch', required: true },
  event: { type: String, required: true },
  recipients: { type: [String], default: [] },
  channels: { type: [String], default: [] },
  fallback: { type: String, default: null },
  enabled: { type: Boolean, default: true },
});
ruleSchema.index({ branchId: 1, event: 1 }, { unique: true });
ruleSchema.plugin(commonFields);

const templateSchema = new mongoose.Schema({
  branchId: { type: ObjectId, ref: 'Branch', required: true },
  event: { type: String, required: true },
  channel: { type: String, required: true },
  subject: { type: String, default: null },
  body: { type: String, required: true },
});
templateSchema.index({ branchId: 1, event: 1, channel: 1 }, { unique: true });
templateSchema.plugin(commonFields);

export const OUTBOX_STATUSES = ['pending', 'sending', 'sent', 'delivered', 'failed', 'skipped'];

const outboxSchema = new mongoose.Schema(
  {
    branchId: { type: String, required: true },
    event: { type: String, required: true },
    channel: { type: String, required: true },
    recipient: {
      kind: { type: String, enum: ['user', 'client'], required: true },
      id: { type: String, required: true },
      name: { type: String, default: '' },
      // This channel's address; `addresses` keeps all of them for a later fallback entry.
      address: { type: String, default: null },
      addresses: { type: Mixed, default: {} },
    },
    vars: { type: Mixed, default: {} },
    attachments: { type: [{ key: String, filename: String, _id: false }], default: [] },
    scheduledFor: { type: Date, required: true },
    status: { type: String, enum: OUTBOX_STATUSES, default: 'pending' },
    skipReason: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    providerMessageId: { type: String, default: null },
    isFallback: { type: Boolean, default: false },
    dedupeKey: { type: String, required: true, unique: true },
    lockedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
  },
  { collection: 'outbox', timestamps: true, minimize: false },
);
outboxSchema.index({ status: 1, scheduledFor: 1 });

export const NotificationRule =
  mongoose.models.NotificationRule ?? mongoose.model('NotificationRule', ruleSchema);
export const NotificationTemplate =
  mongoose.models.NotificationTemplate ?? mongoose.model('NotificationTemplate', templateSchema);
export const Outbox = mongoose.models.Outbox ?? mongoose.model('Outbox', outboxSchema);
