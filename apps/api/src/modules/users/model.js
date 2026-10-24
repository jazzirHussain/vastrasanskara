import mongoose from 'mongoose';
import { ROLES } from '@vs/shared/permissions.js';
import { commonFields } from '../../core/commonFields.js';

const userSchema = new mongoose.Schema({
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  roles: {
    type: [{ type: String, enum: ROLES }],
    validate: { validator: (roles) => roles.length > 0, message: 'At least one role is required' },
  },
  active: { type: Boolean, default: true },
  failedLoginCount: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
});
userSchema.plugin(commonFields);

export const User = mongoose.models.User ?? mongoose.model('User', userSchema);

// One-time password links (resets and invites). Only the token's SHA-256 is stored.
const passwordResetSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    purpose: { type: String, enum: ['reset', 'invite'], required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// MongoDB removes links a day after they expire.
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
passwordResetSchema.index({ userId: 1, usedAt: 1 });

export const PasswordReset =
  mongoose.models.PasswordReset ?? mongoose.model('PasswordReset', passwordResetSchema);
