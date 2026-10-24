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
