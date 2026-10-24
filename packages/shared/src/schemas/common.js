import { z } from 'zod';

export const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid id');

export const email = z.string().trim().toLowerCase().pipe(z.email());

// 10-digit Indian mobile; an optional +91 prefix, spaces and hyphens are stripped.
export const phone = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, '').replace(/^\+91/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Invalid mobile number'));

export const gstin = z
  .string()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN');

export const stateCode = z.string().regex(/^(0[1-9]|[12][0-9]|3[0-8]|97)$/, 'Invalid state code');

export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid time');

export const paise = z.int().nonnegative();

export const password = z.string().min(10).max(200);
