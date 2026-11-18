import { test, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { addDaysYmd, istDate } from '@vs/shared';
import { monthName } from '@vs/shared/reports/catalog.js';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { importHelpers, xlsx } from './helpers/imports.js';
import { clock } from '../src/clock.js';
import { AuditLog } from '../src/core/audit/model.js';
import { runMigrations } from '../src/core/migrations.js';
import { MIGRATIONS } from '../src/migrations/index.js';
import { BillingDocument, Receipt } from '../src/modules/billing/model.js';
import { dayCollectionsFilter } from '../src/modules/billing/daily.js';
import { receivablesFilter } from '../src/modules/billing/ledger.js';
import { documentsFilter, periodMoney } from '../src/modules/billing/reports.js';
import { recordOpeningBalance } from '../src/modules/billing/service.js';

useTestDb();
afterEach(() => vi.restoreAllMocks());
const app = buildTestApp();
const billing = billingHelpers(app);
const imports = importHelpers(app);
const today = () => istDate(clock.now());
const HEAD = ['Customer phone', 'Amount owed', 'Advance held', 'Old order no.', 'Note'];
const quiet = { info() {}, error() {} };

async function world() {
  const w = await billing.world();
  const branchId = String(w.admin.user.branchId);
  const actor = { userId: w.admin.user._id, ip: null, userAgent: 'test' };
  const bringIn = async (rows, asOf = today()) => {
    const run = await imports.check(w.admin, 'opening_balances', await xlsx([HEAD, ...rows]), { asOf });
    return imports.add(w.admin, run);
  };
  return { ...w, branchId, actor, bringIn };
}

test('opening balances never take a GST number or reach GST figures', async () => {
  const { bringIn, branchId, admin } = await world();
  const done = await bringIn([['9876543210', '5,000', '2000', '', 'From the old book']]);
  expect(done.counts.added).toBe(1);
  const docs = await BillingDocument.find({}).lean();
  expect(docs.map((d) => [d.type, d.number.split('/')[0], d.opening ?? false]).sort()).toEqual([
    ['opening_balance', 'OB', false],
    ['receipt', 'OA', true],
  ]);
  const counters = await mongoose.connection.collection('counters').find({ _id: /^doc:/ }).toArray();
  expect(counters.map((c) => c._id.split(':')[2]).sort()).toEqual(['opening_advance', 'opening_balance']);
  const range = { from: addDaysYmd(today(), -40), to: today() };
  expect(await periodMoney(branchId, range)).toMatchObject({ billed: 0, collected: 0, receipts: 0, invoices: 0 });
  expect(await BillingDocument.countDocuments(documentsFilter(branchId, { types: ['invoice', 'credit_note', 'receipt_voucher', 'refund', 'receipt'], ...range }))).toBe(0);
  expect((await admin.agent.get('/v1/billing/payments')).body.items).toEqual([]);
  expect(await Receipt.countDocuments(dayCollectionsFilter(branchId, today()))).toBe(0);
  const receipt = docs.find((d) => d.type === 'receipt');
  expect(receipt).toMatchObject({ mode: null, receiptVoucherId: null, pdf: { status: 'none' } });
});

test('an opening balance is owed, ages and can be paid', async () => {
  const { bringIn, admin, customerId } = await world();
  const asOf = addDaysYmd(today(), -10);
  await bringIn([['9876543210', 5000, '', '', '']], asOf);
  const summary = (await admin.agent.get(`/v1/billing/customers/${customerId}/summary`)).body;
  expect(summary).toMatchObject({ outstanding: 500000, overdue: 500000, billed: 0, received: 0 });
  const owed = (await admin.agent.get('/v1/billing/receivables').query({ bucket: 'overdue' })).body;
  expect(owed.items).toHaveLength(1);
  expect(owed.items[0]).toMatchObject({ type: 'opening_balance', invoice: { balance: 500000, dueDate: asOf } });
  const paid = await billing.pay(admin, { customerId, amount: 300000, mode: 'cash' });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const ob = await BillingDocument.findOne({ type: 'opening_balance' }).lean();
  expect(ob.settlement).toMatchObject({ paid: 300000, balance: 200000 });
  expect((await admin.agent.get(`/v1/billing/customers/${customerId}/summary`)).body).toMatchObject({ outstanding: 200000, received: 300000, advanceHeld: 0 });
});

test('an opening advance is held and used by the next bill', async () => {
  const { branchId, actor, customerId, takeOrder, admin } = await world();
  const order = await takeOrder({ prices: [450000] });
  await recordOpeningBalance(branchId, { customerId, owed: 0, advance: 200000, asOf: today(), note: '', orderId: order.id }, actor);
  expect((await admin.agent.get(`/v1/billing/customers/${customerId}/summary`)).body).toMatchObject({ advanceHeld: 200000, received: 0 });
  const draft = await billing.draftFor(order, admin);
  const issued = await billing.issue(admin, draft);
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const bill = await BillingDocument.findOne({ type: 'invoice' }).lean();
  expect(bill.settlement.advanceApplied).toBe(200000);
  expect(bill.advanceAdjustments).toEqual([]);
});

test('the ledger labels opening balances plainly', async () => {
  const { bringIn, admin, customerId } = await world();
  const asOf = addDaysYmd(today(), -3);
  await bringIn([['9876543210', 5000, 2000, '', '']], asOf);
  const { items } = (await admin.agent.get(`/v1/billing/customers/${customerId}/ledger`)).body;
  const day = new Date(`${asOf}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  expect(items.map((i) => [i.label, i.debit, i.credit, i.opening]).sort()).toEqual([
    [`Advance held before ${day} (opening balance)`, 0, 200000, true],
    [`Owed before ${day} (opening balance)`, 500000, 0, true],
  ]);
  expect(items[0].balance).toBe(300000);
});

test('one opening balance per customer', async () => {
  const { bringIn, branchId, actor, customerId, admin } = await world();
  await bringIn([['9876543210', 5000, '', '', '']]);
  const again = await imports.check(admin, 'opening_balances', await xlsx([HEAD, ['9876543210', 100, '', '', '']]), { asOf: today() });
  expect(again.counts).toMatchObject({ exists: 1, ready: 0 });
  await expect(recordOpeningBalance(branchId, { customerId, owed: 100, advance: 0, asOf: today(), note: '' }, actor))
    .rejects.toMatchObject({ status: 409, code: 'OPENING_EXISTS' });
  const unknown = await imports.check(admin, 'opening_balances', await xlsx([HEAD, ['9000000009', 100, '', '', '']]), { asOf: today() });
  expect((await imports.rows(admin, unknown.id, 'error'))[0].errors[0]).toEqual({ column: 'Customer phone', message: 'No customer with phone 9000000009 — bring in customers first.' });
});

test('opening balances respect month locks and are dated the cut-over day', async () => {
  const { admin, branchId, actor, customerId } = await world();
  const lastMonthEnd = addDaysYmd(`${today().slice(0, 7)}-01`, -1);
  const locked = await admin.agent.post(`/v1/period-locks/${lastMonthEnd.slice(0, 7)}/lock`).send({ note: 'Filed' });
  expect(locked.status, JSON.stringify(locked.body)).toBe(200);
  // The preview says so before anything is confirmed.
  const run = await imports.check(admin, 'opening_balances', await xlsx([HEAD, ['9876543210', 5000, '', '', '']]), { asOf: lastMonthEnd });
  expect(run.counts).toMatchObject({ ready: 0, error: 1 });
  const [row] = await imports.rows(admin, run.id, 'error');
  expect(row.errors).toEqual([{ column: null, message: `${monthName(lastMonthEnd.slice(0, 7))} is locked for filing. Choose a cut-over date in an open month, or unlock the month.` }]);
  await expect(recordOpeningBalance(branchId, { customerId, owed: 100, advance: 0, asOf: addDaysYmd(today(), 1), note: '' }, actor))
    .rejects.toMatchObject({ code: 'DATE_IN_FUTURE' });
  const ok = await recordOpeningBalance(branchId, { customerId, owed: 100, advance: 0, asOf: today(), note: '' }, actor);
  expect(ok.openingBalance).toMatchObject({ date: today(), dueDate: today(), month: today().slice(0, 7) });
  const future = await imports.upload(admin, await xlsx([HEAD, ['9876543210', 1, '', '', '']]));
  const r = await imports.start(admin, 'opening_balances', future, { asOf: addDaysYmd(today(), 3) });
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('DATE_IN_FUTURE');
});

test('a mistaken opening balance is cancelled and brought in again', async () => {
  const { bringIn, admin, customerId } = await world();
  await bringIn([['9876543210', 5000, 2000, '', '']]);
  const ob = await BillingDocument.findOne({ type: 'opening_balance' }).lean();
  const r = await admin.agent.post(`/v1/billing/opening-balances/${ob._id}/cancel`).send({ version: ob.__v, reason: 'Wrong amount' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect((await BillingDocument.find({ status: 'cancelled' }).lean()).map((d) => d.type).sort()).toEqual(['opening_balance', 'receipt']);
  expect(await AuditLog.countDocuments({ entityType: 'opening_balance', action: 'cancel' })).toBe(1);
  expect((await admin.agent.get(`/v1/billing/customers/${customerId}/summary`)).body).toMatchObject({ outstanding: 0, advanceHeld: 0 });
  const again = await bringIn([['9876543210', 4000, '', '', '']]);
  expect(again.counts.added).toBe(1);
  expect((await admin.agent.get(`/v1/billing/customers/${customerId}/summary`)).body.outstanding).toBe(400000);
});

test('an opening balance with payments cannot be cancelled', async () => {
  const { bringIn, admin, customerId, ops } = await world();
  await bringIn([['9876543210', 5000, '', '', '']]);
  await billing.pay(admin, { customerId, amount: 100000, mode: 'upi' });
  const ob = await BillingDocument.findOne({ type: 'opening_balance' }).lean();
  const r = await admin.agent.post(`/v1/billing/opening-balances/${ob._id}/cancel`).send({ version: ob.__v, reason: 'x' });
  expect(r.status).toBe(422);
  expect(r.body.error).toMatchObject({ code: 'OPENING_IN_USE', message: 'Payments are already set against this balance' });
  expect((await ops.agent.post(`/v1/billing/opening-balances/${ob._id}/cancel`).send({ version: ob.__v, reason: 'x' })).status).toBe(403);
});

test('the receivables index is used and the old one is dropped by the migration', async () => {
  const { branchId } = await world();
  const docs = mongoose.connection.collection('billingDocuments');
  await BillingDocument.createIndexes();
  const plan = await docs.find(receivablesFilter(branchId, { bucket: 'overdue' })).explain('queryPlanner');
  expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
  expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('receivables_v2');
  await docs.createIndex({ branchId: 1, type: 1, status: 1, dueDate: 1 }, { name: 'receivables', partialFilterExpression: { type: 'invoice', 'settlement.balance': { $gt: 0 } } });
  const { applied } = await runMigrations({ models: [], migrations: MIGRATIONS, log: quiet });
  expect(applied).toEqual(['001-billing-receivables-index']);
  expect((await docs.indexes()).map((i) => i.name)).not.toContain('receivables');
  expect((await runMigrations({ models: [], migrations: MIGRATIONS, log: quiet })).applied).toEqual([]);
});
