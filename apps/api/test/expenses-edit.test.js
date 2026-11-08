import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { expenseHelpers, VENDOR_GSTIN } from './helpers/expenses.js';
import { clock } from '../src/clock.js';
import { AuditLog } from '../src/core/audit/model.js';
import * as periods from '../src/modules/periods/service.js';
import { Expense } from '../src/modules/expenses/model.js';
import { updateExpense } from '../src/modules/expenses/service.js';

useTestDb();
const app = buildTestApp();
const { world, upload, add, lockMonth } = expenseHelpers(app);

// "Now" is 15 Nov 2026 (IST): October is finished and can be locked; the FY is 2026-27.
const NOW = new Date('2026-11-15T06:00:00Z');
const TODAY = '2026-11-15';
const LAST = '2026-10';
beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const paths = (r) => (r.body.error?.details ?? []).map((d) => d.path);
const expenseAudits = (action) => AuditLog.find({ entityType: 'expense', ...(action ? { action } : {}) }).sort({ seq: 1 }).lean();
const gstBill = (fields = {}) => ({
  billNo: 'INV-77', billDate: TODAY, rateBp: 1800, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, itcEligible: true, ...fields,
});

async function added(who, body) {
  const r = await add(who, body);
  ok(r, 201);
  return r.body.expense;
}
const edit = (who, expense, fields) => who.agent.patch(`/v1/expenses/${expense.id}`).send({ version: expense.version, ...fields });
const voidIt = (who, expense, reason = 'Entered twice') =>
  who.agent.post(`/v1/expenses/${expense.id}/void`).send({ version: expense.version, reason });

test('editing changes only what is sent and is audited', async () => {
  const { ops } = await world();
  const payee = { vendorId: null, name: 'Lakshmi Textiles', gstin: VENDOR_GSTIN, stateCode: null };
  const expense = await added(ops, { payee, note: 'Shop rent' });
  const r = await edit(ops, expense, { total: 118000, gst: gstBill() });
  ok(r);
  const after = r.body.expense;
  expect(after).toMatchObject({
    note: 'Shop rent',
    total: 118000,
    gst: { taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, interState: false, itcEligible: true },
    version: 1,
  });
  const updates = await expenseAudits('update');
  expect(updates).toHaveLength(1);
  expect(updates[0].changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.stringMatching(/^gst/) })]));

  // IGST makes it inter-state; the total can change with the tax.
  const igst = await edit(ops, after, { total: 236000, gst: gstBill({ taxable: 200000, cgst: 0, sgst: 0, igst: 36000 }) });
  ok(igst);
  expect(igst.body.expense.gst).toMatchObject({ igst: 36000, interState: true });
  expect(igst.body.expense.total).toBe(236000);

  // A total that no longer matches the stored GST bill is refused.
  const bad = await edit(ops, igst.body.expense, { total: 100 });
  expect(bad.status).toBe(400);
  expect(paths(bad)).toContain('gst.taxable');

  // Sending what is already there changes nothing and writes no audit entry.
  const same = await edit(ops, igst.body.expense, { note: 'Shop rent', total: 236000 });
  ok(same);
  expect(await expenseAudits('update')).toHaveLength(2);
  // ...and keeps the version, so a double-tapped Save of unchanged data is not a conflict.
  expect(same.body.expense.version).toBe(igst.body.expense.version);
  ok(await edit(ops, igst.body.expense, { note: 'Shop rent' }));
});

test('a stale version is a conflict', async () => {
  const { ops } = await world();
  const expense = await added(ops);
  ok(await edit(ops, expense, { note: 'First' }));
  const stale = await edit(ops, expense, { note: 'Second' });
  expect([stale.status, stale.body.error.code]).toEqual([409, 'CONFLICT']);
  const staleVoid = await voidIt(ops, expense);
  expect([staleVoid.status, staleVoid.body.error.code]).toEqual([409, 'CONFLICT']);
  expect((await ops.agent.get(`/v1/expenses/${expense.id}`)).body.expense.note).toBe('First');
});

test('the number never changes', async () => {
  const { ops } = await world();
  const expense = await added(ops);
  const r = await edit(ops, expense, { date: '2026-11-01', category: 'electricity', total: 5000 });
  ok(r);
  expect(r.body.expense).toMatchObject({ number: expense.number, date: '2026-11-01', category: { key: 'electricity' } });
  const unknown = await edit(ops, r.body.expense, { number: 'EXP/2627/9999' });
  expect(unknown.status).toBe(400);
  expect((await Expense.findById(expense.id).lean()).number).toBe(expense.number);
});

test('the date can move within the financial year', async () => {
  const { ops } = await world();
  const expense = await added(ops);
  const r = await edit(ops, expense, { date: '2026-04-01' });
  ok(r);
  expect(r.body.expense).toMatchObject({ date: '2026-04-01', month: '2026-04', number: expense.number });
  expect((await Expense.findById(expense.id).lean()).fyCode).toBe('2627');
  const future = await edit(ops, r.body.expense, { date: '2026-11-16' });
  expect([future.status, future.body.error.code]).toEqual([422, 'EXPENSE_DATE_IN_FUTURE']);
});

test('moving to another financial year is refused', async () => {
  const { ops } = await world();
  const expense = await added(ops);
  const r = await edit(ops, expense, { date: '2026-03-31' });
  expect([r.status, r.body.error.code, r.body.error.message]).toEqual([
    422, 'EXPENSE_FY_CHANGE', 'An expense cannot move to another financial year',
  ]);
  expect((await Expense.findById(expense.id).lean()).date).toBe(TODAY);
});

test('a locked month refuses every expense write', async () => {
  const { ops } = await world();
  const expense = await added(ops, { date: `${LAST}-20` });
  await lockMonth(LAST);
  const stored = await Expense.findById(expense.id).lean();
  const auditsBefore = await AuditLog.countDocuments();

  const edited = await edit(ops, expense, { note: 'Late note' });
  expect([edited.status, edited.body.error.code, edited.body.error.details]).toEqual([422, 'PERIOD_LOCKED', { month: LAST }]);
  const voided = await voidIt(ops, expense);
  expect([voided.status, voided.body.error.code]).toEqual([422, 'PERIOD_LOCKED']);
  const created = await add(ops, { date: `${LAST}-21` });
  expect([created.status, created.body.error.code]).toEqual([422, 'PERIOD_LOCKED']);

  expect(await AuditLog.countDocuments()).toBe(auditsBefore);
  expect(await Expense.findById(expense.id).lean()).toEqual(stored);
  const read = await ops.agent.get(`/v1/expenses/${expense.id}`);
  expect(read.body.expense.monthLocked).toBe(true);
});

test('an expense cannot be moved into or out of a locked month', async () => {
  const { ops } = await world();
  const open = await added(ops);
  const old = await added(ops, { date: `${LAST}-20` });
  await lockMonth(LAST);
  const auditsBefore = await AuditLog.countDocuments();

  const into = await edit(ops, open, { date: `${LAST}-25` });
  expect([into.status, into.body.error.code, into.body.error.details]).toEqual([422, 'PERIOD_LOCKED', { month: LAST }]);
  const outOf = await edit(ops, old, { date: TODAY });
  expect([outOf.status, outOf.body.error.code]).toEqual([422, 'PERIOD_LOCKED']);

  expect(await AuditLog.countDocuments()).toBe(auditsBefore);
  expect((await Expense.findById(open.id).lean()).date).toBe(TODAY);
  expect((await Expense.findById(old.id).lean()).date).toBe(`${LAST}-20`);
});

test('a lock taken during an edit makes the edit retry and refuse', async () => {
  const { ops, branchId } = await world();
  const expense = await added(ops, { date: `${LAST}-20` });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const original = periods.assertPeriodOpen;
  let runs = 0;
  // The edit has read the expense (its snapshot is fixed) when it pauses before checking the month.
  vi.spyOn(periods, 'assertPeriodOpen').mockImplementation(async (...args) => {
    runs += 1;
    if (runs === 1) {
      started();
      await gate;
    }
    return original(...args);
  });
  const write = updateExpense(branchId, expense.id, { version: 0, patch: { note: 'Late' } }, { userId: ops.user._id }).catch((e) => e);
  await running;
  await lockMonth(LAST);
  release();
  expect(await write).toMatchObject({ status: 422, code: 'PERIOD_LOCKED' });
  expect(runs).toBe(2);
  expect((await Expense.findById(expense.id).lean()).note).toBe('');
  expect(await expenseAudits('update')).toHaveLength(0);
});

test('photos can be added and removed on edit', async () => {
  const { ops } = await world();
  const first = await upload(ops);
  const expense = await added(ops, { attachments: [{ key: first, name: 'one.jpg' }] });

  // A new key must be uploaded.
  const { body: pending } = await ops.agent.post('/v1/files/upload-url').send({ purpose: 'expense_bill', contentType: 'image/jpeg', size: 3 });
  const missing = await edit(ops, expense, { attachments: [{ key: first, name: 'one.jpg' }, { key: pending.key, name: 'two.jpg' }] });
  expect([missing.status, missing.body.error.code, missing.body.error.details]).toEqual([400, 'ATTACHMENT_NOT_UPLOADED', { index: 1 }]);
  const foreign = await edit(ops, expense, { attachments: [{ key: 'elsewhere/expense_bill/2026/x.jpg', name: 'x.jpg' }] });
  expect([foreign.status, paths(foreign)]).toEqual([400, ['attachments.0.key']]);

  const second = await upload(ops, { contentType: 'application/pdf' });
  const both = await edit(ops, expense, { attachments: [{ key: first, name: 'renamed.jpg' }, { key: second, name: 'two.pdf' }] });
  ok(both);
  expect(both.body.expense.attachments).toEqual([
    { key: first, name: 'renamed.jpg', contentType: 'image/jpeg', size: 3 },
    { key: second, name: 'two.pdf', contentType: 'application/pdf', size: 3 },
  ]);
  const removed = await edit(ops, both.body.expense, { attachments: [{ key: second, name: 'two.pdf' }] });
  ok(removed);
  expect(removed.body.expense.attachments.map((a) => a.key)).toEqual([second]);
  const last = (await expenseAudits('update')).at(-1);
  expect(JSON.stringify(last.changes)).toContain(first);
});

test('a voided expense keeps its number and refuses changes', async () => {
  const { ops } = await world();
  const expense = await added(ops);
  const voided = await voidIt(ops, expense);
  ok(voided);
  expect(voided.body.expense).toMatchObject({ number: expense.number, status: 'voided', version: 1 });
  const patched = await edit(ops, voided.body.expense, { note: 'After' });
  expect([patched.status, patched.body.error.code, patched.body.error.message]).toEqual([
    422, 'EXPENSE_VOIDED', 'This expense was voided and cannot be changed',
  ]);
  const again = await voidIt(ops, voided.body.expense);
  expect([again.status, again.body.error.code]).toEqual([422, 'ALREADY_VOIDED']);
  expect(await expenseAudits('void')).toHaveLength(1);
});

test('voiding needs a reason and is audited', async () => {
  const { ops } = await world();
  const expense = await added(ops);
  const blank = await voidIt(ops, expense, '  ');
  expect([blank.status, paths(blank)]).toEqual([400, ['reason']]);
  const r = await voidIt(ops, expense, 'Paid by the landlord');
  ok(r);
  expect(r.body.expense.void).toMatchObject({ reason: 'Paid by the landlord', by: { id: String(ops.user._id), name: ops.user.name } });
  expect(new Date(r.body.expense.void.at).getTime()).toBe(NOW.getTime());
  const [audit] = await expenseAudits('void');
  expect(audit.entityId).toBe(expense.id);
  expect(JSON.stringify(audit.changes)).toContain('Paid by the landlord');
});

test('an inactive vendor stays on an old expense but cannot be chosen anew', async () => {
  const { ops, admin, vendor29 } = await world();
  const vendorPayee = { vendorId: vendor29.id, name: '', gstin: null, stateCode: null };
  const old = await added(ops, { payee: vendorPayee, gst: gstBill() });
  const other = await added(ops);
  ok(await admin.agent.patch(`/v1/vendors/${vendor29.id}`).send({ version: vendor29.version, active: false }));

  // The old expense keeps its vendor, and can still be edited (also when the payee is sent unchanged).
  const kept = await edit(ops, old, { note: 'Still fine', payee: vendorPayee });
  ok(kept);
  expect(kept.body.expense.payee).toEqual({ vendorId: vendor29.id, name: 'Bengaluru Silks', gstin: VENDOR_GSTIN, stateCode: '29' });

  // It cannot be chosen for another expense, new or edited.
  const anew = await add(ops, { payee: vendorPayee });
  expect([anew.status, paths(anew)]).toEqual([400, ['payee.vendorId']]);
  const moved = await edit(ops, other, { payee: vendorPayee });
  expect([moved.status, paths(moved)]).toEqual([400, ['payee.vendorId']]);

  // A typed payee replaces the vendor; a GST bill then needs a GSTIN.
  const typed = await edit(ops, kept.body.expense, { payee: { vendorId: null, name: 'Corner shop', gstin: null, stateCode: null } });
  expect([typed.status, paths(typed)]).toEqual([400, ['payee.gstin']]);
});

test("a purchase expense's amount and GST cannot be changed or voided from Expenses", async () => {
  const { ops, vendor29 } = await world();
  const created = await ops.agent.post('/v1/stock/items').set('Idempotency-Key', 'silk').send({
    name: 'Red silk', usageUnit: 'm', purchaseUnit: 'm', factor: 1000,
  });
  ok(created, 201);
  const vendorPayee = { vendorId: vendor29.id, name: '', gstin: null, stateCode: null };
  const received = await ops.agent.post(`/v1/stock/items/${created.body.item.id}/receive`).set('Idempotency-Key', 'delivery').send({
    quantity: 5000, total: 118000, mode: 'upi', payee: vendorPayee, gst: gstBill(),
  });
  ok(received, 201);
  const expense = (await ops.agent.get(`/v1/expenses/${received.body.expense.id}`)).body.expense;
  expect(expense.source).toBe('purchase');

  const refused = [
    { total: 236000, gst: gstBill({ taxable: 200000, cgst: 18000, sgst: 18000 }) },
    { gst: gstBill({ itcEligible: false }) },
    { date: '2026-11-14' },
    { payee: { vendorId: null, name: 'Corner shop', gstin: VENDOR_GSTIN, stateCode: null } },
    { category: 'rent' },
  ];
  for (const fields of refused) {
    const r = await edit(ops, expense, fields);
    expect([r.status, r.body.error?.code], JSON.stringify(fields)).toEqual([422, 'EXPENSE_FROM_STOCK']);
  }
  const voided = await voidIt(ops, expense);
  expect([voided.status, voided.body.error.code]).toEqual([422, 'EXPENSE_FROM_STOCK']);
  expect((await Expense.findById(expense.id).lean()).status).toBe('active');

  // Sending the same amount, payee and GST is not a change; note, photos, mode and reference can change.
  const photo = await upload(ops);
  const r = await edit(ops, expense, {
    total: 118000, payee: vendorPayee, gst: gstBill(), note: 'Silk for the wedding orders',
    attachments: [{ key: photo, name: 'bill.jpg' }], mode: 'cash', reference: 'R-1',
  });
  ok(r);
  expect(r.body.expense).toMatchObject({ note: 'Silk for the wedding orders', mode: 'cash', reference: 'R-1', total: 118000 });
  expect(r.body.expense.attachments).toHaveLength(1);
});
