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
test('stock.view is for admin and operations', () => {
  expect(can(['admin'], 'stock.view')).toBe(true);
  expect(can(['operations'], 'stock.view')).toBe(true);
  expect(can(['designer'], 'stock.view')).toBe(false);
});
test('costing.view is admin only', () => {
  expect(can(['admin'], 'costing.view')).toBe(true);
  expect(can(['operations'], 'costing.view')).toBe(false);
  expect(can(['designer'], 'costing.view')).toBe(false);
});
test('enquiries and booking are for admin and operations', () => {
  for (const p of ['enquiries.write', 'appointments.write']) {
    expect(can(['admin'], p)).toBe(true);
    expect(can(['operations'], p)).toBe(true);
    expect(can(['designer'], p)).toBe(false);
  }
});
test('designers can see their own appointments only', () => {
  for (const role of ['admin', 'operations', 'designer']) expect(can([role], 'appointments.own')).toBe(true);
  expect(can(['designer'], 'appointments.write')).toBe(false);
});
test('designers only have stock.consume.own', () => {
  const mine = permissionsFor(['designer']);
  expect(mine.has('stock.consume.own')).toBe(true);
  expect(mine.has('stock.write')).toBe(false);
  expect(mine.has('stock.view')).toBe(false);
  expect(mine.has('costing.view')).toBe(false);
});
