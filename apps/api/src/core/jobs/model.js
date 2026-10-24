import mongoose from 'mongoose';

const jobFailureSchema = new mongoose.Schema(
  {
    job: { type: String, required: true },
    error: { type: String, required: true },
    attempt: { type: Number, required: true },
    at: { type: Date, required: true },
  },
  { collection: 'jobFailures', versionKey: false },
);
jobFailureSchema.index({ at: -1 });

export const JobFailure = mongoose.models.JobFailure ?? mongoose.model('JobFailure', jobFailureSchema);
