import { test, expect } from 'vitest';
import { can, permissionsFor, PERMISSIONS } from '../src/permissions.js';
test('designer cannot see money', () => {
  expect(can(['designer'], 'money.view')).toBe(false);
  expect(can(['designer'], 'production.update')).toBe(true);
});
test('operations cannot update production', () => { expect(can(['operations'], 'production.update')).toBe(false); });
test('roles union', () => { expect(can(['operations', 'designer'], 'money.view')).toBe(true); });
test('admin has everything', () => {
  const all = permissionsFor(['admin']);
  for (const p of Object.values(PERMISSIONS)) expect(all.has(p)).toBe(true);
});
test('unknown role', () => { expect(() => permissionsFor(['ceo'])).toThrow('Unknown role: ceo'); });
test('workshop.manage for admin and operations only', () => {
  expect(can(['admin'], 'workshop.manage')).toBe(true);
  expect(can(['operations'], 'workshop.manage')).toBe(true);
  expect(can(['designer'], 'workshop.manage')).toBe(false);
});
test('catalog.manage is admin only', () => {
  expect(can(['admin'], 'catalog.manage')).toBe(true);
  expect(can(['operations'], 'catalog.manage')).toBe(false);
  expect(can(['designer'], 'catalog.manage')).toBe(false);
});
test('designers have no billing permission', () => {
  const mine = permissionsFor(['designer']);
  for (const p of ['money.view', 'billing.draft', 'billing.issue', 'billing.cancel', 'payments.record', 'discounts.give', 'periods.lock', 'audit.verify', 'catalog.manage']) {
    expect(mine.has(p)).toBe(false);
  }
});
test('expenses.view is for admin and operations only', () => {
  expect(can(['admin'], 'expenses.view')).toBe(true);
  expect(can(['operations'], 'expenses.view')).toBe(true);
  expect(can(['designer'], 'expenses.view')).toBe(false);
});
test('designers have no expense permission', () => {
  const mine = permissionsFor(['designer']);
  expect(mine.has('expenses.view')).toBe(false);
  expect(mine.has('expenses.write')).toBe(false);
});
