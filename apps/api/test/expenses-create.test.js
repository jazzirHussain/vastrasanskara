import { test, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { DEFAULT_EXPENSE_CATEGORIES, addDaysYmd, financialYear } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { expenseHelpers, VENDOR_GSTIN } from './helpers/expenses.js';
import { today } from './helpers/production.js';
import { clock } from '../src/clock.js';
import * as auditService from '../src/core/audit/service.js';
import { AuditLog } from '../src/core/audit/model.js';
import { withTransaction } from '../src/core/db.js';
import { Expense, ExpenseImmutableError } from '../src/modules/expenses/model.js';
import { createExpense } from '../src/modules/expenses/service.js';

useTestDb();
const app = buildTestApp();
const { world, upload, add, lockMonth } = expenseHelpers(app);
const { ObjectId } = mongoose.Types;

afterEach(() => vi.restoreAllMocks());

const fy = () => financialYear(clock.now()).code;
const counterValue = async (branchId, fyCode = fy()) =>
  (await mongoose.connection.collection('counters').findOne({ _id: `doc:${branchId}:expense:${fyCode}` }))?.value ?? 0;
const expenseAudits = () => AuditLog.find({ entityType: 'expense' }).lean();
const paths = (r) => (r.body.error?.details ?? []).map((d) => d.path);
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const gstBill = (fields = {}) => ({
  billNo: 'INV-77', billDate: today(), rateBp: 1800, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, ...fields,
});
const lastMonthEnd = () => addDaysYmd(`${today().slice(0, 7)}-01`, -1);

test('an expense is saved with a number, a payee and a photo', async () => {
  const { ops } = await world();
  const key = await upload(ops);
  const r = await add(ops, { note: 'October rent', attachments: [{ key, name: 'bill.jpg' }] });
  ok(r);
  const { expense } = r.body;
  expect(expense).toMatchObject({
    number: `EXP/${fy()}/0001`,
    date: today(),
    month: today().slice(0, 7),
    category: { key: 'rent', label: 'Rent' },
    note: 'October rent',
    payee: { vendorId: null, name: 'Lakshmi Textiles', gstin: null, stateCode: null },
    total: 118000,
    mode: 'cash',
    gst: null,
    cost: 118000,
    attachments: [{ key, name: 'bill.jpg', contentType: 'image/jpeg', size: 3 }],
    link: null,
    status: 'active',
    void: null,
    monthLocked: false,
    source: 'manual',
    createdBy: { id: String(ops.user._id), name: ops.user.name },
    version: 0,
  });
  const audits = await expenseAudits();
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ entityType: 'expense', action: 'create', entityId: expense.id });

  const read = await ops.agent.get(`/v1/expenses/${expense.id}`);
  ok(read, 200);
  expect(read.body.expense).toEqual(expense);
  expect((await ops.agent.get(`/v1/expenses/${new ObjectId()}`)).status).toBe(404);
});

test("numbers follow the series and the expense date's financial year", async () => {
  vi.spyOn(clock, 'now').mockReturnValue(new Date('2027-04-01T06:00:00Z')); // 1 April 2027, IST
  const { ops, admin, branchId } = await world();
  ok(await admin.agent.put('/v1/settings').send({ numberSeries: { 'expense:2728': 50 } }), 200);
  // A 31 March bill entered on 1 April continues last year's series.
  const march = await add(ops, { date: '2027-03-31' });
  ok(march);
  expect(march.body.expense.number).toBe('EXP/2627/0001');
  expect(await counterValue(branchId, '2627')).toBe(1);
  const april = await add(ops, { date: '2027-04-01' });
  expect(april.body.expense.number).toBe('EXP/2728/0050');
  expect((await add(ops, { date: '2027-04-01' })).body.expense.number).toBe('EXP/2728/0051');
});

test('saving twice with one key makes one expense', async () => {
  const { ops, branchId } = await world();
  const first = await add(ops, {}, 'same-key');
  const second = await add(ops, {}, 'same-key');
  expect([first.status, second.status]).toEqual([201, 201]);
  expect(second.headers['idempotent-replayed']).toBe('true');
  expect(second.body.expense.number).toBe(first.body.expense.number);
  expect(await Expense.countDocuments()).toBe(1);
  expect(await expenseAudits()).toHaveLength(1);
  expect(await counterValue(branchId)).toBe(1);
});

test('an aborted save leaves no gap in the numbers', async () => {
  const { ops, branchId } = await world();
  vi.spyOn(auditService, 'recordAudit').mockImplementationOnce(async () => {
    throw new Error('audit write failed');
  });
  const failed = await add(ops);
  expect(failed.status).toBe(500);
  expect(await Expense.countDocuments()).toBe(0);
  expect(await counterValue(branchId)).toBe(0);
  const r = await add(ops);
  ok(r);
  expect(r.body.expense.number).toBe(`EXP/${fy()}/0001`);
});

test('concurrent saves get consecutive numbers', async () => {
  const { ops } = await world();
  const results = await Promise.all([1, 2, 3].map(() => add(ops)));
  expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
  expect(results.map((r) => r.body.expense.number).sort()).toEqual([1, 2, 3].map((n) => `EXP/${fy()}/000${n}`));
});

test('a vendor payee is copied from the vendor', async () => {
  const { ops, admin, vendor29 } = await world();
  const r = await add(ops, {
    category: 'material_purchase',
    payee: { vendorId: vendor29.id, name: 'ignored', gstin: '27AAAPL1234C1Z5', stateCode: '27' },
    gst: gstBill(),
  });
  ok(r);
  expect(r.body.expense.payee).toEqual({ vendorId: vendor29.id, name: 'Bengaluru Silks', gstin: VENDOR_GSTIN, stateCode: '29' });
  ok(await admin.agent.patch(`/v1/vendors/${vendor29.id}`).send({ version: vendor29.version, name: 'Renamed Silks' }), 200);
  const read = await ops.agent.get(`/v1/expenses/${r.body.expense.id}`);
  expect(read.body.expense.payee.name).toBe('Bengaluru Silks');
  expect((await Expense.findById(r.body.expense.id).lean()).payee.searchName).toBe('bengaluru silks');

  const unknown = await add(ops, { payee: { vendorId: String(new ObjectId()) } });
  expect([unknown.status, paths(unknown)]).toEqual([400, ['payee.vendorId']]);
  ok(await admin.agent.patch(`/v1/vendors/${vendor29.id}`).send({ version: vendor29.version + 1, active: false }), 200);
  const inactive = await add(ops, { payee: { vendorId: vendor29.id } });
  expect([inactive.status, paths(inactive)]).toEqual([400, ['payee.vendorId']]);
});

test("a free-text payee with a GSTIN takes the GSTIN's state", async () => {
  const { ops } = await world();
  const r = await add(ops, { payee: { name: 'Online Packers', gstin: '27AAAPL1234C1Z5' } });
  ok(r);
  expect(r.body.expense.payee).toEqual({ vendorId: null, name: 'Online Packers', gstin: '27AAAPL1234C1Z5', stateCode: '27' });
});

test("a GST bill needs the supplier's GSTIN", async () => {
  const { ops, vendor27 } = await world();
  const free = await add(ops, { gst: gstBill() });
  expect([free.status, paths(free)]).toEqual([400, ['payee.gstin']]);
  // A vendor without a GSTIN: a GSTIN typed alongside is not taken.
  const vendor = await add(ops, { payee: { vendorId: vendor27.id, gstin: '27AAAPL1234C1Z5' }, gst: gstBill() });
  expect([vendor.status, paths(vendor)]).toEqual([400, ['payee.gstin']]);
  expect(await Expense.countDocuments()).toBe(0);
});

test('tax that does not add up or does not match the rate is refused', async () => {
  const { ops } = await world();
  const payee = { name: 'Lakshmi Textiles', gstin: VENDOR_GSTIN };
  const sum = await add(ops, { payee, gst: gstBill({ taxable: 99000 }) });
  expect(sum.status).toBe(400);
  expect(paths(sum)).toContain('gst.taxable');
  const rate = await add(ops, { payee, total: 108000, gst: gstBill({ cgst: 4000, sgst: 4000 }) });
  expect(rate.status).toBe(400);
  expect(paths(rate)).toContain('gst.cgst');
  const good = await add(ops, { payee, gst: gstBill() });
  ok(good);
  expect(good.body.expense.gst).toMatchObject({ taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, tax: 18000, interState: false, itcEligible: true });
  expect(good.body.expense.cost).toBe(100000);
});

test('IGST marks the expense inter-state', async () => {
  const { ops } = await world();
  const r = await add(ops, {
    payee: { name: 'Mumbai Zari', gstin: '27AAAPL1234C1Z5' },
    gst: gstBill({ cgst: 0, sgst: 0, igst: 18000, itcEligible: false }),
  });
  ok(r);
  expect(r.body.expense.gst).toMatchObject({ igst: 18000, interState: true, itcEligible: false });
  expect(r.body.expense.cost).toBe(118000);
});

test('a future date is refused', async () => {
  const { ops, branchId } = await world();
  const r = await add(ops, { date: addDaysYmd(today(), 1) });
  expect([r.status, r.body.error.code, r.body.error.message]).toEqual([422, 'EXPENSE_DATE_IN_FUTURE', 'The date cannot be in the future']);
  expect(await counterValue(branchId)).toBe(0);
});

test('a hidden category cannot be used for a new expense', async () => {
  const { ops, admin } = await world();
  const categories = DEFAULT_EXPENSE_CATEGORIES.map((c) => ({ ...c, active: c.key !== 'rent' }));
  ok(await admin.agent.put('/v1/settings').send({ expenseCategories: categories }), 200);
  const hidden = await add(ops, { category: 'rent' });
  expect([hidden.status, paths(hidden)]).toEqual([400, ['category']]);
  const unknown = await add(ops, { category: 'no_such_thing' });
  expect([unknown.status, paths(unknown)]).toEqual([400, ['category']]);
  ok(await add(ops, { category: 'electricity' }));
});

test('a photo that was never uploaded is refused', async () => {
  const { ops, branchId } = await world();
  const { body } = await ops.agent.post('/v1/files/upload-url').send({ purpose: 'expense_bill', contentType: 'image/jpeg', size: 3 });
  const uploaded = await upload(ops);
  const r = await add(ops, { attachments: [{ key: uploaded, name: 'a.jpg' }, { key: body.key, name: 'b.jpg' }] });
  expect([r.status, r.body.error.code, r.body.error.details]).toEqual([400, 'ATTACHMENT_NOT_UPLOADED', { index: 1 }]);
  expect(await counterValue(branchId)).toBe(0);
});

test("another branch's or another purpose's key is refused", async () => {
  const { ops, admin, branchId } = await world();
  const otherBranch = (await upload(ops)).replace(branchId, String(new ObjectId()));
  const r1 = await add(ops, { attachments: [{ key: otherBranch, name: 'a.jpg' }] });
  expect([r1.status, paths(r1)]).toEqual([400, ['attachments.0.key']]);
  const { body: logo } = await admin.agent.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'image/png', size: 3 });
  const r2 = await add(ops, { attachments: [{ key: logo.key, name: 'logo.png' }] });
  expect([r2.status, paths(r2)]).toEqual([400, ['attachments.0.key']]);
});

test('a locked month refuses a new expense', async () => {
  const { ops, branchId } = await world();
  const date = lastMonthEnd();
  await lockMonth(date.slice(0, 7));
  const auditsBefore = await AuditLog.countDocuments();
  const r = await add(ops, { date });
  expect([r.status, r.body.error.code, r.body.error.details]).toEqual([422, 'PERIOD_LOCKED', { month: date.slice(0, 7) }]);
  expect(await Expense.countDocuments()).toBe(0);
  expect(await counterValue(branchId, financialYear(new Date(`${date}T12:00:00+05:30`)).code)).toBe(0);
  expect(await AuditLog.countDocuments()).toBe(auditsBefore);
});

test("an expense can be saved inside another module's transaction", async () => {
  const { ops, admin, branchId } = await world();
  const actor = { userId: admin.user._id };
  const input = { date: today(), category: 'material_purchase', payee: { name: 'Fabric house' }, total: 50000, mode: 'upi' };
  await expect(
    withTransaction(async (session) => {
      const expense = await createExpense(branchId, input, actor, { session, source: 'purchase', sourceRef: 'GRN-1' });
      expect(expense).toMatchObject({ number: `EXP/${fy()}/0001`, source: 'purchase', sourceRef: 'GRN-1' });
      throw new Error('stock receiving failed');
    }),
  ).rejects.toThrow('stock receiving failed');
  expect(await Expense.countDocuments()).toBe(0);
  expect(await counterValue(branchId)).toBe(0);
  expect(await expenseAudits()).toHaveLength(0);

  const saved = await withTransaction((session) => createExpense(branchId, input, actor, { session, source: 'purchase' }));
  expect(saved).toMatchObject({ number: `EXP/${fy()}/0001`, source: 'purchase' });
  ok(await ops.agent.get(`/v1/expenses/${saved._id}`), 200);
});

test('expenses cannot be deleted', async () => {
  const { ops } = await world();
  const { id } = (await add(ops)).body.expense;
  await expect(Expense.deleteOne({ _id: id })).rejects.toThrow(ExpenseImmutableError);
  await expect(Expense.deleteMany({})).rejects.toThrow(ExpenseImmutableError);
  await expect(Expense.findOneAndDelete({ _id: id })).rejects.toThrow(ExpenseImmutableError);
  await expect(Expense.replaceOne({ _id: id }, { note: 'x' })).rejects.toThrow(ExpenseImmutableError);
  await expect(Expense.findOneAndReplace({ _id: id }, { note: 'x' })).rejects.toThrow(ExpenseImmutableError);
  await expect(Expense.updateMany({}, { note: 'x' })).rejects.toThrow(ExpenseImmutableError);
  const doc = await Expense.findById(id);
  await expect(doc.deleteOne()).rejects.toThrow(ExpenseImmutableError);

  // A voided expense refuses every further change.
  await Expense.collection.updateOne({ _id: doc._id }, { $set: { status: 'voided' } });
  const voided = await Expense.findById(id);
  voided.note = 'changed';
  await expect(voided.save()).rejects.toThrow(ExpenseImmutableError);
  expect(await Expense.countDocuments()).toBe(1);
});
