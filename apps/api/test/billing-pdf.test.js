import { test, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { clock } from '../src/clock.js';
import { Branch } from '../src/modules/branches/model.js';
import { Customer } from '../src/modules/customers/model.js';
import { BillingDocument } from '../src/modules/billing/model.js';
import { renderPendingPdfs } from '../src/modules/billing/service.js';
import { documentDefinition } from '../src/modules/billing/pdfLayouts.js';
import { FONT_FILES, renderPdf } from '../src/core/pdf/render.js';
import * as customers from '../src/modules/customers/service.js';

useTestDb();
const app = buildTestApp();
const storage = app.locals.storage;
const { world, draftFor, issue, pay } = billingHelpers(app);
const require = createRequire(import.meta.url);

afterEach(() => vi.restoreAllMocks());

const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const text = (def) => JSON.stringify(def);
const issued = async (ops, order) => {
  const r = await issue(ops, await draftFor(order));
  ok(r);
  return r.body.invoice;
};

test("an issued bill's PDF is rendered from its snapshot and its hash stored", async () => {
  const { ops, takeOrder } = await world();
  const bill = await issued(ops, await takeOrder());
  const result = await renderPendingPdfs({ storage });
  expect(result).toEqual({ rendered: 1, failed: 0 });
  const doc = await BillingDocument.findById(bill.id).lean();
  expect(doc.pdf).toMatchObject({ status: 'ready', size: expect.any(Number), lastError: null });
  const head = await storage.headObject(doc.pdf.key);
  expect(head.sha256).toBe(doc.pdf.sha256);
  expect(head.contentType).toBe('application/pdf');
  const chunks = [];
  for await (const c of await storage.getObject(doc.pdf.key)) chunks.push(c);
  expect(Buffer.concat(chunks).subarray(0, 4).toString()).toBe('%PDF');
  expect(doc.status).toBe('issued');
});

test('the PDF uses only the snapshot', async () => {
  const { ops, takeOrder, customerId } = await world();
  const bill = await issued(ops, await takeOrder());
  const doc = await BillingDocument.findById(bill.id).lean();
  await Customer.updateOne({ _id: customerId }, { name: 'Asha Menon' });
  const spy = vi.spyOn(customers, 'getCustomer');
  expect(text(documentDefinition(doc.snapshot))).toContain('Asha Rao');
  expect(text(documentDefinition(doc.snapshot))).not.toContain('Asha Menon');
  await renderPendingPdfs({ storage });
  expect(spy).not.toHaveBeenCalled();
});

test('the bill layout carries the GST fields', async () => {
  const { ops, takeOrder, customerId } = await world();
  const order = await takeOrder({ prices: [450000] });
  await pay(ops, { customerId, orderId: order.id, amount: 100000, mode: 'cash' });
  const bill = await issued(ops, order);
  const snap = (await BillingDocument.findById(bill.id).lean()).snapshot;
  const t = text(documentDefinition(snap));
  for (const s of ['Tax invoice', 'Original for recipient', '29ABCDE1234F1Z5', 'Karnataka (29)', '6206', 'CGST', 'SGST',
    'Round off', 'Amount in words', 'Rupees', 'Authorised signatory', 'Reverse charge: No', 'Advance received', 'Balance due', 'Tax summary']) {
    expect(t, s).toContain(s);
  }
  expect(t).not.toContain('IGST');
  const inter = { ...snap, placeOfSupply: { ...snap.placeOfSupply, interState: true, stateCode: '27', stateName: 'Maharashtra' } };
  expect(text(documentDefinition(inter))).toContain('IGST');
  expect(text(documentDefinition({ ...snap, advanceApplied: 0 }))).not.toContain('Balance due');
});

test('credit notes, receipts, vouchers and refunds render', async () => {
  const { ops, admin, customerId, takeOrder } = await world();
  const order = await takeOrder({ prices: [450000] });
  ok(await pay(ops, { customerId, orderId: order.id, amount: 100000, mode: 'cash' }));
  const bill = await issued(ops, order);
  ok(await admin.agent.post(`/v1/billing/invoices/${bill.id}/credit-notes`).set('Idempotency-Key', 'cn1').send({ reason: 'Price reduced', full: true, lines: [] }));
  const order2 = await takeOrder({ prices: [200000] });
  ok(await pay(ops, { customerId, orderId: order2.id, amount: 50000, mode: 'upi' }));
  ok(await admin.agent.post('/v1/billing/refunds').set('Idempotency-Key', 'rf1').send({ customerId, orderId: order2.id, amount: 50000, mode: 'cash', reason: 'Order cancelled' }));
  const docs = await BillingDocument.find().lean();
  const types = docs.map((d) => d.type);
  expect(types).toEqual(expect.arrayContaining(['credit_note', 'invoice', 'receipt', 'refund']));
  const result = await renderPendingPdfs({ storage, limit: 50 });
  expect(result).toEqual({ rendered: docs.length, failed: 0 });
  expect(await BillingDocument.countDocuments({ 'pdf.status': 'ready' })).toBe(docs.length);
  const note = (await BillingDocument.findOne({ type: 'credit_note' }).lean()).snapshot;
  expect(text(documentDefinition(note))).toContain(bill.number);
});

test('a failed render is retried later and the bill stays issued', async () => {
  const { ops, takeOrder } = await world();
  const bill = await issued(ops, await takeOrder());
  const now = new Date(clock.now());
  vi.spyOn(storage, 'putObject').mockRejectedValueOnce(new Error('disk full'));
  expect(await renderPendingPdfs({ storage, now })).toEqual({ rendered: 0, failed: 1 });
  let doc = await BillingDocument.findById(bill.id).lean();
  expect(doc.status).toBe('issued');
  expect(doc.pdf).toMatchObject({ status: 'pending', attempts: 1, lastError: 'disk full' });
  expect(doc.pdf.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);
  expect(await renderPendingPdfs({ storage, now })).toEqual({ rendered: 0, failed: 0 });
  const later = new Date(now.getTime() + 61_000);
  expect(await renderPendingPdfs({ storage, now: later })).toEqual({ rendered: 1, failed: 0 });
  doc = await BillingDocument.findById(bill.id).lean();
  expect(doc.pdf.status).toBe('ready');
});

test('two runs at once render each document once', async () => {
  const { ops, takeOrder } = await world();
  await issued(ops, await takeOrder());
  await issued(ops, await takeOrder());
  const put = vi.spyOn(storage, 'putObject');
  const [a, b] = await Promise.all([renderPendingPdfs({ storage }), renderPendingPdfs({ storage })]);
  expect(a.rendered + b.rendered).toBe(2);
  expect(put).toHaveBeenCalledTimes(2);
});

test('the PDF link needs money.view', async () => {
  const { ops, d1, takeOrder } = await world();
  const bill = await issued(ops, await takeOrder());
  expect((await d1.agent.get(`/v1/billing/documents/${bill.id}/pdf`)).status).toBe(403);
  const before = await ops.agent.get(`/v1/billing/documents/${bill.id}/pdf`);
  ok(before, 200);
  expect(before.body).toMatchObject({ status: 'pending', url: null, filename: expect.stringMatching(/^[^/]+\.pdf$/) });
  await renderPendingPdfs({ storage });
  const after = await ops.agent.get(`/v1/billing/documents/${bill.id}/pdf`);
  expect(after.body.status).toBe('ready');
  expect(after.body.url).toMatch(/^http/);
  const key = (await BillingDocument.findById(bill.id).lean()).pdf.key;
  expect((await d1.agent.get('/v1/files/url').query({ key })).status).toBe(404);
  expect((await ops.agent.get('/v1/files/url').query({ key })).status).toBe(200);
});

test('the bundled font has the rupee sign', () => {
  const fontkit = require('fontkit');
  for (const file of Object.values(FONT_FILES)) {
    expect(fontkit.openSync(file).hasGlyphForCodePoint(0x20b9), file).toBe(true);
  }
  expect(readFileSync(new URL('../assets/fonts/OFL.txt', import.meta.url), 'utf8')).toContain('SIL Open Font License');
});

test('a receipt voucher lays out and renders as a PDF', async () => {
  const seller = { legalName: 'Vastra', gstin: '29ABCDE1234F1Z5', stateCode: '29', stateName: 'Karnataka', address: {}, phone: '080 1234', email: 'a@b.in' };
  const snapshot = {
    docType: 'receipt_voucher', title: 'Receipt voucher', number: 'RV/2627/0001', date: '2026-10-30', seller,
    customer: { name: 'Asha Rao', address: {}, stateName: 'Karnataka' },
    placeOfSupply: { stateCode: '29', stateName: 'Karnataka', interState: false },
    lines: [{ hsnSac: '998821', rateBp: 500, gross: 105000, taxable: 100000, cgst: 2500, sgst: 2500, igst: 0 }],
    totals: { gross: 105000, taxable: 100000, cgst: 2500, sgst: 2500, igst: 0, roundOff: 0 },
    amountInWords: 'Rupees One Thousand Fifty Only', against: { orderNo: 'ORD-1' }, receiptNo: 'RC/2627/0001',
  };
  const def = documentDefinition(snapshot);
  expect(text(def)).toContain('RV/2627/0001');
  expect((await renderPdf(def)).subarray(0, 4).toString()).toBe('%PDF');
});

test('a logo that cannot be embedded does not block the bill', async () => {
  const { ops, takeOrder } = await world();
  const logoKey = `${(await Branch.findOne())._id}/branch_logo/2026/00000000-0000-0000-0000-000000000000.webp`;
  await storage.putObject({ key: logoKey, body: Buffer.from('RIFF....WEBPVP8 '), contentType: 'image/webp' });
  await Branch.updateOne({}, { logoKey });
  const bill = await issued(ops, await takeOrder());
  expect(await renderPendingPdfs({ storage })).toEqual({ rendered: 1, failed: 0 });
  expect((await BillingDocument.findById(bill.id).lean()).pdf.status).toBe('ready');
});

test('the printed bill shows readable dates, the shop contact and each line once', async () => {
  const { ops, takeOrder } = await world();
  await Branch.updateOne({}, { phone: '080 2345 6789', email: 'shop@vastra.test', address: { line1: '12 Temple Road', city: 'Mysuru', pincode: '570001' } });
  const bill = await issued(ops, await takeOrder());
  const snap = (await BillingDocument.findById(bill.id).lean()).snapshot;
  const t = text(documentDefinition(snap));
  for (const s of ['080 2345 6789', 'shop@vastra.test', '12 Temple Road', 'Mysuru 570001']) expect(t, s).toContain(s);
  expect(t).toMatch(/Date: \d{1,2} [A-Z][a-z]{2} \d{4}/);
  expect(t).toMatch(/Due date: \d{1,2} [A-Z][a-z]{2} \d{4}/);
  expect(t).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  const lines = documentDefinition({ ...snap, lines: [{ ...snap.lines[0], description: 'Blouse — Blouse (VS/ORD/1)' }] });
  expect(text(lines)).toContain('Blouse (VS/ORD/1)');
  expect(text(lines)).not.toContain('Blouse — Blouse');
});
