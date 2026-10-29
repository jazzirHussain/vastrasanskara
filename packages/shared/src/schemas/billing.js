import { z } from 'zod';
import { objectId, paise } from './common.js';
import { ymd } from './orders.js';

const text = (max) => z.string().trim().max(max);
const reason = (max) => z.string().trim().min(1).max(max);
const id = objectId;
const optional = (schema) => schema.optional();

export const invoiceLineSchema = z
  .strictObject({
    key: z.string().min(1).max(40),
    itemId: id.nullable(),
    garmentId: id.nullable().default(null),
    stageEventId: id.nullable().default(null),
    source: z.enum(['garment', 'charge', 'rush', 'manual']).default('manual'),
    description: reason(300),
    quantity: z.number().positive().max(9999).multipleOf(0.001),
    rate: paise,
    discount: paise.default(0),
    discountReason: text(200).default(''),
  })
  .refine((l) => l.discount === 0 || l.discountReason !== '', {
    path: ['discountReason'],
    message: 'Say why a discount is given',
  });

export const invoiceDraftSchema = z.strictObject({
  lines: z
    .array(invoiceLineSchema)
    .max(100)
    .refine((lines) => new Set(lines.map((l) => l.key)).size === lines.length, 'Line keys must be unique'),
  invoiceDiscount: z.strictObject({ amount: paise.positive(), reason: reason(200) }).nullable().default(null),
  notes: text(500).default(''),
});

export const fromOrderSchema = z.strictObject({ orderId: id });
export const blankInvoiceSchema = z.strictObject({ customerId: id });
export const issueSchema = z.strictObject({ version: z.int().min(0) });
export const billingReasonSchema = z.strictObject({ reason: reason(300) });
export const remindersSchema = z.strictObject({ paused: z.boolean() });

export const PAYMENT_MODES = ['cash', 'upi', 'card', 'bank_transfer'];
const mode = z.enum(PAYMENT_MODES);

export const paymentSchema = z.strictObject({
  customerId: id,
  orderId: id.nullable().default(null),
  invoiceId: id.nullable().default(null),
  amount: paise.positive(),
  mode,
  reference: text(100).default(''),
  receivedOn: ymd.nullable().default(null),
  note: text(300).default(''),
});

export const refundSchema = z.strictObject({
  customerId: id,
  orderId: id.nullable().default(null),
  amount: paise.positive(),
  mode,
  reference: text(100).default(''),
  reason: reason(300),
});

export const creditNoteSchema = z
  .strictObject({
    reason: reason(300),
    full: z.boolean().default(false),
    lines: z.array(z.strictObject({ key: z.string().min(1).max(40), taxable: paise.positive() })).max(100),
  })
  .refine((v) => v.full !== v.lines.length > 0, {
    message: 'Credit the whole bill or choose some lines, not both',
  });

export const periodLockSchema = z.strictObject({ note: text(300).default('') });
export const periodUnlockSchema = z.strictObject({ reason: reason(300) });
export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const cursor = optional(z.string().max(500));
const limit = optional(z.coerce.number().int().min(1).max(100));

export const invoiceListQuery = z.strictObject({
  status: optional(z.enum(['draft', 'issued', 'cancelled'])),
  customerId: optional(id),
  orderId: optional(id),
  payStatus: optional(z.enum(['unpaid', 'partial', 'paid'])),
  overdue: optional(z.enum(['true', 'false']).transform((v) => v === 'true')),
  from: optional(ymd),
  to: optional(ymd),
  q: optional(z.string().max(30)),
  cursor,
  limit,
});

export const receiptListQuery = z.strictObject({
  customerId: optional(id),
  from: optional(ymd),
  to: optional(ymd),
  mode: optional(mode),
  cursor,
  limit,
});

export const receivablesQuery = z.strictObject({
  bucket: optional(z.enum(['overdue', 'd31_60', 'd61_90', 'd90_plus'])),
  customerId: optional(id),
  cursor,
  limit,
});

export const ledgerQuery = z.strictObject({ cursor, limit });
