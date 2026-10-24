import mongoose from 'mongoose';

/**
 * Common fields for editable documents: createdAt/updatedAt (timestamps), createdBy/updatedBy,
 * and optimistic concurrency so a stale save fails with VersionError (→ 409).
 */
export function commonFields(schema) {
  schema.add({
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  });
  schema.set('timestamps', true);
  schema.set('optimisticConcurrency', true);
}
