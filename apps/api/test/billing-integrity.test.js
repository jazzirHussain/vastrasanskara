import { test, expect, vi, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { expenseHelpers } from './helpers/expenses.js';
import { AuditLog } from '../src/core/audit/model.js';
import { Allocation, BillingDocument, IntegrityRun, Invoice } from '../src/modules/billing/model.js';
import { renderPendingPdfs, runPendingIntegrityChecks } from '../src/modules/billing/service.js';
import { getJobDefinition } from '../src/core/jobs/registry.js';
import '../src/jobs.js';

useTestDb();
const app = buildTestApp();
const storage = app.locals.storage;
const { world, draftFor, issue, pay } = billingHelpers(app);

afterEach(() => vi.restoreAllMocks());

let keys = 0;
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const start = (who) => who.agent.post('/v1/admin/audit/verify').send({});
const latest = (who) => who.agent.get('/v1/admin/audit/verify');
/** Starts a check, lets the worker run it and answers its result as { status: 200, body }. */
const verify = async (who) => {
  const started = await start(who);
  if (started.status !== 202) return started;
  await runPendingIntegrityChecks({ storage });
  const r = await latest(who);
  ok(r, 200);
  expect(r.body.run).toMatchObject({ id: started.body.run.id, status: 'done' });
  return { status: 200, body: r.body.run.result };
};

/** Bills, a receipt, a credit note and a refund, PDFs rendered. */
async function trail() {
  const w = await world();
  const { ops, admin, customerId, takeOrder } = w;
  const first = (await issue(ops, await draftFor(await takeOrder({ prices: [450000] })))).body.invoice;
  const second = (await issue(ops, await draftFor(await takeOrder({ prices: [100000] })))).body.invoice;
  ok(await pay(ops, { customerId, invoiceId: first.id, amount: 200000, mode: 'cash' }));
  ok(await admin.agent.post(`/v1/billing/invoices/${second.id}/credit-notes`).set('Idempotency-Key', `c${++keys}`)
    .send({ reason: 'Price reduced', lines: [{ key: second.lines[0].key, taxable: 10000 }] }));
  // An advance on an order not yet billed (money with no order would pay the open bills first).
  const third = await takeOrder({ prices: [80000] });
  ok(await pay(ops, { customerId, orderId: third.id, amount: 50000, mode: 'cash' }));
  ok(await admin.agent.post('/v1/billing/refunds').set('Idempotency-Key', `r${++keys}`)
    .send({ customerId, orderId: third.id, amount: 10000, mode: 'cash', reason: 'Order cancelled' }));
  await renderPendingPdfs({ storage });
  return { ...w, first, second };
}

test('a clean trail checks out', async () => {
  const { admin } = await trail();
  const r = await verify(admin);
  ok(r, 200);
  expect(r.body).toMatchObject({
    ok: true,
    checkedAt: expect.any(String),
    audit: { ok: true, checked: expect.any(Number), firstBreak: null },
    pdfs: { checked: 6, pending: 0, problems: [] },
    balances: { checked: 2, problems: [] },
  });
  expect(r.body.audit.checked).toBeGreaterThan(5);
  const entry = await AuditLog.findOne({ entityType: 'audit', action: 'verify' }).lean();
  expect(entry).toBeTruthy();
  // The check records itself, and the chain is still whole afterwards.
  expect((await verify(admin)).body.audit.ok).toBe(true);
});

test('a changed audit entry is found', async () => {
  const { admin } = await trail();
  await mongoose.connection.collection('auditLog').updateOne({ seq: 2 }, { $set: { action: 'tampered' } });
  const r = await verify(admin);
  ok(r, 200);
  expect(r.body.ok).toBe(false);
  expect(r.body.audit).toMatchObject({ ok: false, firstBreak: { seq: 2, reason: 'hash_mismatch' } });
});

test('a replaced PDF is found', async () => {
  const { admin, first, second } = await trail();
  const a = await BillingDocument.findById(first.id).lean();
  const b = await BillingDocument.findById(second.id).lean();
  await storage.putObject({ key: a.pdf.key, body: Buffer.from('%PDF-1.4 forged'), contentType: 'application/pdf' });
  const root = path.join(app.locals.config.storage.localDir, 'filesBucket');
  await rm(path.join(root, b.pdf.key));
  await rm(path.join(root, `${b.pdf.key}.meta.json`));

  const r = await verify(admin);
  ok(r, 200);
  expect(r.body.ok).toBe(false);
  expect(r.body.pdfs.problems).toEqual(expect.arrayContaining([
    { id: first.id, type: 'invoice', number: first.number, reason: 'hash_mismatch' },
    { id: second.id, type: 'invoice', number: second.number, reason: 'missing' },
  ]));
  expect(r.body.pdfs.problems).toHaveLength(2);
  expect(r.body.audit.ok).toBe(true);
});

test('a balance that disagrees with its payments is found', async () => {
  const { admin, first } = await trail();
  const stored = await Invoice.findById(first.id).lean();
  await Invoice.collection.updateOne({ _id: stored._id }, { $set: { 'settlement.balance': 1 } });
  const r = await verify(admin);
  ok(r, 200);
  expect(r.body.ok).toBe(false);
  expect(r.body.balances.problems).toEqual([
    { id: first.id, number: first.number, fields: ['balance'], stored: { ...stored.settlement, balance: 1 }, expected: stored.settlement },
  ]);
});

test('a changed payment total is found even when the balance still adds up', async () => {
  const { admin, first } = await trail();
  const stored = await Invoice.findById(first.id).lean();
  await Invoice.collection.updateOne({ _id: stored._id }, { $set: { 'settlement.paid': stored.settlement.paid + 5 } });
  const r = await verify(admin);
  expect(r.body.ok).toBe(false);
  expect(r.body.balances.problems).toEqual([
    {
      id: first.id, number: first.number, fields: ['paid'],
      stored: { ...stored.settlement, paid: stored.settlement.paid + 5 }, expected: stored.settlement,
    },
  ]);
});

test('pending PDFs are counted, not failed', async () => {
  const { ops, admin, takeOrder } = await world();
  ok(await issue(ops, await draftFor(await takeOrder())));
  const r = await verify(admin);
  expect(r.body).toMatchObject({ ok: true, pdfs: { checked: 0, pending: 1, problems: [] } });
});

test('only admins can check records', async () => {
  const { ops, d1 } = await world();
  for (const who of [ops, d1]) {
    expect((await start(who)).status).toBe(403);
    expect((await latest(who)).status).toBe(403);
  }
});

test('a check runs in the background; starting again while it runs answers the same check', async () => {
  const { admin } = await trail();
  ok(await latest(admin), 200);
  expect((await latest(admin)).body).toEqual({ run: null });

  const first = await start(admin);
  ok(first, 202);
  expect(first.body.run).toEqual({ id: expect.any(String), status: 'running', startedAt: expect.any(String), finishedAt: null, result: null });
  const again = await start(admin);
  ok(again, 202);
  expect(again.body.run.id).toBe(first.body.run.id);
  expect((await latest(admin)).body.run).toEqual(first.body.run);
  expect(await AuditLog.countDocuments({ entityType: 'audit', action: 'verify' })).toBe(0);

  // The worker's billing-integrity job runs it.
  await getJobDefinition('billing-integrity').handler({ storage });
  const done = (await latest(admin)).body.run;
  expect(done).toMatchObject({ id: first.body.run.id, status: 'done', finishedAt: expect.any(String), result: { ok: true } });
  // The audit entry is written once the check has finished.
  const entry = await AuditLog.findOne({ entityType: 'audit', action: 'verify' }).lean();
  expect(entry.userId).toBeTruthy();
  expect(await IntegrityRun.countDocuments()).toBe(1);

  // A finished check does not block a new one.
  const next = await start(admin);
  ok(next, 202);
  expect(next.body.run.id).not.toBe(first.body.run.id);
});

test('a check that cannot finish is marked failed', async () => {
  const { admin } = await trail();
  ok(await start(admin), 202);
  const broken = { getObject: async () => { throw new Error('storage down'); } };
  await runPendingIntegrityChecks({ storage: broken });
  const run = (await latest(admin)).body.run;
  expect(run).toMatchObject({ status: 'failed', finishedAt: expect.any(String), result: null });
  expect(JSON.stringify(run)).not.toContain('storage down');
});

test('a bill that changes during the check is read again before it is reported', async () => {
  const { admin } = await trail();
  // The first read of the first bill's payments misses them, as if a payment were committing.
  const real = Allocation.find.bind(Allocation);
  vi.spyOn(Allocation, 'find').mockImplementationOnce(() => ({ lean: async () => [] })).mockImplementation(real);
  const r = await verify(admin);
  expect(r.body).toMatchObject({ ok: true, balances: { checked: 2, problems: [] } });
});

test('a changed history entry of a bill names the bill by its number', async () => {
  const { admin, first } = await trail();
  const entry = await AuditLog.findOne({ entityType: 'invoice' }).sort({ seq: 1 }).lean();
  expect(entry.entityId).toBe(first.id);
  await mongoose.connection.collection('auditLog').updateOne({ _id: entry._id }, { $set: { action: 'tampered' } });
  const r = await verify(admin);
  expect(r.body.audit.firstBreak).toEqual({ seq: entry.seq, reason: 'hash_mismatch', entityType: 'invoice', entityId: first.id, number: first.number });
});

test('check records finds a changed bill photo', async () => {
  const { world: expenseWorld, upload, add } = expenseHelpers(app);
  const { admin, ops } = await expenseWorld();
  const keys = [await upload(ops), await upload(ops)];
  const first = (await add(ops, { attachments: [{ key: keys[0], name: 'a.jpg' }] })).body.expense;
  const second = (await add(ops, { attachments: [{ key: keys[1], name: 'b.jpg' }] })).body.expense;
  let r = await verify(admin);
  expect(r.body.photos).toEqual({ checked: 2, problems: [] });
  expect(r.body.ok).toBe(true);

  await storage.putObject({ key: keys[0], body: Buffer.from('xyz'), contentType: 'image/jpeg' });
  const root = path.join(app.locals.config.storage.localDir, 'filesBucket');
  await rm(path.join(root, keys[1]));
  await rm(path.join(root, `${keys[1]}.meta.json`));
  r = await verify(admin);
  expect(r.body.ok).toBe(false);
  expect(r.body.photos.problems).toEqual(expect.arrayContaining([
    { kind: 'expense_photo', id: first.id, number: first.number, label: `Bill photo of ${first.number}`, reason: 'hash_mismatch' },
    { kind: 'expense_photo', id: second.id, number: second.number, label: `Bill photo of ${second.number}`, reason: 'missing' },
  ]));
});
