import { z } from 'zod';
import { gstin, phone, stateCode } from './common.js';

const nonEmpty = (value) => Object.keys(value).length > 0;
const name = z.string().trim().min(1).max(100);

// Fields without defaults, shared by create and patch (a patch must never fill in defaults).
const workerFields = {
  name,
  skill: z.string().trim().max(100),
  phone: phone.nullable(),
  active: z.boolean(),
};

/** POST /v1/workers: tailors, masters and artisans (no login). */
export const workerSchema = z.strictObject({
  ...workerFields,
  skill: workerFields.skill.default(''),
  phone: workerFields.phone.default(null),
  active: workerFields.active.default(true),
});

/** PATCH /v1/workers/:id (with `version`): any subset. */
export const workerPatchSchema = z.strictObject(workerFields).partial().refine(nonEmpty, 'Nothing to update');

const vendorFields = {
  name,
  phone: phone.nullable(),
  gstin: gstin.nullable(),
  stateCode,
  services: z.array(z.string().trim().min(1).max(60)).max(20),
  active: z.boolean(),
};

/** A GSTIN fixes the state code (checked on whatever the value carries). */
export function checkVendorRules(value, ctx) {
  if (value.gstin && value.stateCode && value.gstin.slice(0, 2) !== value.stateCode) {
    ctx.addIssue({ code: 'custom', path: ['stateCode'], message: 'State code must match the GSTIN' });
  }
}

/** POST /v1/vendors. `stateCode` is optional: the service uses the branch's state. */
export const vendorSchema = z
  .strictObject({
    ...vendorFields,
    phone: vendorFields.phone.default(null),
    gstin: vendorFields.gstin.default(null),
    stateCode: stateCode.optional(),
    services: vendorFields.services.default([]),
    active: vendorFields.active.default(true),
  })
  .superRefine(checkVendorRules);

/** PATCH /v1/vendors/:id (with `version`): any subset; the service re-checks the merged vendor. */
export const vendorPatchSchema = z
  .strictObject(vendorFields)
  .partial()
  .refine(nonEmpty, 'Nothing to update')
  .superRefine(checkVendorRules);
