import mongoose from 'mongoose';

// One set of measurements as taken on a day. A new set is recorded every time; never edited.
const measurementSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    garmentType: { type: String, required: true },
    values: [
      {
        _id: false,
        name: { type: String, required: true },
        value: { type: Number, required: true },
        unit: { type: String, enum: ['in', 'cm'], required: true },
      },
    ],
    notes: { type: String, default: '' },
    takenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    takenAt: { type: Date, required: true },
  },
  { versionKey: false },
);
measurementSchema.index({ customerId: 1, garmentType: 1, takenAt: -1 });

// Append-only: refuse every Mongoose update and delete.
const refuse = () => {
  throw new Error('measurements are append-only');
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
  measurementSchema.pre(op, { document: false, query: true }, refuse);
}
measurementSchema.pre(['updateOne', 'deleteOne'], { document: true, query: false }, refuse);

export const Measurement = mongoose.models.Measurement ?? mongoose.model('Measurement', measurementSchema);
