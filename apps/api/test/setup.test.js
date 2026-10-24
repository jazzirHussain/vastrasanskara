import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { bootstrap } from '../src/modules/setup/service.js';
import { getSettings } from '../src/modules/settings/service.js';
import { Branch } from '../src/modules/branches/model.js';
import { User } from '../src/modules/users/model.js';
import { NotificationRule } from '../src/core/notify/models.js';
import { authenticate } from '../src/modules/auth/service.js';
useTestDb();
const input = { branch: { name: 'Vastrasanskara', legalName: 'Vastrasanskara', gstin: '29ABCDE1234F1Z5', stateCode: '29', address: { line1: 'x', city: 'Bengaluru', pincode: '560001' }, phone: '9876543210', email: 'hello@vs.in' }, admin: { name: 'Owner', email: 'owner@vs.in', password: 'correct-horse-1' } };
test('bootstraps once', async () => {
  const { branchId } = await bootstrap(input);
  expect((await getSettings(branchId)).advancePercent).toBe(100);
  await expect(bootstrap(input)).rejects.toThrow('Already bootstrapped');
});

test('creates a working admin, the branch and notification rules', async () => {
  const { branchId, adminId } = await bootstrap(input);
  expect(await Branch.findById(branchId).lean()).toMatchObject({ phone: '+919876543210', stateCode: '29' });
  expect(await User.findById(adminId).lean()).toMatchObject({ email: 'owner@vs.in', roles: ['admin'], active: true });
  expect(await NotificationRule.countDocuments({ branchId })).toBeGreaterThanOrEqual(4);
  expect(String((await authenticate({ email: 'owner@vs.in', password: 'correct-horse-1' }, {}))._id)).toBe(String(adminId));
});
test('invalid input creates nothing', async () => {
  await expect(bootstrap({ ...input, admin: { ...input.admin, password: 'short' } })).rejects.toThrow();
  await expect(bootstrap({ ...input, branch: { ...input.branch, stateCode: '32' } })).rejects.toThrow(/GSTIN/);
  expect(await Branch.countDocuments()).toBe(0);
  expect(await User.countDocuments()).toBe(0);
});
