import mongoose from 'mongoose';
import { ACTIONS } from '@vs/shared/production.js';
import { STAGE_KEYS } from '@vs/shared/stages.js';

const { ObjectId } = mongoose.Schema.Types;

// One production step on one garment. Append-only: the garment's current state is
// denormalised from these in the same transaction.
const stageEventSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    orderId: { type: ObjectId, ref: 'Order', required: true },
    garmentId: { type: ObjectId, ref: 'Garment', required: true },
    stage: { type: String, enum: STAGE_KEYS, required: true },
    action: { type: String, enum: ACTIONS, required: true },
    workerIds: { type: [ObjectId], default: [] },
    vendorId: { type: ObjectId, ref: 'Vendor', default: null },
    dueBackDate: { type: String, default: null },
    readyBy: { type: String, default: null },
    reworkStage: { type: String, default: null },
    reason: { type: String, default: null },
    resolution: { type: String, default: null },
    chargeable: { type: Boolean, default: false },
    // Paise; read by billing for an extra-charge line.
    chargeAmount: { type: Number, default: null },
    remarks: { type: String, default: '' },
    photoKeys: { type: [String], default: [] },
    by: { type: ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true },
    // Shared by the events of one bulk action.
    bulkId: { type: ObjectId, default: null },
  },
  { collection: 'stageEvents', versionKey: false },
);
stageEventSchema.index({ garmentId: 1, at: 1 });
stageEventSchema.index({ branchId: 1, action: 1, at: 1 });
stageEventSchema.index({ branchId: 1, photoKeys: 1 });

const refuse = () => {
  throw new Error('stageEvents is append-only');
};
for (const op of [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
]) {
  stageEventSchema.pre(op, { document: false, query: true }, refuse);
}
stageEventSchema.pre('save', function onlyInserts() {
  if (!this.isNew) refuse();
});
stageEventSchema.pre(['updateOne', 'deleteOne'], { document: true, query: false }, refuse);

export const StageEvent = mongoose.models.StageEvent ?? mongoose.model('StageEvent', stageEventSchema);
