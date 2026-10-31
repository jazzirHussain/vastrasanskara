import { z } from 'zod';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid id');

export const email = z.string().trim().toLowerCase().pipe(z.email());

// Any country's number, normalised to E.164 ('+919876543210'). Numbers typed without a
// country code are read as Indian; a leading '00' international prefix is treated as '+'.
export const phone = z.string().transform((value, ctx) => {
  const input = value.trim().replace(/^00/, '+');
  const parsed = parsePhoneNumberFromString(input, 'IN');
  if (!parsed || !parsed.isValid()) {
    ctx.addIssue({ code: 'custom', message: 'Invalid phone number' });
    return z.NEVER;
  }
  return parsed.number;
});

export const gstin = z
  .string()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN');

export const stateCode = z.string().regex(/^(0[1-9]|[12][0-9]|3[0-8]|97)$/, 'Invalid state code');

export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid time');

export const paise = z.int().nonnegative();

/** Billing money: paise, capped at one crore rupees so line maths stays within safe integers. */
export const billingAmount = paise.max(1_000_000_000);

export const password = z.string().min(10).max(200);
