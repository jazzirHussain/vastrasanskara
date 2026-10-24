import { z } from 'zod';
import { STAGE_KEYS } from '../stages.js';
import { email, gstin, hhmm, paise, phone, stateCode } from './common.js';

const stageKey = z.enum(STAGE_KEYS);
const stageDays = z.partialRecord(stageKey, z.int().min(0).max(60));
const appointmentMinutes = z.int().min(5).max(480);
const quietWindow = z.strictObject({ start: hhmm, end: hhmm }).nullable();
const garmentType = z.string().regex(/^[a-z0-9_]{1,50}$/, 'Use lowercase letters, digits and _');

export const settingsSchema = z.strictObject({
  advancePercent: z.int().min(0).max(100),
  billDueDays: z.int().min(0).max(365),
  cancellationRefundSchedule: z
    .array(z.strictObject({ uptoStage: stageKey, refundPercent: z.int().min(0).max(100) }))
    .max(20),
  uncollectedFlagDays: z.int().min(1).max(365),
  stageDurations: z.strictObject({
    default: stageDays,
    byGarmentType: z.record(garmentType, stageDays),
  }),
  appointmentDurations: z.strictObject({
    consultation: appointmentMinutes,
    measurement: appointmentMinutes,
    fitting: appointmentMinutes,
    pickup: appointmentMinutes,
  }),
  quietHours: z.strictObject({
    email: quietWindow,
    whatsapp: quietWindow,
    sms: quietWindow,
    in_app: quietWindow,
  }),
  b2clThreshold: paise,
  // '<docType>:<fyCode>' → first number of that series, e.g. 'invoice:2627' → 101
  numberSeries: z.record(z.string().regex(/^[a-z_]+:\d{4}$/), z.int().positive()),
  dailyJobTime: hhmm,
  closingTime: hhmm,
});

/** A PUT /v1/settings body: any subset of top-level settings (each replaced whole). */
export const settingsPatchSchema = settingsSchema.partial();

const NIGHT = { start: '21:00', end: '09:00' };

export const DEFAULT_SETTINGS = Object.freeze({
  advancePercent: 100,
  billDueDays: 0,
  cancellationRefundSchedule: [],
  uncollectedFlagDays: 7,
  stageDurations: {
    default: {
      materials_ready: 2,
      pattern_making: 1,
      handwork: 7,
      quality_check: 1,
      masters_cutting: 1,
      tailors: 4,
      trials_fittings: 2,
      finishing: 2,
      branding: 1,
      final_qc: 1,
      packaging: 1,
    },
    byGarmentType: {},
  },
  appointmentDurations: { consultation: 60, measurement: 30, fitting: 45, pickup: 15 },
  quietHours: { email: NIGHT, whatsapp: NIGHT, sms: NIGHT, in_app: null },
  b2clThreshold: 10000000,
  numberSeries: {},
  dailyJobTime: '08:00',
  closingTime: '20:00',
});

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
