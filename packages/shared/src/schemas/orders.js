import { z } from 'zod';
import { objectId, paise } from './common.js';
import { STAGE_KEYS } from '../stages.js';
import { garmentTypeKey } from './settings.js';

/** A calendar date 'YYYY-MM-DD' that exists (no 30 February). */
export const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Not a real date');

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
    .array(z.strictObject({ stage: z.enum(STAGE_KEYS.filter((s) => s !== 'picked_up')), plannedDate: ymd }))
    .min(1)
    .max(13)
    .refine((changes) => new Set(changes.map((c) => c.stage)).size === changes.length, 'Each stage once'),
});

/** POST /v1/orders/:id/garments. */
export const addGarmentsSchema = z.strictObject({ garments: z.array(garmentInputSchema).min(1).max(50) });
