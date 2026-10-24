import { z } from 'zod';
import { garmentTypeKey } from './settings.js';

/** POST /v1/customers/:id/measurements — a new set every time. */
export const measurementSchema = z.strictObject({
  garmentType: garmentTypeKey,
  values: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(40),
        value: z.number().positive().max(500),
        unit: z.enum(['in', 'cm']),
      }),
    )
    .min(1)
    .max(40)
    .refine(
      (values) => new Set(values.map((v) => v.name.toLowerCase())).size === values.length,
      'Each measurement can appear once',
    ),
  notes: z.string().trim().max(500).default(''),
});
