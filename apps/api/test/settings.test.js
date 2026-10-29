import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { AuditLog } from '../src/core/audit/model.js';
import { getQuietHours } from '../src/core/notify/catalog.js';
import { withTransaction } from '../src/core/db.js';
import { nextDocumentNumber } from '../src/core/numbering.js';
useTestDb();
const app = buildTestApp();

test('defaults', async () => {
  const { agent } = await loginAs(app, { roles: ['designer'] });
  const r = await agent.get('/v1/settings');
  expect(r.body).toMatchObject({ advancePercent: 100, billDueDays: 0, uncollectedFlagDays: 7, dailyJobTime: '08:00', closingTime: '20:00', b2clThreshold: 10000000 });
  expect(r.body.quietHours.email).toEqual({ start: '21:00', end: '09:00' });
});
test('admin updates with audit; others forbidden; invalid rejected', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  expect((await agent.put('/v1/settings').send({ billDueDays: 5 })).body.billDueDays).toBe(5);
  expect((await AuditLog.findOne({ entityType: 'settings' })).changes).toEqual([{ path: 'billDueDays', before: 0, after: 5 }]);
  expect((await agent.put('/v1/settings').send({ advancePercent: 150 })).status).toBe(400);
  const { agent: ops } = await loginAs(app, { roles: ['operations'] });
  expect((await ops.put('/v1/settings').send({ billDueDays: 1 })).status).toBe(403);
});
test('branch state must match GSTIN', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  expect((await agent.put('/v1/branch').send({ gstin: '29ABCDE1234F1Z5', stateCode: '32' })).body.error.code).toBe('STATE_GSTIN_MISMATCH');
});

test('settings changes persist, keep other values, and feed quiet hours', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  const quietHours = { email: { start: '22:00', end: '08:00' }, whatsapp: null, sms: null, in_app: null };
  await agent.put('/v1/settings').send({ quietHours });
  const r = await agent.get('/v1/settings');
  expect(r.body.quietHours).toEqual(quietHours);
  expect(r.body.advancePercent).toBe(100);
  expect(await getQuietHours(user.branchId)).toEqual(quietHours);
  expect((await agent.put('/v1/settings').send({ colour: 'red' })).status).toBe(400);
});
test('quiet hours fall back to defaults without creating settings', async () => {
  const { user } = await loginAs(app, { roles: ['admin'] });
  expect((await getQuietHours(user.branchId)).email).toEqual({ start: '21:00', end: '09:00' });
});
test('branch read and audited update', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  expect((await agent.get('/v1/branch')).body).toMatchObject({ id: String(user.branchId), name: 'Vastrasanskara', stateCode: '29' });
  const r = await agent.put('/v1/branch').send({ gstin: '29ABCDE1234F1Z5', phone: '98765 43210', prefixes: { invoice: 'VS', creditNote: 'CN', receiptVoucher: 'RV', receipt: 'RCPT', refund: 'RF', expense: 'EXP', order: 'VS/ORD' } });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ gstin: '29ABCDE1234F1Z5', phone: '+919876543210', prefixes: { invoice: 'VS' } });
  const audit = await AuditLog.findOne({ entityType: 'branch' }).lean();
  expect(audit.changes.map((c) => c.path)).toEqual(['gstin', 'phone', 'prefixes.invoice']);
  const { agent: d } = await loginAs(app, { roles: ['designer'] });
  expect((await d.put('/v1/branch').send({ name: 'x' })).status).toBe(403);
});
test('branch logo must be a logo uploaded for this branch', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  const own = `${user.branchId}/branch_logo/2026/7c9e6679-7425-40de-944b-e07fc1f90ae7.png`;
  expect((await agent.put('/v1/branch').send({ logoKey: own })).status).toBe(200);
  const foreign = '000000000000000000000000/branch_logo/2026/7c9e6679-7425-40de-944b-e07fc1f90ae7.png';
  expect((await agent.put('/v1/branch').send({ logoKey: foreign })).status).toBe(400);
});
test('a used number series cannot be restarted', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  expect((await agent.put('/v1/settings').send({ numberSeries: { 'invoice:2627': 101, 'receipt:2627': 5 } })).status).toBe(200);
  await withTransaction((session) => nextDocumentNumber({ branchId: user.branchId, docType: 'invoice', now: new Date('2026-10-30T06:00:00Z'), start: 101 }, session));
  const changed = await agent.put('/v1/settings').send({ numberSeries: { 'invoice:2627': 1, 'receipt:2627': 5 } });
  expect(changed.status).toBe(422);
  expect(changed.body.error).toMatchObject({ code: 'SERIES_IN_USE', details: { key: 'invoice:2627' } });
  const removed = await agent.put('/v1/settings').send({ numberSeries: { 'receipt:2627': 5 } });
  expect(removed.body.error).toMatchObject({ code: 'SERIES_IN_USE', details: { key: 'invoice:2627' } });
  // Unused series and next year's start can still change; the used one may stay as it is.
  const ok = await agent.put('/v1/settings').send({ numberSeries: { 'invoice:2627': 101, 'receipt:2627': 7, 'invoice:2728': 1 } });
  expect(ok.status).toBe(200);
  expect(ok.body.numberSeries).toEqual({ 'invoice:2627': 101, 'receipt:2627': 7, 'invoice:2728': 1 });
  expect((await agent.put('/v1/settings').send({ billDueDays: 3 })).status).toBe(200);
});
