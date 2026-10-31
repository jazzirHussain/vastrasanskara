import { z } from 'zod';
import { objectId, paise, billingAmount, ymd } from './common.js';
import { PAYMENT_MODES } from './billing.js';
import { expenseSchema, checkExpenseRules } from './expenses.js';

const text = (max) => z.string().trim().max(max);

/** A quantity in whole thousandths of the usage unit (2.5 m = 2500). */
export const qty = z.int().min(1).max(1_000_000_000);
const qtyOrZero = z.int().min(0).max(1_000_000_000);

const itemFields = {
  name: z.string().trim().min(1).max(80),
  brand: text(60),
  category: text(40),
  colour: text(40),
  usageUnit: z.string().trim().min(1).max(20),
  purchaseUnit: z.string().trim().min(1).max(20),
  factor: qty,
  step: qty,
  reorderLevel: qtyOrZero,
  sellingPrice: paise.nullable(),
};

/** POST /v1/stock/items. `opening` is stock already on the shelf, at a cost per usage unit. */
export const stockItemSchema = z.strictObject({
  ...itemFields,
  brand: itemFields.brand.default(''),
  category: itemFields.category.default(''),
  colour: itemFields.colour.default(''),
  step: itemFields.step.default(1000),
  reorderLevel: itemFields.reorderLevel.default(0),
  sellingPrice: itemFields.sellingPrice.default(null),
  opening: z.strictObject({ quantity: qty, unitCost: paise }).nullable().default(null),
});

/** PATCH /v1/stock/items/:id (with `version`): any subset. */
export const stockItemPatchSchema = z
  .strictObject({ ...itemFields, active: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/** POST /v1/stock/items/:id/count: what is on the shelf now, and what the screen showed before. */
export const stockCountSchema = z.strictObject({
  counted: qtyOrZero,
  expectedOnHand: qtyOrZero,
  unitCost: paise.optional(),
  reason: z.string().trim().min(1).max(300),
});

const uniqueBy = (key) => (rows) => new Set(rows.map((r) => r[key].toLowerCase())).size === rows.length;

/** Materials planned for a garment: each item once. */
export const materialLinesSchema = z
  .array(z.strictObject({ stockItemId: objectId, quantity: qty }))
  .max(20)
  .refine(uniqueBy('stockItemId'), 'Each item can be listed once');

/** What the designer says was used, per garment and item (0 = none used). */
export const materialsUsedSchema = z
  .array(z.strictObject({ garmentId: objectId, stockItemId: objectId, quantity: qtyOrZero }))
  .max(200);

/** "Used more" (positive) or "Put back" (negative) after Materials ready. */
export const materialChangeSchema = z.strictObject({
  changes: z
    .array(z.strictObject({
      stockItemId: objectId,
      change: z.int().min(-1_000_000_000).max(1_000_000_000).refine((v) => v !== 0, 'Change cannot be zero'),
    }))
    .min(1)
    .max(20)
    .refine(uniqueBy('stockItemId'), 'Each item can be listed once'),
  note: text(300).default(''),
});

export const purchaseRequestSchema = z.strictObject({
  stockItemId: objectId,
  quantity: qty,
  reason: z.enum(['low_stock', 'manual']),
  note: text(300).default(''),
});

/** Marking a request as ordered. */
export const purchaseOrderSchema = z.strictObject({
  vendorId: objectId.nullable(),
  note: text(300).default(''),
});

const expenseShape = expenseSchema.shape;

/** POST /v1/stock/items/:id/receive (needs an Idempotency-Key): the delivery and its bill in one go. */
export const receiveSchema = z
  .strictObject({
    quantity: qty,
    date: ymd.optional(),
    total: billingAmount.positive(),
    mode: z.enum(PAYMENT_MODES),
    reference: expenseShape.reference,
    payee: expenseShape.payee,
    gst: expenseShape.gst,
    attachments: expenseShape.attachments,
  })
  .superRefine(checkExpenseRules);

export const receiptUndoSchema = z.strictObject({ reason: z.string().trim().min(1).max(300) });

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const cursor = z.string().max(500);
const limit = z.coerce.number().int().min(1).max(100);

export const stockListQuery = z.strictObject({
  q: z.string().trim().max(40).optional(),
  category: z.string().trim().max(40).optional(),
  low: bool.optional(),
  active: bool.optional(),
  cursor: cursor.optional(),
  limit: limit.optional(),
});

export const movementsQuery = z.strictObject({ cursor: cursor.optional(), limit: limit.optional() });

export const requestsQuery = z.strictObject({
  status: z.enum(['requested', 'ordered', 'received', 'cancelled', 'open']).optional(),
  cursor: cursor.optional(),
  limit: limit.optional(),
});

export const pickerQuery = z.strictObject({ q: z.string().trim().max(40).optional() });
