import { z } from 'zod';
import { email, gstin, phone, stateCode } from './common.js';

const prefix = z.string().trim().min(1).max(10);

/** PUT /v1/branch body. stateCode/GSTIN consistency is checked on the merged branch. */
export const branchPatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    legalName: z.string().trim().min(1).max(200),
    gstin: gstin.nullable(),
    stateCode,
    address: z.strictObject({
      line1: z.string().trim().max(200).default(''),
      line2: z.string().trim().max(200).default(''),
      city: z.string().trim().max(100).default(''),
      pincode: z.string().regex(/^\d{6}$/, 'Invalid PIN code').or(z.literal('')).default(''),
    }),
    phone: phone.nullable(),
    email: email.nullable(),
    logoKey: z.string().max(300).nullable(),
    prefixes: z.strictObject({
      invoice: prefix,
      creditNote: prefix,
      receiptVoucher: prefix,
      receipt: prefix,
      refund: prefix,
      expense: prefix,
      order: prefix,
    }),
  })
  .partial();
