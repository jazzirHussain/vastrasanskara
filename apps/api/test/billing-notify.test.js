import { test, expect, vi, afterEach } from 'vitest';
import { addDaysYmd, atIstTime } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { today } from './helpers/production.js';
import { Outbox } from '../src/core/notify/models.js';
import { Customer } from '../src/modules/customers/model.js';
import { Settings } from '../src/modules/settings/model.js';
import { Branch } from '../src/modules/branches/model.js';
import { Invoice } from '../src/modules/billing/model.js';
import { runDailyBillingChecks } from '../src/modules/billing/daily.js';

useTestDb();
const app = buildTestApp();
const { world, draftFor, issue, pay } = billingHelpers(app);

afterEach(() => vi.restoreAllMocks());

const TODAY = today();
const rows = (event) => Outbox.find({ event }).sort({ _id: 1 }).lean();
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const at = (hhmm, ymd = TODAY) => atIstTime(ymd, hhmm);
const run = (hhmm, ymd) => runDailyBillingChecks({ now: at(hhmm, ymd) });
const dueOf = async (bill) => (await Invoice.findById(bill.id).lean()).dueDate;

async function setup({ consent = true } = {}) {
  const w = await world();
  if (consent) {
    await Customer.updateOne({ _id: w.customerId }, { email: 'asha@example.com', consent: { email: true, whatsapp: false, sms: false } });
  }
  return w;
}
async function issued(w, prices = [450000]) {
  const order = await w.takeOrder({ prices });
  const r = await issue(w.ops, await draftFor(order));
  ok(r);
  return { order, bill: r.body.invoice };
}

test('issuing emails the client the bill PDF once it can be ready', async () => {
  const w = await setup();
  const before = Date.now();
  const { bill } = await issued(w);
  const [row] = await rows('invoice.issued');
  expect(row).toMatchObject({ channel: 'email', status: 'pending', recipient: { name: 'Asha Rao' } });
  const stored = await Invoice.findById(bill.id).lean();
  expect(row.attachments.map((a) => ({ key: a.key, filename: a.filename }))).toEqual([
    { key: stored.pdf.key, filename: `${bill.number.replace(/\//g, '-')}.pdf` },
  ]);
  expect(row.scheduledFor.getTime()).toBeGreaterThanOrEqual(before + 2 * 60_000 - 1000);
  expect(row.vars).toMatchObject({ invoiceNo: bill.number, customerName: 'Asha Rao' });
  expect(JSON.stringify(row.vars)).not.toContain(bill.id);
});

test('the first advance confirms the order with the receipt attached; a second payment does not', async () => {
  const w = await setup();
  const order = await w.takeOrder();
  const first = await pay(w.ops, { customerId: w.customerId, orderId: order.id, amount: 100000, mode: 'cash' });
  ok(first);
  let sent = await rows('order.confirmed');
  expect(sent).toHaveLength(1);
  expect(sent[0].vars).toMatchObject({ orderNo: order.orderNo, receiptNo: first.body.receipt.number, customerName: 'Asha Rao' });
  expect(sent[0].attachments.length).toBeGreaterThanOrEqual(1);
  ok(await pay(w.ops, { customerId: w.customerId, orderId: order.id, amount: 50000, mode: 'upi' }));
  sent = await rows('order.confirmed');
  expect(sent).toHaveLength(1);
});

test('a client without email consent is skipped', async () => {
  const w = await setup({ consent: false });
  await issued(w);
  const [row] = await rows('invoice.issued');
  expect(row).toMatchObject({ status: 'skipped', skipReason: 'no_consent' });
});

test('a failed issue queues nothing', async () => {
  const w = await setup();
  const order = await w.takeOrder();
  const draft = await draftFor(order);
  await Branch.updateOne({}, { gstin: null });
  const r = await issue(w.ops, draft);
  expect(r.status).toBe(422);
  expect(await Outbox.countDocuments({ event: 'invoice.issued' })).toBe(0);
});

test('reminders go the day after due, then weekly, four at most', async () => {
  const w = await setup();
  const { bill } = await issued(w);
  const due = await dueOf(bill);
  const seen = [];
  for (const d of [1, 2, 8, 15, 22, 29]) {
    await run('10:00', addDaysYmd(due, d));
    seen.push((await rows('invoice.overdue')).length);
  }
  expect(seen).toEqual([1, 1, 2, 3, 4, 4]);
  const all = await rows('invoice.overdue');
  expect(all.map((r) => r.dedupeKey.split(':')[2])).toEqual(['1', '2', '3', '4']);
  expect(all[0].vars).toMatchObject({ invoiceNo: bill.number, days: 1 });
  expect(JSON.stringify(all[0].vars)).not.toContain(bill.id);
});

test('nothing goes before 10:00', async () => {
  const w = await setup();
  const { bill } = await issued(w);
  await run('09:45', addDaysYmd(await dueOf(bill), 1));
  expect(await Outbox.countDocuments({ event: { $in: ['invoice.overdue', 'invoice.overdue_digest'] } })).toBe(0);
});

test('paused reminders are skipped and resume', async () => {
  const w = await setup();
  const { bill } = await issued(w);
  const day = addDaysYmd(await dueOf(bill), 1);
  const put = (paused) => w.admin.agent.put(`/v1/billing/invoices/${bill.id}/reminders`).send({ paused });
  ok(await put(true), 200);
  await run('10:00', day);
  expect(await rows('invoice.overdue')).toHaveLength(0);
  expect((await rows('invoice.overdue_digest')).length).toBeGreaterThan(0);
  ok(await put(false), 200);
  await run('10:15', day);
  expect(await rows('invoice.overdue')).toHaveLength(1);
});

test('paid bills get no reminder', async () => {
  const w = await setup();
  const { bill } = await issued(w);
  ok(await pay(w.ops, { customerId: w.customerId, invoiceId: bill.id, amount: bill.totals.total, mode: 'cash' }));
  expect((await run('10:00', addDaysYmd(await dueOf(bill), 1))).queued).toBe(0);
  expect(await Outbox.countDocuments({ event: { $in: ['invoice.overdue', 'invoice.overdue_digest'] } })).toBe(0);
});

test('operations get one overdue digest a day', async () => {
  const w = await setup();
  const a = await issued(w);
  await issued(w, [200000]);
  const due = await dueOf(a.bill);
  await run('10:00', addDaysYmd(due, 1));
  await run('11:00', addDaysYmd(due, 1));
  const digest = await rows('invoice.overdue_digest');
  expect(digest.map((r) => [r.recipient.id, r.channel].join(':')).sort()).toEqual(
    [`${w.ops.user._id}:email`, `${w.ops.user._id}:in_app`].sort(),
  );
  expect(digest[0].vars).toMatchObject({ count: 2, link: '/bills?tab=owed&bucket=overdue' });
  expect(digest[0].vars.list).toContain(a.bill.number);
  await run('10:00', addDaysYmd(due, 2));
  expect(await rows('invoice.overdue_digest')).toHaveLength(4);
});

test('the collections summary waits for closing time and goes once', async () => {
  const w = await setup();
  const { bill } = await issued(w);
  ok(await pay(w.ops, { customerId: w.customerId, invoiceId: bill.id, amount: 100000, mode: 'cash' }));
  ok(await pay(w.ops, { customerId: w.customerId, invoiceId: bill.id, amount: 50000, mode: 'upi' }));
  expect((await run('19:59')).queued).toBe(0);
  expect(await rows('billing.collections_summary')).toHaveLength(0);
  await run('20:00');
  const sent = await rows('billing.collections_summary');
  expect(sent.map((r) => r.recipient.id)).toEqual([String(w.admin.user._id), String(w.admin.user._id)]);
  expect(sent[0].vars).toMatchObject({ count: 2, total: '₹1,500.00', link: '/bills?tab=payments', refunds: 'None' });
  expect(sent[0].vars.byMode).toContain('Cash: ₹1,000.00 (1)');
  expect(sent[0].vars.byMode).toContain('UPI: ₹500.00 (1)');
  expect((await run('20:15')).queued).toBe(0);
});

test('a later closing time is respected and a quiet day still gets a summary', async () => {
  const w = await setup();
  await Settings.updateOne({ branchId: (await Branch.findOne())._id }, { $set: { 'values.closingTime': '21:00' } }, { upsert: true });
  await run('20:30');
  expect(await rows('billing.collections_summary')).toHaveLength(0);
  await run('21:00');
  const [row] = await rows('billing.collections_summary');
  expect(row.vars).toMatchObject({ count: 0, total: '₹0.00', byMode: 'No payments today' });
  expect(w.admin).toBeTruthy();
});

test('only admins pause reminders', async () => {
  const w = await setup();
  const { bill } = await issued(w);
  const r = await w.ops.agent.put(`/v1/billing/invoices/${bill.id}/reminders`).send({ paused: true });
  expect(r.status).toBe(403);
});
