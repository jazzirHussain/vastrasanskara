import { test, expect } from 'vitest';
import { appRole } from '../src/core/dbRole.js';
import { appCollections } from '../src/models.js';

test('the app role can only add and read audit entries', () => {
  const role = appRole(['auditLog', 'orders']);
  expect(role.role).toBe('vsApp');
  expect(role.roles).toEqual([]);
  const audit = role.privileges.find((p) => p.resource.collection === 'auditLog');
  expect([...audit.actions].sort()).toEqual(['createIndex', 'find', 'insert', 'listIndexes']);
  const orders = role.privileges.find((p) => p.resource.collection === 'orders');
  expect(orders.actions).toEqual(expect.arrayContaining(['update', 'remove']));
  const db = role.privileges.find((p) => p.resource.collection === '');
  expect([...db.actions].sort()).toEqual(['createCollection', 'dbStats', 'listCollections']);
});

test('the app role covers every collection the app uses', () => {
  const names = appCollections();
  for (const expected of ['auditLog', 'orders', 'garments', 'billingDocuments', 'counters', 'sessions', 'system', 'agendaJobs', 'migrations', 'idempotencyKeys', 'outbox', 'appointmentLocks']) {
    expect(names).toContain(expected);
  }
  expect(new Set(names).size).toBe(names.length);
  const role = appRole(names);
  expect(role.privileges.filter((p) => p.resource.collection).map((p) => p.resource.collection).sort()).toEqual([...names].sort());
});
