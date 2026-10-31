import { test, expect } from 'vitest';
import { DEFAULT_SETTINGS, settingsSchema, settingsPatchSchema } from '../src/schemas/settings.js';
import { branchPatchSchema } from '../src/schemas/branch.js';
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

test('default settings carry the expense categories', () => {
  expect(DEFAULT_SETTINGS.expenseCategories).toHaveLength(15);
  expect(DEFAULT_SETTINGS.expenseCategories.map((c) => c.key)).toContain('material_purchase');
  expect(settingsPatchSchema.safeParse({ expenseCategories: DEFAULT_SETTINGS.expenseCategories }).success).toBe(true);
});
test('category keys and labels are unique and one stays active', () => {
  const cats = (...rows) => ({ expenseCategories: rows.map(([key, label, active = true]) => ({ key, label, active })) });
  const ok = (v) => settingsPatchSchema.safeParse(v).success;
  expect(ok(cats(['a', 'Alpha'], ['b', 'Beta', false]))).toBe(true);
  expect(ok(cats(['a', 'Alpha'], ['a', 'Beta']))).toBe(false);
  expect(ok(cats(['a', 'Alpha'], ['b', ' alpha ']))).toBe(false);
  expect(ok(cats(['a', 'Alpha', false]))).toBe(false);
  expect(ok(cats(['A b', 'Alpha']))).toBe(false);
  expect(ok({ expenseCategories: [] })).toBe(false);
});
