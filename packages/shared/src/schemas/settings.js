import { z } from 'zod';
import { STAGE_KEYS } from '../stages.js';
import { hhmm, paise } from './common.js';

const stageKey = z.enum(STAGE_KEYS);
const stageDays = z.partialRecord(stageKey, z.int().min(0).max(60));
const appointmentMinutes = z.int().min(5).max(480);
const quietWindow = z.strictObject({ start: hhmm, end: hhmm }).nullable();
export const garmentTypeKey = z.string().regex(/^[a-z0-9_]{1,50}$/, 'Use lowercase letters, digits and _');
const garmentType = garmentTypeKey;
// The kinds of garment the house makes, each with the measurements taken for it.
const garmentTypes = z
  .array(
    z.strictObject({
      key: garmentTypeKey,
      label: z.string().trim().min(1).max(60),
      measurementFields: z.array(z.string().trim().min(1).max(40)).max(40),
    }),
  )
  .max(100)
  .refine((types) => new Set(types.map((t) => t.key)).size === types.length, 'Garment type keys must be unique');

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
  garmentTypes,
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
  garmentTypes: [
    {
      key: 'blouse',
      label: 'Blouse',
      measurementFields: [
        'Bust',
        'Under bust',
        'Waist',
        'Shoulder',
        'Armhole',
        'Sleeve length',
        'Sleeve round',
        'Front neck depth',
        'Back neck depth',
        'Blouse length',
      ],
    },
    { key: 'lehenga', label: 'Lehenga', measurementFields: ['Waist', 'Hip', 'Length'] },
    { key: 'kurta', label: 'Kurta', measurementFields: ['Chest', 'Waist', 'Hip', 'Shoulder', 'Sleeve length', 'Neck', 'Length'] },
    { key: 'gown', label: 'Gown', measurementFields: ['Bust', 'Waist', 'Hip', 'Shoulder', 'Sleeve length', 'Length'] },
    { key: 'sherwani', label: 'Sherwani', measurementFields: ['Chest', 'Waist', 'Hip', 'Shoulder', 'Sleeve length', 'Neck', 'Length'] },
    { key: 'pants', label: 'Pants', measurementFields: ['Waist', 'Hip', 'Thigh', 'Knee', 'Ankle', 'Length'] },
    { key: 'other', label: 'Other', measurementFields: [] },
  ],
});
