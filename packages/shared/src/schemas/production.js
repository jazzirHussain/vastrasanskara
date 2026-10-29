import { z } from 'zod';
import { objectId, paise } from './common.js';
import { ymd } from './orders.js';
import { ACTIONS } from '../production.js';
import { STAGE_KEYS } from '../stages.js';

const stageKey = z.enum(STAGE_KEYS);
const CHARGEABLE = new Set(['qc_fail', 'rework', 'alteration']);
const ONE_GARMENT = new Set(['rejected', 'alteration']);

const REQUIRED = [
  ['reason', ['skip', 'rejected']],
  ['reworkStage', ['qc_fail', 'rework']],
  ['vendorId', ['sent_to_vendor']],
  ['dueBackDate', ['sent_to_vendor']],
  ['resolution', ['rejected']],
  ['readyBy', ['alteration']],
];

/**
 * POST /v1/production/actions: one stage action on one or more garments (each at its version).
 * `stage` is the stage acted on, so a garment that has moved on is refused.
 */
export const stageActionSchema = z
  .strictObject({
    action: z.enum(ACTIONS),
    stage: stageKey,
    garments: z
      .array(z.strictObject({ id: objectId, version: z.int().min(0) }))
      .min(1)
      .max(50)
      .refine((garments) => new Set(garments.map((g) => g.id.toLowerCase())).size === garments.length, 'Each garment once'),
    workerIds: z.array(objectId).max(10).default([]),
    remarks: z.string().trim().max(1000).default(''),
    photoKeys: z.array(z.string().min(1).max(300)).max(10).default([]),
    reason: z.string().trim().min(1).max(300).optional(),
    reworkStage: stageKey.optional(),
    vendorId: objectId.optional(),
    dueBackDate: ymd.optional(),
    resolution: z.enum(['refund', 'remake', 'write_off']).optional(),
    readyBy: ymd.optional(),
    chargeable: z.boolean().default(false),
    chargeAmount: paise.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    for (const [field, actions] of REQUIRED) {
      if (actions.includes(value.action) && value[field] === undefined) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'Required' });
      }
    }
    if (value.readyBy !== undefined && value.action !== 'alteration') {
      ctx.addIssue({ code: 'custom', path: ['readyBy'], message: 'Only an alteration has a ready-by date' });
    }
    if (!CHARGEABLE.has(value.action) && (value.chargeable || value.chargeAmount !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['chargeable'], message: 'Only rework, QC failures and alterations can be charged' });
    }
    if (ONE_GARMENT.has(value.action) && value.garments.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['garments'], message: 'Choose one garment' });
    }
  });
