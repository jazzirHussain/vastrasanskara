import { z } from 'zod';
import { objectId, paise, ymd } from './common.js';
import { STAGE_KEYS } from '../stages.js';
import { garmentTypeKey } from './settings.js';
import { materialLinesSchema } from './stock.js';

export { ymd };

/** One garment line of a new order; `quantity` > 1 makes a batch of identical garments. */
export const garmentInputSchema = z.strictObject({
  type: garmentTypeKey,
  description: z.string().trim().min(1).max(500),
  fabric: z.string().trim().max(300).default(''),
  designNotes: z.string().trim().max(2000).default(''),
  agreedPrice: paise,
  quantity: z.int().min(1).max(200).default(1),
  dueDate: ymd.nullable().default(null),
  referenceKeys: z.array(z.string().min(1).max(300)).max(10).default([]),
  measurementId: objectId.nullable().default(null),
  materials: materialLinesSchema.default([]),
});

/** POST /v1/orders. */
export const orderCreateSchema = z.strictObject({
  customerId: objectId,
  designerId: objectId,
  priority: z.enum(['normal', 'rush']).default('normal'),
  expectedBudget: paise.nullable().default(null),
  pickupDate: ymd,
  occasionDate: ymd.nullable().default(null),
  notes: z.string().trim().max(2000).default(''),
  garments: z.array(garmentInputSchema).min(1).max(50),
});

/** PATCH /v1/orders/:id (with `version`): any subset of these. */
export const orderPatchSchema = z
  .strictObject({
    designerId: objectId,
    priority: z.enum(['normal', 'rush']),
    expectedBudget: paise.nullable(),
    notes: z.string().trim().max(2000),
    occasionDate: ymd.nullable(),
    pickupDate: ymd,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/** POST /v1/orders/:id/hold and /cancel (with `version`). */
export const orderReasonSchema = z.strictObject({ reason: z.string().trim().min(1).max(300) });

/** POST /v1/orders/:id/resume (with `version`). */
export const orderResumeSchema = z.strictObject({});

/** PATCH /v1/garments/:id (with `version`). `dueDate: null` makes the garment follow the pickup date. */
export const garmentPatchSchema = z
  .strictObject({
    description: z.string().trim().min(1).max(500),
    fabric: z.string().trim().max(300),
    designNotes: z.string().trim().max(2000),
    agreedPrice: paise,
    dueDate: ymd.nullable(),
    referenceKeys: z.array(z.string().min(1).max(300)).max(10),
    measurementId: objectId.nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/** PUT /v1/garments/:id/plan (with `version`). */
export const garmentPlanSchema = z.strictObject({
  changes: z
    .array(z.strictObject({ stage: z.enum(STAGE_KEYS.filter((s) => s !== 'order_taken' && s !== 'picked_up')), plannedDate: ymd }))
    .min(1)
    .max(13)
    .refine((changes) => new Set(changes.map((c) => c.stage)).size === changes.length, 'Each stage once'),
});

/** POST /v1/orders/:id/garments. */
export const addGarmentsSchema = z.strictObject({ garments: z.array(garmentInputSchema).min(1).max(50) });
