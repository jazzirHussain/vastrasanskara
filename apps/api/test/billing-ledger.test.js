import { test, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { addDaysYmd } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { today } from './helpers/production.js';
import { clock } from '../src/clock.js';
import { Branch } from '../src/modules/branches/model.js';
import { Garment } from '../src/modules/orders/model.js';
import { BillingDocument, Invoice } from '../src/modules/billing/model.js';
import { ledgerFilter, receivablesFilter } from '../src/modules/billing/ledger.js';

useTestDb();
const app = buildTestApp();
const { world, draftFor, issue, pay } = billingHelpers(app);

afterEach(() => vi.restoreAllMocks());

let keys = 0;
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
// Noon IST on the given day.
const on = (ymd) => vi.spyOn(clock, 'now').mockReturnValue(new Date(`${ymd}T06:30:00.000Z`));
// Fixed when the file loads: today() follows the mocked clock.
const TODAY = today();
const ago = (n) => addDaysYmd(TODAY, -n);

const credit = (who, bill, taxable) =>
  who.agent
    .post(`/v1/billing/invoices/${bill.id}/credit-notes`)
    .set('Idempotency-Key', `lc${++keys}`)
    .send({ reason: 'Price reduced', lines: [{ key: bill.lines[0].key, taxable }] });
const issued = async (ops, order) => {
  const r = await issue(ops, await draftFor(order));
  ok(r);
  return r.body.invoice;
};
const get = async (who, path) => {
  const r = await who.agent.get(`/v1/billing${path}`);
  ok(r, 200);
  return r.body;
};

/** A bill of ₹5,040 issued on day 1, ₹2,000 paid on day 2, a credit note on day 3. */
async function history() {
  const w = await world();
  const order = await w.takeOrder({ prices: [450000] });
  on(ago(5));
  const bill = await issued(w.ops, order);
  on(ago(4));
  const receipt = (await pay(w.ops, { customerId: w.customerId, invoiceId: bill.id, amount: 200000, mode: 'cash' })).body.receipt;
  on(ago(3));
  const note = await credit(w.admin, bill, 10000);
  ok(note);
  return { ...w, order, bill, receipt, note: note.body.creditNote };
}

test('the ledger lists every money document newest first with a running balance', async () => {
  const { ops, customerId, bill, receipt, note } = await history();
  const { items, nextCursor } = await get(ops, `/customers/${customerId}/ledger`);
  expect(nextCursor).toBeNull();
  expect(items.map((i) => [i.type, i.number, i.date])).toEqual([
    ['credit_note', note.number, ago(3)],
    ['receipt', receipt.number, ago(4)],
    ['invoice', bill.number, ago(5)],
  ]);
  const billed = bill.totals.total;
  expect(items[2]).toMatchObject({ id: bill.id, debit: billed, credit: 0, balance: billed, status: 'issued' });
  expect(items[1]).toMatchObject({ debit: 0, credit: 200000, balance: billed - 200000 });
  expect(items[0]).toMatchObject({ debit: 0, credit: note.totals.total, balance: billed - 200000 - note.totals.total });
  expect(items.every((i) => typeof i.label === 'string' && i.label)).toBe(true);
});

test('ledger pages carry the right balance across the cursor', async () => {
  const { ops, customerId, bill } = await history();
  // Three payments on one day, so the page boundary falls between entries with the same date.
  on(ago(2));
  for (let i = 0; i < 2; i += 1) {
    ok(await pay(ops, { customerId, invoiceId: bill.id, amount: 1000 * (i + 1), mode: 'upi' }));
  }
  const all = (await get(ops, `/customers/${customerId}/ledger?limit=100`)).items;
  expect(all).toHaveLength(5);

  const seen = [];
  let cursor = null;
  const sizes = [];
  do {
    const page = await get(ops, `/customers/${customerId}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    sizes.push(page.items.length);
    seen.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  expect(sizes).toEqual([2, 2, 1]);
  expect(seen).toEqual(all);
  expect(all.at(-1).balance).toBe(bill.totals.total);
  expect(all[0].balance).toBe(all.reduce((s, i) => s + i.debit - i.credit, 0));
});

test('cancelled documents show but count for nothing', async () => {
  const { ops, admin, customerId, bill, receipt, take } = await history();
  const cancel = (path) => admin.agent.post(path).send({ reason: 'Entered by mistake' });
  const mistake = await issued(ops, await take());
  ok(await cancel(`/v1/billing/invoices/${mistake.id}/cancel`), 200);
  ok(await cancel(`/v1/billing/payments/${receipt.id}/cancel`), 200);

  const { items } = await get(ops, `/customers/${customerId}/ledger`);
  expect(items.find((i) => i.id === mistake.id)).toMatchObject({ status: 'cancelled', debit: 0, credit: 0 });
  expect(items.find((i) => i.id === receipt.id)).toMatchObject({ status: 'cancelled', debit: 0, credit: 0 });
  const noteCredit = items.find((i) => i.type === 'credit_note').credit;
  expect(items[0].balance).toBe(bill.totals.total - noteCredit);
  expect(await get(ops, `/customers/${customerId}/summary`)).toMatchObject({
    billed: bill.totals.total, received: 0, credited: noteCredit, advanceHeld: 0,
  });
});

test('the summary agrees with the ledger', async () => {
  const { ops, admin, customerId, bill, note, take } = await history();
  // An advance on an order not yet billed, then a refund of part of it.
  const order = await take();
  ok(await pay(ops, { customerId, orderId: order.id, amount: 100000, mode: 'cash' }));
  const refund = await admin.agent
    .post('/v1/billing/refunds')
    .set('Idempotency-Key', `lr${++keys}`)
    .send({ customerId, orderId: order.id, amount: 30000, mode: 'cash', reason: 'Not needed' });
  ok(refund);
  const summary = await get(ops, `/customers/${customerId}/summary`);
  const { items } = await get(ops, `/customers/${customerId}/ledger?limit=100`);
  const debit = items.reduce((s, i) => s + i.debit, 0);
  const creditSum = items.reduce((s, i) => s + i.credit, 0);
  expect(summary).toMatchObject({
    billed: bill.totals.total,
    received: 300000,
    credited: note.totals.total,
    refunded: 30000,
    advanceHeld: 70000,
  });
  expect(summary.billed - summary.received - summary.credited + summary.refunded).toBe(debit - creditSum);
  expect(items[0].balance).toBe(debit - creditSum);
  // The bill is past its due date (due the day it was made, five days ago).
  expect(summary.outstanding).toBe(bill.totals.total - 200000 - note.totals.total);
  expect(summary.overdue).toBe(summary.outstanding);
});

test('money owed lists the oldest due first with days overdue and buckets', async () => {
  const w = await world();
  const second = (await w.ops.agent.post('/v1/customers').send({ name: 'Bina Shah', phone: '9123456780' })).body.id;
  const bills = [];
  for (const [days, customer] of [[45, w.customerId], [10, second], [70, w.customerId], [0, second], [100, second]]) {
    on(ago(days));
    const order = await w.take({ customer });
    bills.push({ days, bill: (await issued(w.ops, order)) });
  }
  vi.restoreAllMocks();
  const { items, totals, nextCursor } = await get(w.ops, '/receivables?limit=100');
  expect(nextCursor).toBeNull();
  expect(items.map((i) => [i.daysOverdue, i.bucket])).toEqual([
    [100, 'd90_plus'], [70, 'd61_90'], [45, 'd31_60'], [10, 'd0_30'], [0, 'not_due'],
  ]);
  expect(items[0]).toMatchObject({
    invoice: { id: bills[4].bill.id, number: bills[4].bill.number, dueDate: ago(100) },
    customer: { id: second, name: 'Bina Shah' },
  });
  expect(totals.count).toBe(5);

  const page1 = await get(w.ops, '/receivables?limit=2');
  const page2 = await get(w.ops, `/receivables?limit=2&cursor=${page1.nextCursor}`);
  expect([...page1.items, ...page2.items].map((i) => i.daysOverdue)).toEqual([100, 70, 45, 10].slice(0, 4));
  expect((await get(w.ops, `/receivables?customerId=${w.customerId}`)).items.map((i) => i.daysOverdue)).toEqual([70, 45]);
  expect((await get(w.ops, '/receivables?bucket=d31_60')).items.map((i) => i.daysOverdue)).toEqual([45]);
});

test('the overdue filter and totals', async () => {
  const w = await world();
  const each = [];
  for (const days of [40, 5, 0]) {
    on(ago(days));
    each.push(await issued(w.ops, await w.take()));
  }
  vi.restoreAllMocks();
  const total = each[0].totals.total;
  const overdue = await get(w.ops, '/receivables?bucket=overdue');
  expect(overdue.items.map((i) => i.daysOverdue)).toEqual([40, 5]);
  expect(overdue.totals).toEqual({ count: 2, balance: 2 * total, overdue: 2 * total });
  const all = await get(w.ops, '/receivables?limit=1');
  expect(all.items).toHaveLength(1);
  expect(all.totals).toEqual({ count: 3, balance: 3 * total, overdue: 2 * total });

  // A part payment lowers the balance; a settled bill drops out.
  ok(await pay(w.ops, { customerId: w.customerId, invoiceId: each[0].id, amount: 1000, mode: 'cash' }));
  ok(await pay(w.ops, { customerId: w.customerId, invoiceId: each[2].id, amount: total, mode: 'cash' }));
  const after = await get(w.ops, '/receivables');
  expect(after.items.map((i) => i.invoice.balance)).toEqual([total - 1000, total]);
  expect(after.totals).toEqual({ count: 2, balance: 2 * total - 1000, overdue: 2 * total - 1000 });
});

test('order money shows what is due, held and billed', async () => {
  const w = await world();
  ok(await w.admin.agent.put('/v1/settings').send({ advancePercent: 50 }), 200);
  const order = await w.takeOrder({ prices: [450000] });
  const first = await get(w.ops, `/orders/${order.id}/summary`);
  expect(first).toMatchObject({
    orderValue: 450000, estimatedTotal: 504000, advanceDue: 225000, advanceHeld: 0, billed: 0, balanceDue: 0,
    draftInvoiceId: null, invoices: [], receipts: [], refundSuggestion: null, hasUnbilled: true,
  });

  const paid = (await pay(w.ops, { customerId: w.customerId, orderId: order.id, amount: 100000, mode: 'cash' })).body.receipt;
  const draft = await draftFor(order);
  const mid = await get(w.ops, `/orders/${order.id}/summary`);
  expect(mid).toMatchObject({ advanceDue: 125000, advanceHeld: 100000, billed: 0, draftInvoiceId: draft.id, hasUnbilled: true });
  expect(mid.receipts).toEqual([{ id: paid.id, number: paid.number, date: today(), amount: 100000, status: 'issued' }]);

  const bill = (await issue(w.ops, draft)).body.invoice;
  const after = await get(w.ops, `/orders/${order.id}/summary`);
  expect(after).toMatchObject({
    advanceDue: 125000, advanceHeld: 0, billed: bill.totals.total, balanceDue: bill.totals.total - 100000, draftInvoiceId: null, hasUnbilled: false,
  });
  expect(after.invoices).toEqual([{ id: bill.id, number: bill.number, status: 'issued', total: bill.totals.total, balance: bill.totals.total - 100000 }]);
  expect((await w.ops.agent.get(`/v1/billing/orders/${new mongoose.Types.ObjectId()}/summary`)).status).toBe(404);
});

test('order money says whether anything is left to bill', async () => {
  const w = await world();
  const unbilled = async (order) => (await get(w.ops, `/orders/${order.id}/summary`)).hasUnbilled;

  // Only rejected or cancelled garments remain: nothing to bill.
  const dead = await w.takeOrder({ prices: [100000, 200000] });
  await Garment.updateMany({ _id: { $in: dead.garments.map((g) => g.id) } }, { status: 'cancelled' });
  expect(await unbilled(dead)).toBe(false);

  // One garment billed, one not: still something to bill.
  const part = await w.takeOrder({ prices: [100000, 200000] });
  const second = await Garment.findById(part.garments[1].id).lean();
  await Garment.updateOne({ _id: second._id }, { status: 'cancelled' });
  await issued(w.ops, part);
  expect(await unbilled(part)).toBe(false);
  await Garment.updateOne({ _id: second._id }, { status: second.status });
  expect(await unbilled(part)).toBe(true);

  // Every garment billed, but a rush fee not yet billed (the price list gained it later).
  const rush = await w.takeOrder({ priority: 'rush' });
  await issued(w.ops, rush);
  expect(await unbilled(rush)).toBe(false);
  await w.addItem({
    name: 'Rush charge', kind: 'extra_charge', supplyType: 'service', hsnSac: '998821', defaultPrice: 100000,
    gstSlabs: [{ upToUnitPrice: null, rateBp: 1800 }], chargeFor: 'rush',
  });
  expect(await unbilled(rush)).toBe(true);
});

test('bill and payment lists filter by customer, status and date', async () => {
  const w = await world();
  const second = (await w.ops.agent.post('/v1/customers').send({ name: 'Bina Shah', phone: '9123456780' })).body.id;
  on(ago(10));
  const a = await issued(w.ops, await w.take());
  on(ago(2));
  const b = await issued(w.ops, await w.take({ customer: second }));
  const c = await issued(w.ops, await w.take());
  vi.restoreAllMocks();
  const draft = await draftFor(await w.take({ customer: second }));
  ok(await pay(w.ops, { customerId: w.customerId, invoiceId: a.id, amount: a.totals.total, mode: 'cash' }));
  ok(await pay(w.ops, { customerId: second, invoiceId: b.id, amount: 5000, mode: 'upi' }));
  ok(await w.admin.agent.post(`/v1/billing/invoices/${c.id}/cancel`).send({ reason: 'Wrong customer' }), 200);

  const list = async (q) => (await get(w.ops, `/invoices${q}`)).items;
  expect((await list('')).map((i) => i.id)).toEqual([c.id, b.id, a.id]);
  expect((await list(`?customerId=${second}`)).map((i) => i.id)).toEqual([b.id]);
  expect((await list('?status=cancelled')).map((i) => i.id)).toEqual([c.id]);
  expect((await list('?status=draft')).map((i) => i.id)).toEqual([draft.id]);
  expect((await list(`?from=${ago(3)}&to=${ago(1)}`)).map((i) => i.id)).toEqual([c.id, b.id]);
  expect((await list('?payStatus=paid')).map((i) => i.id)).toEqual([a.id]);
  expect((await list('?payStatus=part_paid')).map((i) => i.id)).toEqual([b.id]);
  expect((await list('?overdue=true')).map((i) => i.id)).toEqual([b.id]);
  expect((await list(`?q=${b.number.slice(-4)}`)).map((i) => i.id)).toEqual([b.id]);
  expect((await list(`?orderId=${b.order.id}`)).map((i) => i.id)).toEqual([b.id]);
  expect((await list('')).find((i) => i.id === b.id)).toEqual({
    id: b.id, status: 'issued', number: b.number, date: ago(2), dueDate: ago(2),
    customer: { id: second, name: 'Bina Shah' }, order: { id: b.order.id, orderNo: b.order.orderNo },
    total: b.totals.total, balance: b.totals.total - 5000, payStatus: 'part_paid', overdue: true,
  });
  const twoPages = [(await get(w.ops, '/invoices?limit=2')), null];
  twoPages[1] = await get(w.ops, `/invoices?limit=2&cursor=${twoPages[0].nextCursor}`);
  expect([...twoPages[0].items, ...twoPages[1].items].map((i) => i.id)).toEqual([c.id, b.id, a.id]);
  expect(twoPages[1].nextCursor).toBeNull();

  const pays = async (q) => (await get(w.ops, `/payments${q}`)).items;
  expect(await pays('')).toHaveLength(2);
  expect((await pays(`?customerId=${second}`))[0]).toMatchObject({
    status: 'issued', amount: 5000, mode: 'upi', customer: { id: second, name: 'Bina Shah' },
  });
  expect((await pays('?mode=cash')).map((p) => p.amount)).toEqual([a.totals.total]);
  expect(await pays(`?from=${addDaysYmd(TODAY, 1)}`)).toEqual([]);
});

test('designers cannot read money', async () => {
  const { d1, customerId } = await world();
  const id = new mongoose.Types.ObjectId();
  for (const path of [
    `/customers/${customerId}/summary`,
    `/customers/${customerId}/ledger`,
    '/receivables',
    `/orders/${id}/summary`,
    '/invoices',
    '/payments',
  ]) {
    const r = await d1.agent.get(`/v1/billing${path}`);
    expect([path, r.status]).toEqual([path, 403]);
  }
});

test('money queries use indexes', async () => {
  const { customerId } = await world();
  const branchId = (await Branch.findOne())._id;
  const plans = await Promise.all([
    BillingDocument.find(ledgerFilter(branchId, customerId)).sort({ date: -1, _id: -1 }).explain('queryPlanner'),
    Invoice.find(receivablesFilter(branchId, { bucket: 'overdue' })).sort({ dueDate: 1, _id: 1 }).explain('queryPlanner'),
    Invoice.find({ branchId, type: 'invoice', status: { $in: ['issued', 'cancelled'] } }).sort({ date: -1, _id: -1 }).explain('queryPlanner'),
    Invoice.find({ branchId, type: 'invoice', status: 'draft' }).sort({ updatedAt: -1, _id: -1 }).explain('queryPlanner'),
  ]);
  for (const plan of plans) {
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
  }
});
