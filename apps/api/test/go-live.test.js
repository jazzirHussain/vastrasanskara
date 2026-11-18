import { test, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { financialYear, istDate } from '@vs/shared/fy.js';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { clock } from '../src/clock.js';
import { AuditLog } from '../src/core/audit/model.js';
import { runBackup } from '../src/core/backup/backup.js';
import { createFileEmailAdapter } from '../src/core/notify/adapters/emailFile.js';
import { registerAdapter, resetAdapters } from '../src/core/notify/adapters/registry.js';

useTestDb();
const app = buildTestApp();
const { world, draftFor, issue } = billingHelpers(app);
const fy = () => financialYear(clock.now()).code;
const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const checklist = (who) => who.agent.get('/v1/go-live');
const check = (body, key) => body.checks.find((c) => c.key === key);
const series = (overrides = {}) => ({ invoice: 0, credit_note: 0, receipt_voucher: 0, refund: 0, receipt: 0, ...overrides });

afterEach(() => resetAdapters());

test('a new branch has everything still to do', async () => {
  const admin = await loginAs(app, { roles: ['admin'] });
  const r = await checklist(admin);
  ok(r);
  expect(r.body.checks.map((c) => c.key)).toEqual(['business', 'numbers', 'price_list', 'staff', 'imports', 'email', 'backup', 'records']);
  expect(r.body).toMatchObject({ done: 0, total: 8, liveSince: null });
  expect(r.body.checks.every((c) => c.status === 'todo')).toBe(true);
  expect(check(r.body, 'business')).toMatchObject({ link: '/settings' });
  expect(check(r.body, 'business').detail).toContain('GSTIN');
  expect(check(r.body, 'backup').detail).toBe('The first backup runs within 6 hours of going online');
});

test('bill numbers continue from the old book', async () => {
  const w = await world();
  const r = await w.admin.agent.post('/v1/go-live/numbers').send({ series: series({ invoice: 123 }) });
  ok(r);
  expect(check(r.body, 'numbers')).toMatchObject({ status: 'done', detail: `Next bill: INV/${fy()}/0124` });
  const settings = (await w.admin.agent.get('/v1/settings')).body;
  expect(settings.numberSeries).toMatchObject({ [`invoice:${fy()}`]: 124, [`credit_note:${fy()}`]: 1 });
  expect(settings.goLive.numbersConfirmedFy).toBe(fy());

  const bill = await issue(w.ops, await draftFor(await w.takeOrder()));
  ok(bill, 201);
  expect(bill.body.invoice.number).toBe(`INV/${fy()}/0124`);
  const after = await checklist(w.admin);
  expect(check(after.body, 'numbers').detail).toBe(`Next bill: INV/${fy()}/0125`);
  expect(after.body.numbering.types.find((t) => t.type === 'invoice')).toMatchObject({ prefix: 'INV', start: 124, next: 125, used: true });
});

test('numbers cannot be changed once a bill is issued', async () => {
  const w = await world();
  ok(await issue(w.ops, await draftFor(await w.takeOrder())), 201);
  const r = await w.admin.agent.post('/v1/go-live/numbers').send({ series: series({ invoice: 500 }) });
  expect(r.status).toBe(422);
  expect(r.body.error).toMatchObject({ code: 'SERIES_IN_USE' });
  // Values outside 0–999999 are refused by the schema.
  expect((await w.admin.agent.post('/v1/go-live/numbers').send({ series: series({ refund: -1 }) })).status).toBe(400);
  expect((await w.admin.agent.post('/v1/go-live/numbers').send({ series: { invoice: 1 } })).status).toBe(400);
});

test('the test email is sent and remembered', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-mail-'));
  registerAdapter(createFileEmailAdapter({ dir, from: 'shop@example.com' }));
  const admin = await loginAs(app, { roles: ['admin'], email: 'owner@example.com' });
  const r = await admin.agent.post('/v1/go-live/test-email').send({});
  ok(r);
  expect(check(r.body, 'email').status).toBe('done');
  const [file] = readdirSync(dir);
  const eml = readFileSync(path.join(dir, file), 'utf8');
  expect(eml).toContain('owner@example.com');
  expect(eml).toContain('Your boutique system can send email');
});

test('a failing email says what to check', async () => {
  registerAdapter({
    channel: 'email', provider: 'broken', capabilities: { attachments: true, templatesOnly: false },
    send: async () => { throw new Error('Address owner@example.com not verified'); },
  });
  const admin = await loginAs(app, { roles: ['admin'], email: 'owner@example.com' });
  const r = await admin.agent.post('/v1/go-live/test-email').send({});
  expect(r.status).toBe(422);
  expect(r.body.error).toMatchObject({
    code: 'EMAIL_NOT_SENT',
    message: 'The email could not be sent. Check the email set-up step in the go-live guide.',
  });
  expect(JSON.stringify(r.body)).not.toContain('owner@example.com');
  expect(check((await checklist(admin)).body, 'email').status).toBe('todo');
});

test('the backup check uses the last successful backup', async () => {
  const admin = await loginAs(app, { roles: ['admin'] });
  const now = clock.now();
  const put = { putObject: async () => {} };
  await runBackup({ now: new Date(now.getTime() - 8 * 3600_000), dump: () => Readable.from(['x']), storage: put });
  expect(check((await checklist(admin)).body, 'backup').status).toBe('warning');
  await runBackup({ now, dump: () => Readable.from(['x']), storage: put });
  expect(check((await checklist(admin)).body, 'backup').status).toBe('done');
  // A failed backup afterwards does not replace the last good one.
  await expect(runBackup({ now: new Date(now.getTime() + 1000), dump: () => { throw new Error('down'); }, storage: {} })).rejects.toThrow();
  expect(check((await checklist(admin)).body, 'backup').status).toBe('done');
});

test('going live is recorded and audited', async () => {
  const admin = await loginAs(app, { roles: ['admin'] });
  const r = await admin.agent.post('/v1/go-live/live').send({});
  ok(r);
  expect(r.body.liveSince).toBe(istDate(clock.now()));
  const audit = await AuditLog.findOne({ entityType: 'settings', action: 'go_live' }).lean();
  expect(audit).toBeTruthy();
  expect(audit.userId).toBe(String(admin.user._id));
});

test('only admins see the checklist', async () => {
  const admin = await loginAs(app, { roles: ['admin'] });
  ok(await checklist(admin));
  for (const roles of [['operations'], ['designer']]) {
    const who = await loginAs(app, { roles });
    expect((await checklist(who)).status).toBe(403);
    expect((await who.agent.post('/v1/go-live/live').send({})).status).toBe(403);
  }
});
