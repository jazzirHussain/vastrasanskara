import { test, expect } from 'vitest';
import { DEFAULT_SETTINGS, settingsSchema, settingsPatchSchema, branchPatchSchema } from '../src/schemas/settings.js';
import { createUserSchema, updateUserSchema } from '../src/schemas/users.js';

test('defaults are valid settings', () => {
  expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
});
test('settings reject bad values and unknown keys', () => {
  expect(settingsPatchSchema.safeParse({ advancePercent: 150 }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ colour: 'red' }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ stageDurations: { default: { nope: 1 }, byGarmentType: {} } }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ numberSeries: { 'invoice:2627': 101 } }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ numberSeries: { invoice: 101 } }).success).toBe(false);
  expect(settingsPatchSchema.safeParse({ quietHours: { ...DEFAULT_SETTINGS.quietHours, email: null } }).success).toBe(true);
});
test('branch patch normalises phone and email', () => {
  expect(branchPatchSchema.parse({ phone: '98765 43210', email: ' Hello@VS.in ' })).toEqual({ phone: '+919876543210', email: 'hello@vs.in' });
  expect(branchPatchSchema.safeParse({ address: { line1: '', line2: '', city: '', pincode: '5600' } }).success).toBe(false);
});
test('user schemas', () => {
  expect(createUserSchema.parse({ name: ' Riya ', email: 'Riya@X.com', roles: ['designer'] })).toEqual({ name: 'Riya', email: 'riya@x.com', roles: ['designer'] });
  expect(createUserSchema.safeParse({ name: 'R', email: 'r@x.com', roles: [] }).success).toBe(false);
  expect(updateUserSchema.safeParse({}).success).toBe(false);
  expect(updateUserSchema.safeParse({ active: false }).success).toBe(true);
});
