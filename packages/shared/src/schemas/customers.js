import { z } from 'zod';
import { email, gstin, phone, stateCode } from './common.js';

export const CUSTOMER_TYPES = Object.freeze(['individual', 'business', 'film_production']);
/** Where a customer (or an enquiry) heard of the house. */
export const CUSTOMER_SOURCES = Object.freeze(['instagram', 'referral', 'walk_in', 'website', 'film_industry', 'other']);
const SOURCES = CUSTOMER_SOURCES;
const CHANNELS = ['email', 'whatsapp', 'sms'];

const consent = z.strictObject({ email: z.boolean(), whatsapp: z.boolean(), sms: z.boolean() });
const billingAddress = z.strictObject({
  line1: z.string().trim().max(200),
  line2: z.string().trim().max(200),
  city: z.string().trim().max(100),
  pincode: z.string().trim().regex(/^(\d{6})?$/, 'Invalid pincode'),
});

// Fields without defaults, shared by create and patch (a patch must never fill in defaults).
const fields = {
  name: z.string().trim().min(1).max(100),
  phone,
  email: email.nullable(),
  type: z.enum(CUSTOMER_TYPES),
  gstin: gstin.nullable(),
  stateCode,
  billingAddress,
  source: z.enum(SOURCES),
  consent,
  consentNote: z.string().trim().max(300),
  preferredChannel: z.enum(CHANNELS).nullable(),
};

/** True when the customer agreed to messages on any channel. */
export const hasAnyConsent = (c) => Boolean(c && (c.email || c.whatsapp || c.sms));

// Consent to any channel needs a note of how it was given; a GSTIN fixes the state code.
export function checkCustomerRules(value, ctx) {
  if (hasAnyConsent(value.consent) && !value.consentNote) {
    ctx.addIssue({ code: 'custom', path: ['consentNote'], message: 'Say how the customer gave consent' });
  }
  if (value.gstin && value.stateCode && value.gstin.slice(0, 2) !== value.stateCode) {
    ctx.addIssue({ code: 'custom', path: ['stateCode'], message: 'State code must match the GSTIN' });
  }
}

/** POST /v1/customers. `stateCode` is optional: the service uses the branch's state. */
export const customerSchema = z
  .strictObject({
    ...fields,
    email: fields.email.default(null),
    type: fields.type.default('individual'),
    gstin: fields.gstin.default(null),
    stateCode: stateCode.optional(),
    billingAddress: billingAddress.default({ line1: '', line2: '', city: '', pincode: '' }),
    source: fields.source.default('walk_in'),
    consent: consent.default({ email: false, whatsapp: false, sms: false }),
    consentNote: fields.consentNote.default(''),
    preferredChannel: fields.preferredChannel.default(null),
  })
  .superRefine(checkCustomerRules);

/** PATCH /v1/customers/:id: any subset; the service re-checks the merged customer. */
export const customerPatchSchema = z
  .strictObject(fields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
  .superRefine(checkCustomerRules);
