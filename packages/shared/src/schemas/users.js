import { z } from 'zod';
import { ROLES } from '../permissions.js';
import { email, password } from './common.js';

const name = z.string().trim().min(1).max(100);
const roles = z.array(z.enum(ROLES)).min(1).max(ROLES.length);

export const createUserSchema = z.strictObject({ name, email, roles });

export const updateUserSchema = z
  .strictObject({ name, roles, active: z.boolean() })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to update');

export const passwordResetRequestSchema = z.strictObject({ email });

export const passwordResetConfirmSchema = z.strictObject({
  token: z.string().min(1).max(200),
  password,
});
