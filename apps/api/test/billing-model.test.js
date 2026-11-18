import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { withTransaction } from '../src/core/db.js';
import { Branch } from '../src/modules/branches/model.js';
import { Settings } from '../src/modules/settings/model.js';
import {
  Allocation,
  BillingDocument,
  BillingGuard,
  ImmutableDocumentError,
  Invoice,
  Receipt,
} from '../src/modules/billing/model.js';
import {
  customerSnapshot,
  guardCustomerMoney,
  newPdfKey,
  sellerSnapshot,
  takeDocumentNumber,
  toImmutableError,
} from '../src/modules/billing/documents.js';
import { allocate, availableByReceipt, recomputeSettlement, releaseInvoice } from '../src/modules/billing/allocations.js';
useTestDb();

const { ObjectId } = mongoose.Types;
const now = new Date('2026-10-30T06:00:00Z');
const by = new ObjectId();

const issuedInvoice = (fields = {}) =>
  Invoice.create({
    branchId: new ObjectId(),
    customerId: new ObjectId(),
    status: 'issued',
    number: 'INV/2627/0001',
    fyCode: '2627',
    date: '2026-10-30',
    month: '2026-10',
    snapshot: { seller: { name: 'Vastrasanskara' }, lines: [] },
    totals: { gross: 100000, discount: 0, taxable: 100000, cgst: 2500, sgst: 2500, igst: 0, tax: 5000, roundOff: 0, total: 105000 },
    settlement: { advanceApplied: 0, paid: 0, credited: 0, balance: 105000 },
    issuedAt: now,
    issuedBy: by,
    ...fields,
  });

const receipt = (fields) =>
  Receipt.create({ status: 'issued', number: `RCPT/2627/${String(fields.n).padStart(4, '0')}`, fyCode: '2627', month: '2026-10', amount: 0, mode: 'cash', ...fields });

test('issued documents refuse changes', async () => {
  const { _id } = await issuedInvoice();
  const changes = [
    (d) => { d.snapshot = { ...d.snapshot, x: 1 }; },
    (d) => { d.totals.total = 1; },
    (d) => { d.number = 'INV/2627/0002'; },
    (d) => { d.date = '2026-10-29'; },
    (d) => { d.status = 'draft'; },
  ];
  for (const change of changes) {
    const doc = await Invoice.findById(_id);
    change(doc);
    await expect(doc.save()).rejects.toBeInstanceOf(ImmutableDocumentError);
  }
  await expect(BillingDocument.updateOne({ _id }, { $set: { 'snapshot.x': 1 } })).rejects.toBeInstanceOf(ImmutableDocumentError);
  await expect(Invoice.findOneAndUpdate({ _id }, { $set: { number: 'X' } })).rejects.toBeInstanceOf(ImmutableDocumentError);
  await expect(BillingDocument.updateOne({ _id }, { $rename: { 'pdf.lastError': 'number' } })).rejects.toBeInstanceOf(ImmutableDocumentError);
  await expect(BillingDocument.updateOne({ _id }, { $rename: { 'pdf.lastError': 'pdf.key' } })).rejects.toBeInstanceOf(ImmutableDocumentError);
  await expect(BillingDocument.updateOne({ _id }, { $unset: { snapshot: 1 } })).rejects.toBeInstanceOf(ImmutableDocumentError);
  await expect(BillingDocument.findOneAndReplace({ _id }, { status: 'issued' })).rejects.toBeInstanceOf(ImmutableDocumentError);
  await expect(BillingDocument.updateMany({ _id }, { $set: { remindersPaused: true } })).rejects.toBeInstanceOf(ImmutableDocumentError);
  await expect(BillingDocument.replaceOne({ _id }, { status: 'issued' })).rejects.toBeInstanceOf(ImmutableDocumentError);
  await expect(BillingDocument.deleteOne({ _id })).rejects.toBeInstanceOf(ImmutableDocumentError);
  await expect(BillingDocument.deleteMany({ status: 'draft' })).rejects.toBeInstanceOf(ImmutableDocumentError);
  await expect(BillingDocument.findOneAndDelete({ _id })).rejects.toBeInstanceOf(ImmutableDocumentError);
  await expect((await Invoice.findById(_id)).deleteOne()).rejects.toBeInstanceOf(ImmutableDocumentError);
  const stored = await Invoice.findById(_id).lean();
  expect(stored).toMatchObject({ number: 'INV/2627/0001', date: '2026-10-30', snapshot: { seller: { name: 'Vastrasanskara' } }, totals: { total: 105000 } });

  const cancelled = await Invoice.findById(_id);
  cancelled.status = 'cancelled';
  cancelled.cancellation = { reason: 'Wrong customer', at: now, by };
  await cancelled.save();
  cancelled.status = 'issued';
  await expect(cancelled.save()).rejects.toBeInstanceOf(ImmutableDocumentError);

  const err = toImmutableError(new ImmutableDocumentError('x'));
  expect(err).toMatchObject({ status: 422, code: 'DOCUMENT_IMMUTABLE', message: 'Issued documents cannot be changed' });
  const other = new Error('other');
  expect(toImmutableError(other)).toBe(other);
});

test('the PDF, settlement, reminders and cancellation can still change', async () => {
  const { _id } = await issuedInvoice();
  const doc = await Invoice.findById(_id);
  doc.pdf.status = 'ready';
  doc.pdf.sha256 = 'a'.repeat(64);
  doc.settlement.paid = 5000;
  doc.settlement.balance = 100000;
  doc.remindersPaused = true;
  doc.updatedBy = by;
  await doc.save();
  await BillingDocument.updateOne({ _id }, { $set: { 'pdf.status': 'rendering', 'pdf.lockedAt': now }, $inc: { 'pdf.attempts': 1 } });
  await Invoice.findOneAndUpdate({ _id, status: 'issued' }, { $set: { status: 'cancelled', cancellation: { reason: 'Duplicate', at: now, by } } });
  const stored = await Invoice.findById(_id).lean();
  expect(stored).toMatchObject({
    status: 'cancelled',
    remindersPaused: true,
    pdf: { status: 'rendering', attempts: 1, sha256: 'a'.repeat(64) },
    settlement: { paid: 5000, balance: 100000 },
    cancellation: { reason: 'Duplicate' },
  });
  // Status through a query only moves an issued document to cancelled.
  await expect(BillingDocument.updateOne({ _id }, { $set: { status: 'issued' } })).rejects.toBeInstanceOf(ImmutableDocumentError);
});

test('a document whose stored status is unknown is treated as fixed', async () => {
  const { _id } = await issuedInvoice();
  // Loaded without its status.
  const partial = await Invoice.findById(_id).select('number totals pdf');
  partial.number = 'INV/2627/0009';
  await expect(partial.save()).rejects.toBeInstanceOf(ImmutableDocumentError);
  const pdfOnly = await Invoice.findById(_id).select('pdf');
  pdfOnly.pdf.status = 'pending';
  await pdfOnly.save();
  // Built in memory and passed off as stored.
  const fake = new Invoice({ _id, branchId: new ObjectId(), customerId: new ObjectId() });
  fake.isNew = false;
  fake.number = 'INV/2627/0009';
  await expect(fake.save()).rejects.toBeInstanceOf(ImmutableDocumentError);
  const fakeCancel = new Invoice({ _id, branchId: new ObjectId(), customerId: new ObjectId() });
  fakeCancel.isNew = false;
  fakeCancel.status = 'cancelled';
  await expect(fakeCancel.save()).rejects.toBeInstanceOf(ImmutableDocumentError);
  await expect(partial.deleteOne()).rejects.toBeInstanceOf(ImmutableDocumentError);
  expect(await Invoice.findById(_id).lean()).toMatchObject({ number: 'INV/2627/0001', status: 'issued', pdf: { status: 'pending' } });
});

test('a draft cannot be cancelled', async () => {
  const draft = await Invoice.create({ branchId: new ObjectId(), customerId: new ObjectId() });
  draft.status = 'cancelled';
  await expect(draft.save()).rejects.toBeInstanceOf(ImmutableDocumentError);
  const loaded = await Invoice.findById(draft._id);
  loaded.set({ status: 'cancelled', cancellation: { reason: 'x', at: now, by } });
  await expect(loaded.save()).rejects.toBeInstanceOf(ImmutableDocumentError);
  expect((await Invoice.findById(draft._id).lean()).status).toBe('draft');
});

test('receipt and refund amounts are whole positive paise', async () => {
  const base = { branchId: new ObjectId(), customerId: new ObjectId(), mode: 'cash' };
  for (const amount of [0, -100, 10.5]) {
    await expect(Receipt.create({ ...base, amount })).rejects.toThrow(/amount/);
    await expect(BillingDocument.create({ ...base, type: 'refund', amount })).rejects.toThrow(/amount/);
  }
  expect((await Receipt.create({ ...base, amount: 1 })).amount).toBe(1);
});

test('drafts can be edited and deleted', async () => {
  const draft = await Invoice.create({ branchId: new ObjectId(), customerId: new ObjectId(), orderId: new ObjectId(), draft: { lines: [{ key: 'a', rate: 1000 }], notes: '' } });
  expect(draft.toObject()).toMatchObject({ status: 'draft', number: null, date: null, snapshot: null, pdf: { status: 'none' }, cancellation: null });
  draft.draft.lines = [{ key: 'b', rate: 2000 }];
  draft.draft.notes = 'Hem at 40';
  draft.interState = true;
  await draft.save();
  // Issuing turns the draft into a fixed document in one save.
  draft.set({ status: 'issued', number: 'INV/2627/0001', fyCode: '2627', date: '2026-10-30', month: '2026-10', snapshot: { lines: [] } });
  await draft.save();
  draft.date = '2026-10-31';
  await expect(draft.save()).rejects.toBeInstanceOf(ImmutableDocumentError);

  const other = await Invoice.create({ branchId: new ObjectId(), customerId: new ObjectId() });
  expect((await BillingDocument.deleteOne({ _id: other._id, status: 'draft' })).deletedCount).toBe(1);
  const third = await Invoice.create({ branchId: new ObjectId(), customerId: new ObjectId() });
  await (await Invoice.findById(third._id)).deleteOne();
  expect(await BillingDocument.countDocuments()).toBe(1);
});

test('allocations are append-only', async () => {
  const [row] = await withTransaction((session) =>
    allocate({ branchId: new ObjectId(), customerId: new ObjectId(), receiptId: new ObjectId(), invoiceId: new ObjectId(), amount: 5000, reason: 'payment', date: '2026-10-30', by }, session).then((r) => [r]),
  );
  await expect(Allocation.updateOne({ _id: row._id }, { $set: { amount: 1 } })).rejects.toThrow(/append-only/);
  await expect(Allocation.findOneAndUpdate({ _id: row._id }, { $set: { amount: 1 } })).rejects.toThrow(/append-only/);
  await expect(Allocation.deleteOne({ _id: row._id })).rejects.toThrow(/append-only/);
  await expect(Allocation.deleteMany({})).rejects.toThrow(/append-only/);
  await expect(Allocation.replaceOne({ _id: row._id }, {})).rejects.toThrow(/append-only/);
  const loaded = await Allocation.findById(row._id);
  loaded.amount = 1;
  await expect(loaded.save()).rejects.toThrow(/append-only/);
  expect((await Allocation.findById(row._id).lean()).amount).toBe(5000);
});

test('allocations settle bills, release newest first and leave the rest as advance', async () => {
  const branchId = new ObjectId();
  const customerId = new ObjectId();
  const orderId = new ObjectId();
  const r1 = await receipt({ branchId, customerId, orderId, n: 1, amount: 30000, date: '2026-10-01' });
  const r2 = await receipt({ branchId, customerId, orderId: null, n: 2, amount: 20000, date: '2026-09-01' });
  await receipt({ branchId, customerId, orderId: new ObjectId(), n: 3, amount: 50000, date: '2026-09-01' });
  await receipt({ branchId, customerId, orderId, n: 4, amount: 40000, date: '2026-10-02', status: 'cancelled' });
  const invoice = await issuedInvoice({ branchId, customerId, orderId });

  await withTransaction(async (session) => {
    const own = await availableByReceipt(branchId, customerId, { orderId }, session);
    expect(own.map((a) => [a.receipt.number, a.available])).toEqual([['RCPT/2627/0001', 30000]]);
    expect(await availableByReceipt(branchId, customerId, { orderId: null }, session)).toEqual([]);
    const unassigned = await availableByReceipt(branchId, customerId, { orderId: null, includeUnassigned: true }, session);
    expect(unassigned.map((a) => a.receipt.number)).toEqual(['RCPT/2627/0002']);
    const held = await availableByReceipt(branchId, customerId, { orderId, includeUnassigned: true }, session);
    expect(held.map((a) => [a.receipt.number, a.available])).toEqual([['RCPT/2627/0001', 30000], ['RCPT/2627/0002', 20000]]);
    const base = { branchId, customerId, invoiceId: invoice._id, date: '2026-10-30', by };
    await allocate({ ...base, receiptId: r1._id, amount: 30000, reason: 'advance_applied' }, session);
    await allocate({ ...base, receiptId: r2._id, amount: 15000, reason: 'payment' }, session);
  });
  const remaining = await withTransaction((session) => availableByReceipt(branchId, customerId, { orderId, includeUnassigned: true }, session));
  expect(remaining.map((a) => [a.receipt.number, a.available])).toEqual([['RCPT/2627/0002', 5000]]);

  let settlement = await withTransaction((session) => recomputeSettlement(invoice._id, session));
  expect(settlement).toEqual({ advanceApplied: 30000, paid: 45000, credited: 0, balance: 60000 });

  const rows = await withTransaction(async (session) => releaseInvoice(await Invoice.findById(invoice._id).session(session), 20000, 'release_credit', { userId: by }, session));
  expect(rows.map((r) => [String(r.receiptId), r.amount, r.reason])).toEqual([
    [String(r2._id), -15000, 'release_credit'],
    [String(r1._id), -5000, 'release_credit'],
  ]);
  await BillingDocument.create({ type: 'credit_note', branchId, customerId, invoiceId: invoice._id, status: 'issued', number: 'CN/2627/0001', fyCode: '2627', date: '2026-10-30', month: '2026-10', totals: { total: 20000 } });
  settlement = await withTransaction((session) => recomputeSettlement(invoice._id, session));
  expect(settlement).toEqual({ advanceApplied: 30000, paid: 25000, credited: 20000, balance: 60000 });
  expect((await Invoice.findById(invoice._id).lean()).settlement).toEqual(settlement);
  await expect(withTransaction(async (session) => releaseInvoice(await Invoice.findById(invoice._id).session(session), 25001, 'release_cancel', { userId: by }, session))).rejects.toThrow();
});

test('numbers follow the series and financial year', async () => {
  const branch = await Branch.create({ name: 'VS', legalName: 'VS Pvt Ltd', stateCode: '29' });
  const take = (docType, at = now) => withTransaction((session) => takeDocumentNumber({ branchId: branch._id, docType, now: at }, session));
  expect(await take('invoice')).toEqual({ number: 'INV/2627/0001', fyCode: '2627' });
  expect(await take('invoice')).toEqual({ number: 'INV/2627/0002', fyCode: '2627' });
  expect(await take('receipt')).toEqual({ number: 'RCPT/2627/0001', fyCode: '2627' });
  expect(await take('receipt_voucher')).toEqual({ number: 'RV/2627/0001', fyCode: '2627' });
  expect(await take('invoice', new Date('2027-04-01T06:00:00Z'))).toEqual({ number: 'INV/2728/0001', fyCode: '2728' });

  const other = await Branch.create({ name: 'VS2', legalName: 'VS2', stateCode: '29' });
  await Settings.create({ branchId: other._id, values: { numberSeries: { 'invoice:2627': 101 } } });
  const takeOther = (docType) => withTransaction((session) => takeDocumentNumber({ branchId: other._id, docType, now }, session));
  expect(await takeOther('invoice')).toEqual({ number: 'INV/2627/0101', fyCode: '2627' });
  expect(await takeOther('invoice')).toEqual({ number: 'INV/2627/0102', fyCode: '2627' });
  expect(await takeOther('receipt')).toEqual({ number: 'RCPT/2627/0001', fyCode: '2627' });
  expect(await takeOther('credit_note')).toEqual({ number: 'CN/2627/0001', fyCode: '2627' });
});

test('a number longer than 16 characters is refused', async () => {
  const branch = await Branch.create({ name: 'VS', legalName: 'VS', stateCode: '29', prefixes: { invoice: 'ABCDEF' } });
  await Settings.create({ branchId: branch._id, values: { numberSeries: { 'invoice:2627': 9999 } } });
  const take = () => withTransaction((session) => takeDocumentNumber({ branchId: branch._id, docType: 'invoice', now }, session));
  expect(await take()).toEqual({ number: 'ABCDEF/2627/9999', fyCode: '2627' });
  await expect(take()).rejects.toMatchObject({ status: 422, code: 'DOC_NUMBER_TOO_LONG' });
  // The refused number was not used up.
  await expect(take()).rejects.toMatchObject({ code: 'DOC_NUMBER_TOO_LONG' });
  const counter = await mongoose.connection.collection('counters').findOne({ _id: `doc:${branch._id}:invoice:2627` });
  expect(counter.value).toBe(1);
});

test('the customer guard makes concurrent money writes conflict and retry', async () => {
  const branchId = new ObjectId();
  const customerId = new ObjectId();
  const rows = mongoose.connection.collection('guardProbe');
  await rows.insertOne({ n: 0 });
  await rows.deleteMany({});
  const runs = { a: 0, b: 0 };
  let releaseA;
  const aMayCommit = new Promise((resolve) => { releaseA = resolve; });
  let aGuarded;
  const aHasGuard = new Promise((resolve) => { aGuarded = resolve; });

  // Each write reads how many rows exist and appends the next one, as a payment reads a balance.
  const write = async (name, session) => {
    runs[name] += 1;
    await guardCustomerMoney(branchId, customerId, session);
    const n = await rows.countDocuments({}, { session });
    await rows.insertOne({ n: n + 1, name }, { session });
  };
  const a = withTransaction(async (session) => {
    await write('a', session);
    aGuarded();
    // Without the guard B never conflicts: give up waiting and let the row check fail.
    await Promise.race([aMayCommit, new Promise((resolve) => { setTimeout(resolve, 3000); })]);
  });
  const b = (async () => {
    await aHasGuard;
    return withTransaction(async (session) => {
      if (runs.b === 1) releaseA(); // B's first try conflicted: let A commit.
      await write('b', session);
    });
  })();
  await Promise.all([a, b]);

  expect(runs.a).toBe(1);
  expect(runs.b).toBeGreaterThanOrEqual(2);
  expect((await rows.find({}).sort({ n: 1 }).toArray()).map((r) => [r.n, r.name])).toEqual([[1, 'a'], [2, 'b']]);
  expect((await BillingGuard.findById(`${branchId}:${customerId}`).lean()).seq).toBe(2);
  await expect(guardCustomerMoney(branchId, customerId)).rejects.toThrow(/transaction/);
});

test('snapshots and PDF keys', () => {
  const branchId = new ObjectId();
  expect(newPdfKey(branchId, new Date('2026-12-31T19:00:00Z'))).toMatch(new RegExp(`^${branchId}/billing_pdf/2027/[0-9a-f-]{36}\\.pdf$`));
  const address = { line1: '1 MG Road', line2: '', city: 'Bengaluru', pincode: '560001' };
  expect(sellerSnapshot({ _id: branchId, name: 'VS', legalName: 'VS Pvt Ltd', gstin: '29ABCDE1234F1Z5', stateCode: '29', address, phone: '+919876543210', email: 'a@b.in', logoKey: null, prefixes: {} }))
    .toEqual({ name: 'VS', legalName: 'VS Pvt Ltd', gstin: '29ABCDE1234F1Z5', stateCode: '29', stateName: 'Karnataka', address, phone: '+919876543210', email: 'a@b.in', logoKey: null });
  const customerId = new ObjectId();
  const snap = customerSnapshot({ _id: customerId, name: 'Asha', phone: '+919999999999', email: 'asha@x.in', gstin: null, stateCode: '32', billingAddress: address });
  expect(snap).toEqual({ id: String(customerId), name: 'Asha', gstin: null, stateCode: '32', stateName: 'Kerala', address, registered: false });
  expect(customerSnapshot({ id: String(customerId), name: 'B', gstin: '32ABCDE1234F1Z5', stateCode: '32', billingAddress: address }).registered).toBe(true);
});

test('the billing indexes exist', async () => {
  await BillingDocument.init();
  const names = (await BillingDocument.collection.listIndexes().toArray()).map((i) => i.name);
  expect(names).toEqual(expect.arrayContaining([
    'number_unique', 'ledger', 'register', 'receivables_v2', 'order_docs', 'one_draft_per_order',
    'pdf_queue', 'billed_garments', 'billed_events', 'credit_notes', 'pdf_key',
  ]));
  await Allocation.init();
  const allocationKeys = (await Allocation.collection.listIndexes().toArray()).map((i) => Object.keys(i.key).join(','));
  expect(allocationKeys).toEqual(expect.arrayContaining(['receiptId', 'invoiceId', 'refundId', 'branchId,customerId,date']));
  // One draft bill per order; blank drafts (no order) are not limited.
  const draft = () => ({ branchId: new ObjectId(), customerId: new ObjectId() });
  const orderId = new ObjectId();
  await Invoice.create({ ...draft(), orderId });
  await expect(Invoice.create({ ...draft(), orderId })).rejects.toThrow(/duplicate key/);
  await Invoice.create(draft());
  await Invoice.create(draft());
});
