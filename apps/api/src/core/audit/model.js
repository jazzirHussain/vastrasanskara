import mongoose from 'mongoose';

const auditSchema = new mongoose.Schema(
  {
    seq: { type: Number, required: true },
    // Stored as the hex string that was hashed, so raw reads match the hash input exactly.
    branchId: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    action: { type: String, required: true },
    changes: { type: mongoose.Schema.Types.Mixed, required: true },
    userId: { type: String, default: null },
    at: { type: Date, required: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
  },
  // minimize: false keeps empty objects inside `changes`, which are part of the hash.
  { collection: 'auditLog', versionKey: false, minimize: false },
);

auditSchema.index({ branchId: 1, seq: 1 }, { unique: true });
auditSchema.index({ entityType: 1, entityId: 1, seq: -1 });

// Append-only: refuse every Mongoose update and delete.
const refuse = () => {
  throw new Error('auditLog is append-only');
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
  auditSchema.pre(op, { document: false, query: true }, refuse);
}
auditSchema.pre(['updateOne', 'deleteOne'], { document: true, query: false }, refuse);

export const AuditLog = mongoose.models.AuditLog ?? mongoose.model('AuditLog', auditSchema);
