import { test, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { addDaysYmd, financialYear } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { today } from './helpers/production.js';
import { clock } from '../src/clock.js';
import * as auditService from '../src/core/audit/service.js';
import { withTransaction } from '../src/core/db.js';
import { AuditLog } from '../src/core/audit/model.js';
import { Branch } from '../src/modules/branches/model.js';
import { Customer } from '../src/modules/customers/model.js';
import { Settings } from '../src/modules/settings/model.js';
import { PeriodLock } from '../src/modules/periods/model.js';
import { Invoice, Receipt, ReceiptVoucher } from '../src/modules/billing/model.js';
import { availableByReceipt } from '../src/modules/billing/allocations.js';

useTestDb();
const app = buildTestApp();
const { world, draftFor, issue, act } = billingHelpers(app);
const { ObjectId } = mongoose.Types;

afterEach(() => vi.restoreAllMocks());

const fy = () => financialYear(clock.now()).code;
const lineBody = (l) => ({
  key: l.key, source: l.source, itemId: l.itemId, garmentId: l.garmentId, stageEventId: l.stageEventId,
  description: l.description, quantity: l.quantity, rate: l.rate, discount: l.discount, discountReason: l.discountReason,
});
const put = (who, invoice, over) =>
  who.agent.put(`/v1/billing/invoices/${invoice.id}`).send({
    version: invoice.version, lines: invoice.lines.map(lineBody), invoiceDiscount: null, notes: '', ...over,
  });
const branchIdOf = async () => (await Branch.findOne())._id;
const counterValue = async (branchId) =>
  (await mongoose.connection.collection('counters').findOne({ _id: `doc:${branchId}:invoice:${fy()}` }))?.value ?? 0;
const setSetting = async (path, value) =>
  Settings.updateOne({ branchId: await branchIdOf() }, { $set: { [`values.${path}`]: value } }, { upsert: true });
const issueAudits = () => AuditLog.find({ entityType: 'invoice', action: 'issue' }).lean();
const changeAt = (entry, path) => entry.changes.find((c) => c.path === path)?.after;

test('issuing numbers, dates and snapshots the bill', async () => {
  const { ops, customerId, takeOrder } = await world();
  await setSetting('billDueDays', 7);
  const order = await takeOrder({ prices: [450000] });
  const draft = await put(ops, await draftFor(order), { notes: 'Thank you' }).then((r) => r.body.invoice);
  const r = await issue(ops, draft);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const inv = r.body.invoice;
  expect(inv).toMatchObject({
    status: 'issued', number: `INV/${fy()}/0001`, date: today(), dueDate: addDaysYmd(today(), 7), notes: 'Thank you',
    customer: { id: customerId, name: 'Asha Rao', gstin: null, stateCode: '29' },
    order: { id: order.id, orderNo: order.orderNo },
    placeOfSupply: { stateCode: '29', interState: false },
    totals: { taxable: 450000, cgst: 27000, sgst: 27000, igst: 0, total: 504000 },
    settlement: { advanceApplied: 0, paid: 0, balance: 504000, payStatus: 'unpaid' },
    overdue: false, monthLocked: false, pdf: { status: 'pending' }, warnings: [],
    amountInWords: 'Rupees Five Thousand Forty Only',
  });
  expect(inv.lines[0]).toMatchObject({
    key: `g-${order.garments[0].id}`, source: 'garment', item: { name: 'Blouse', hsnSac: '6206', supplyType: 'goods', unit: 'PCS' },
    taxable: 450000, gstRateBp: 1200, total: 504000,
  });

  const stored = await Invoice.findById(inv.id).lean();
  expect(stored).toMatchObject({
    fyCode: fy(), month: today().slice(0, 7), interState: false, draft: null,
    garmentIds: [new ObjectId(order.garments[0].id)], stageEventIds: [],
    pdf: { status: 'pending', attempts: 0 },
  });
  expect(stored.pdf.key).toMatch(new RegExp(`^${stored.branchId}/billing_pdf/\\d{4}/[0-9a-f-]+\\.pdf$`));
  expect(stored.issuedBy).toBeTruthy();
  expect(stored.snapshot).toMatchObject({
    docType: 'invoice', title: 'Tax invoice', number: `INV/${fy()}/0001`, date: today(), dueDate: addDaysYmd(today(), 7),
    seller: { gstin: '29ABCDE1234F1Z5', stateCode: '29' },
    customer: { name: 'Asha Rao', stateCode: '29', registered: false },
    placeOfSupply: { stateCode: '29', stateName: 'Karnataka', interState: false },
    reverseCharge: false, invoiceDiscount: null, notes: 'Thank you',
    amountInWords: 'Rupees Five Thousand Forty Only',
    order: { orderNo: order.orderNo },
    taxSummary: [{ hsnSac: '6206', rateBp: 1200, taxable: 450000, cgst: 27000, sgst: 27000, igst: 0 }],
  });
  expect(stored.snapshot.signatory).toBe(stored.snapshot.seller.legalName);
  expect(stored.snapshot.lines[0]).toMatchObject({ item: { hsnSac: '6206' }, source: 'garment' });

  const [audit] = await issueAudits();
  expect(changeAt(audit, 'number')).toBe(`INV/${fy()}/0001`);
  expect(changeAt(audit, 'discounts')).toEqual([]);
  expect(changeAt(audit, 'totals')).toMatchObject({ total: 504000, cgst: 27000 });
});

test('same state splits CGST and SGST; another state gets IGST', async () => {
  const { ops, customerId, takeOrder } = await world();
  const same = (await issue(ops, await draftFor(await takeOrder({ prices: [100000] })))).body.invoice;
  expect(same.totals).toMatchObject({ cgst: 2500, sgst: 2500, igst: 0, total: 105000 });
  await Customer.updateOne({ _id: customerId }, { stateCode: '27' });
  const other = (await issue(ops, await draftFor(await takeOrder({ prices: [100000] })))).body.invoice;
  expect(other.placeOfSupply).toMatchObject({ stateCode: '27', interState: true });
  expect(other.totals).toMatchObject({ cgst: 0, sgst: 0, igst: 5000, total: 105000 });
  expect((await Invoice.findById(other.id).lean()).interState).toBe(true);
});

test("a registered customer's GSTIN and state go on the bill", async () => {
  const { ops, customerId, takeOrder } = await world();
  await Customer.updateOne({ _id: customerId }, { gstin: '27AAAPL1234C1Z5', stateCode: '27' });
  const inv = (await issue(ops, await draftFor(await takeOrder({ prices: [100000] })))).body.invoice;
  expect(inv.customer).toMatchObject({ gstin: '27AAAPL1234C1Z5', stateCode: '27' });
  expect(inv.placeOfSupply).toMatchObject({ stateCode: '27', interState: true });
  const { snapshot } = await Invoice.findById(inv.id).lean();
  expect(snapshot.customer).toMatchObject({ gstin: '27AAAPL1234C1Z5', stateCode: '27', registered: true });
});

test('the slab follows the price per piece after discounts', async () => {
  const { ops, admin, items, takeOrder } = await world();
  const slabs = [{ upToUnitPrice: 250000, rateBp: 500 }, { upToUnitPrice: null, rateBp: 1200 }];
  expect((await admin.agent.patch(`/v1/catalog/items/${items.blouse.id}`).send({ version: 0, gstSlabs: slabs })).status).toBe(200);
  const draft = await draftFor(await takeOrder({ prices: [260000] }));
  expect(draft.lines[0].gstRateBp).toBe(1200);
  const saved = await put(ops, draft, { lines: [{ ...lineBody(draft.lines[0]), discount: 20000, discountReason: 'Old customer' }] });
  const r = await issue(ops, saved.body.invoice);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.invoice.lines[0]).toMatchObject({ taxable: 240000, gstRateBp: 500, cgst: 6000, sgst: 6000 });
  expect(r.body.invoice.totals).toMatchObject({ discount: 20000, total: 252000 });
  const [audit] = await issueAudits();
  expect(changeAt(audit, 'discounts')).toEqual([{ lineKey: draft.lines[0].key, amount: 20000, reason: 'Old customer' }]);
});

test('the start number comes from settings', async () => {
  const { ops, takeOrder } = await world();
  await setSetting(`numberSeries.invoice:${fy()}`, 101);
  const r = await issue(ops, await draftFor(await takeOrder()));
  expect(r.body.invoice.number).toBe(`INV/${fy()}/0101`);
});

test('issuing twice with one key returns the same bill', async () => {
  const { ops, takeOrder } = await world();
  const draft = await draftFor(await takeOrder());
  const send = () => ops.agent.post(`/v1/billing/invoices/${draft.id}/issue`).set('Idempotency-Key', 'tap-1').send({ version: draft.version });
  const first = await send();
  const second = await send();
  expect([first.status, second.status]).toEqual([201, 201]);
  expect(second.headers['idempotent-replayed']).toBe('true');
  expect(second.body.invoice.number).toBe(first.body.invoice.number);
  expect(await issueAudits()).toHaveLength(1);
  expect(await counterValue(await branchIdOf())).toBe(1);
  // Another key for the same draft is refused: it is no longer a draft at that version.
  const again = await issue(ops, draft);
  expect(again.status).toBe(409);
});

test('an aborted issue leaves no gap in the numbers', async () => {
  const { ops, takeOrder } = await world();
  const draft = await draftFor(await takeOrder());
  vi.spyOn(auditService, 'recordAudit').mockImplementationOnce(async () => {
    throw new Error('audit write failed');
  });
  const failed = await issue(ops, draft);
  expect(failed.status).toBe(500);
  expect(await Invoice.findById(draft.id).lean()).toMatchObject({ status: 'draft', number: null });
  expect(await counterValue(await branchIdOf())).toBe(0);
  const r = await issue(ops, draft);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.invoice.number).toBe(`INV/${fy()}/0001`);
});

test('concurrent issues get consecutive numbers', async () => {
  const { ops, takeOrder } = await world();
  const drafts = [];
  for (let i = 0; i < 3; i++) drafts.push(await draftFor(await takeOrder()));
  const results = await Promise.all(drafts.map((d) => issue(ops, d)));
  expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
  expect(results.map((r) => r.body.invoice.number).sort()).toEqual([1, 2, 3].map((n) => `INV/${fy()}/000${n}`));
});

test('an issued bill cannot be edited or deleted', async () => {
  const { ops, takeOrder } = await world();
  const inv = (await issue(ops, await draftFor(await takeOrder()))).body.invoice;
  const edit = await ops.agent.put(`/v1/billing/invoices/${inv.id}`).send({ version: inv.version, lines: [], invoiceDiscount: null, notes: '' });
  expect([edit.status, edit.body.error.code]).toEqual([422, 'DOCUMENT_IMMUTABLE']);
  const del = await ops.agent.delete(`/v1/billing/invoices/${inv.id}`);
  expect([del.status, del.body.error.code]).toEqual([422, 'DOCUMENT_IMMUTABLE']);
  const twice = await issue(ops, inv);
  expect([twice.status, twice.body.error.code]).toEqual([422, 'DOCUMENT_IMMUTABLE']);
});

test('a later customer change does not touch the issued bill', async () => {
  const { ops, customerId, takeOrder } = await world();
  const inv = (await issue(ops, await draftFor(await takeOrder()))).body.invoice;
  await Customer.updateOne({ _id: customerId }, { name: 'Asha Menon', stateCode: '27' });
  const view = (await ops.agent.get(`/v1/billing/invoices/${inv.id}`)).body.invoice;
  expect(view.customer).toMatchObject({ name: 'Asha Rao', stateCode: '29' });
  expect(view.placeOfSupply).toMatchObject({ stateCode: '29', interState: false });
  expect(view.totals).toEqual(inv.totals);
});

test('issuing in a locked month is refused', async () => {
  const { ops, takeOrder } = await world();
  const draft = await draftFor(await takeOrder());
  const branchId = await branchIdOf();
  await PeriodLock.create({ branchId, month: today().slice(0, 7), locked: true });
  const r = await issue(ops, draft);
  expect([r.status, r.body.error.code, r.body.error.details]).toEqual([422, 'PERIOD_LOCKED', { month: today().slice(0, 7) }]);
  expect(await counterValue(branchId)).toBe(0);
  expect((await Invoice.findById(draft.id).lean()).status).toBe('draft');
  expect(await issueAudits()).toHaveLength(0);
});

test('a bill of ₹50,000 to an unregistered customer needs an address', async () => {
  const { ops, customerId, takeOrder } = await world();
  const draft = await draftFor(await takeOrder({ prices: [4500000] }));
  const r = await issue(ops, draft);
  expect([r.status, r.body.error.code]).toEqual([422, 'ADDRESS_REQUIRED']);
  await Customer.updateOne({ _id: customerId }, { billingAddress: { line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' } });
  const ok = await issue(ops, draft);
  expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  const { snapshot } = await Invoice.findById(draft.id).lean();
  expect(snapshot.customer.address).toMatchObject({ line1: '12 MG Road', city: 'Bengaluru' });
});

test('a branch without GSTIN cannot issue', async () => {
  const { ops, takeOrder } = await world();
  const draft = await draftFor(await takeOrder());
  await Branch.updateOne({}, { gstin: null });
  const r = await issue(ops, draft);
  expect([r.status, r.body.error.code]).toEqual([422, 'BRANCH_GSTIN_MISSING']);
});

test('a line without an item or a price cannot be issued', async () => {
  const { ops, customerId } = await world();
  const blank = (await ops.agent.post('/v1/billing/invoices').send({ customerId })).body.invoice;
  const empty = await issue(ops, blank);
  expect([empty.status, empty.body.error.code]).toEqual([422, 'NO_LINES']);
  const manual = { key: 'm1', source: 'manual', itemId: null, garmentId: null, stageEventId: null, description: 'Pico', quantity: 1, rate: 0, discount: 0, discountReason: '' };
  const saved = (await put(ops, blank, { lines: [manual] })).body.invoice;
  const noItem = await issue(ops, saved);
  expect([noItem.status, noItem.body.error.code, noItem.body.error.details]).toEqual([422, 'ITEM_REQUIRED', { lineKey: 'm1' }]);
});

test('a rejected garment cannot be billed', async () => {
  const { ops, takeOrder } = await world();
  const order = await takeOrder();
  const draft = await draftFor(order);
  await act(ops, order.garments[0], { action: 'rejected', stage: 'order_taken', reason: 'Refused', resolution: 'refund' });
  const r = await issue(ops, draft);
  expect([r.status, r.body.error.code, r.body.error.details]).toEqual([422, 'GARMENT_NOT_BILLABLE', { lineKey: draft.lines[0].key }]);
  expect(await counterValue(await branchIdOf())).toBe(0);
});

test('a garment already on another issued bill is refused', async () => {
  const { ops, takeOrder } = await world();
  const order = await takeOrder();
  const draft = await draftFor(order);
  const branchId = await branchIdOf();
  await Invoice.create({
    branchId, customerId: draft.customer.id, orderId: order.id, status: 'issued', number: 'X/1', fyCode: fy(),
    date: today(), month: today().slice(0, 7), snapshot: { lines: [] }, garmentIds: [new ObjectId(order.garments[0].id)],
  });
  const r = await issue(ops, draft);
  expect([r.status, r.body.error.code, r.body.error.details]).toEqual([422, 'ALREADY_BILLED', { lineKey: draft.lines[0].key }]);
});

test('the advance is applied automatically', async () => {
  const { ops, customerId, takeOrder } = await world();
  const branchId = await branchIdOf();
  const order = await takeOrder({ prices: [450000] });
  const other = await takeOrder({ prices: [100000] });
  const base = { branchId, customerId, status: 'issued', fyCode: fy(), date: today(), month: today().slice(0, 7), mode: 'cash' };
  const rvId = new ObjectId();
  const own = await Receipt.create({ ...base, orderId: order.id, number: 'RCPT/1', amount: 100000, receiptVoucherId: rvId });
  await ReceiptVoucher.create({
    ...base, _id: rvId, orderId: order.id, number: 'RV/1', receiptId: own._id, gross: 50000, taxable: 47620, cgst: 1190, sgst: 1190, igst: 0,
  });
  const unassigned = await Receipt.create({ ...base, orderId: null, number: 'RCPT/2', amount: 30000 });
  const foreign = await Receipt.create({ ...base, orderId: other.id, number: 'RCPT/3', amount: 50000 });

  const r = await issue(ops, await draftFor(order));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const inv = r.body.invoice;
  expect(inv.settlement).toMatchObject({ advanceApplied: 130000, paid: 130000, balance: 374000, payStatus: 'part_paid' });
  expect(inv.advanceAdjustments).toEqual([{ receiptVoucherId: String(rvId), number: 'RV/1', taxable: 47620, tax: 2380 }]);
  const [audit] = await issueAudits();
  expect(changeAt(audit, 'advanceApplied')).toBe(130000);

  const left = await withTransaction((session) =>
    availableByReceipt(branchId, new ObjectId(customerId), { orderId: new ObjectId(other.id), includeUnassigned: true }, session),
  );
  expect(left.map((x) => [String(x.receipt._id), x.available])).toEqual([[String(foreign._id), 50000]]);
  expect(String(unassigned._id)).not.toBe(String(foreign._id));
});

test('operations can issue; designers cannot', async () => {
  const { ops, d1, takeOrder } = await world();
  const draft = await draftFor(await takeOrder());
  expect((await issue(d1, draft)).status).toBe(403);
  expect((await issue(ops, draft)).status).toBe(201);
  const noKey = await ops.agent.post(`/v1/billing/invoices/${draft.id}/issue`).send({ version: 0 });
  expect(noKey.status).toBe(400);
});
