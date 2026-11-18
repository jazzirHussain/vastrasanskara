import mongoose from 'mongoose';

/**
 * Failed logins for emails that have no account, counted like an account's own
 * failedLoginCount/lockedUntil so a locked answer reveals nothing. Removed a day after the
 * last attempt.
 */
const loginFailureSchema = new mongoose.Schema(
  {
    email: { type: String, required: true },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'loginFailures', versionKey: false },
);

loginFailureSchema.index({ email: 1 }, { unique: true });
loginFailureSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LoginFailure = mongoose.model('LoginFailure', loginFailureSchema);
