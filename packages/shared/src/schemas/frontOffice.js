import { z } from 'zod';
import { hhmm, objectId, paise, phone, ymd } from './common.js';
import { garmentTypeKey } from './settings.js';
import { CUSTOMER_SOURCES } from './customers.js';
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES, appointmentWindow } from '../frontOffice.js';

const unique = (values) => new Set(values).size === values.length;
const cursor = z.string().max(500);
const limit = z.coerce.number().int().min(1).max(100);

// ---------- Enquiries ----------

// Fields without defaults, shared by capture and edit (an edit must never fill in defaults).
const enquiryFields = {
  name: z.string().trim().min(1).max(100),
  phone,
  garmentTypes: z.array(garmentTypeKey).max(10).refine(unique, 'Choose each garment type once'),
  interest: z.string().trim().max(300),
  budget: paise.max(1_000_000_000).nullable(),
  source: z.enum(CUSTOMER_SOURCES),
  occasionDate: ymd.nullable(),
  followUpDate: ymd.nullable(),
  note: z.string().trim().max(500),
};

/** POST /v1/enquiries. The form sends the follow-up date; the API does not invent one. */
export const enquirySchema = z.strictObject({
  ...enquiryFields,
  garmentTypes: enquiryFields.garmentTypes.default([]),
  interest: enquiryFields.interest.default(''),
  budget: enquiryFields.budget.default(null),
  source: enquiryFields.source.default('walk_in'),
  occasionDate: enquiryFields.occasionDate.default(null),
  followUpDate: enquiryFields.followUpDate.default(null),
  note: enquiryFields.note.default(''),
});

const { note: _note, ...patchFields } = enquiryFields;

/** PATCH /v1/enquiries/:id (with `version`): any subset, never empty. */
export const enquiryPatchSchema = z
  .strictObject(patchFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/** POST /v1/enquiries/:id/call: what was said and the next call-back date (null = no more calls). */
export const logCallSchema = z.strictObject({
  note: z.string().trim().max(500).default(''),
  followUpDate: ymd.nullable(),
});

export const lostSchema = z.strictObject({ reason: z.string().trim().min(1).max(200) });
export const reopenSchema = z.strictObject({});
export const convertSchema = z.strictObject({ customerId: objectId.nullable().default(null) });

export const ENQUIRY_VIEWS = Object.freeze(['follow_ups', 'open', 'new', 'appointment_booked', 'converted', 'lost', 'all']);

export const enquiryListQuery = z.strictObject({
  view: z.enum(ENQUIRY_VIEWS).default('open'),
  q: z.string().trim().max(50).optional(),
  cursor: cursor.optional(),
  limit: limit.optional(),
});

export const checkPhoneQuery = z.strictObject({ phone });

// ---------- Appointments ----------

const time = hhmm.refine((value) => Number(value.slice(3, 5)) % 15 === 0, 'Choose a time on the quarter hour');
const minutes = z.int().min(5).max(480);
const garmentIds = z.array(objectId).max(20).refine(unique, 'Choose each garment once');

function endsByMidnight({ date, time: start, minutes: length }) {
  if (!date || !start || !length) return true;
  try {
    appointmentWindow({ date, time: start, minutes: length });
    return true;
  } catch {
    return false;
  }
}

/** POST /v1/appointments. `minutes` left out = the type's default length from settings. */
export const appointmentSchema = z
  .strictObject({
    type: z.enum(APPOINTMENT_TYPES),
    designerId: objectId,
    customerId: objectId.nullable().default(null),
    enquiryId: objectId.nullable().default(null),
    date: ymd,
    time,
    minutes: minutes.optional(),
    garmentIds: garmentIds.default([]),
    note: z.string().trim().max(300).default(''),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.customerId) === Boolean(value.enquiryId)) {
      ctx.addIssue({ code: 'custom', path: ['customerId'], message: 'Choose who the appointment is for' });
    }
    if (value.garmentIds.length > 0 && value.type !== 'fitting') {
      ctx.addIssue({ code: 'custom', path: ['garmentIds'], message: 'Garments can be named on fittings only' });
    }
    if (!endsByMidnight(value)) {
      ctx.addIssue({ code: 'custom', path: ['minutes'], message: 'The appointment must end by midnight' });
    }
  });

/** PATCH /v1/appointments/:id (with `version`); the service re-checks the merged window. */
export const appointmentMoveSchema = z
  .strictObject({ designerId: objectId, date: ymd, time, minutes, garmentIds, note: z.string().trim().max(300) })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const appointmentCancelSchema = z.strictObject({ reason: z.string().trim().max(200).default('') });
export const appointmentMarkSchema = z.strictObject({ status: z.enum(['completed', 'no_show']) });

export const appointmentDayQuery = z.strictObject({ date: ymd, designerId: objectId.optional() });

export const appointmentListQuery = z.strictObject({
  from: ymd.optional(),
  to: ymd.optional(),
  designerId: objectId.optional(),
  customerId: objectId.optional(),
  enquiryId: objectId.optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  cursor: cursor.optional(),
  limit: limit.optional(),
});
