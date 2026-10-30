import { test, expect } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { AuditLog } from '../src/core/audit/model.js';
import { BillingDocument, Invoice } from '../src/modules/billing/model.js';
import { renderPendingPdfs } from '../src/modules/billing/service.js';

useTestDb();
const app = buildTestApp();
const storage = app.locals.storage;
const { world, draftFor, issue, pay } = billingHelpers(app);

let keys = 0;
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const verify = (who) => who.agent.post('/v1/admin/audit/verify').send({});

/** Bills, a receipt, a credit note and a refund, PDFs rendered. */
async function trail() {
  const w = await world();
  const { ops, admin, customerId, takeOrder } = w;
  const first = (await issue(ops, await draftFor(await takeOrder({ prices: [450000] })))).body.invoice;
  const second = (await issue(ops, await draftFor(await takeOrder({ prices: [100000] })))).body.invoice;
  ok(await pay(ops, { customerId, invoiceId: first.id, amount: 200000, mode: 'cash' }));
  ok(await admin.agent.post(`/v1/billing/invoices/${second.id}/credit-notes`).set('Idempotency-Key', `c${++keys}`)
    .send({ reason: 'Price reduced', lines: [{ key: second.lines[0].key, taxable: 10000 }] }));
  ok(await pay(ops, { customerId, amount: 50000, mode: 'cash' }));
  ok(await admin.agent.post('/v1/billing/refunds').set('Idempotency-Key', `r${++keys}`)
    .send({ customerId, amount: 10000, mode: 'cash', reason: 'Order cancelled' }));
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
  for (const who of [ops, d1]) expect((await verify(who)).status).toBe(403);
});
