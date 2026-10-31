import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { addDaysYmd } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { expenseHelpers } from './helpers/expenses.js';
import { clock } from '../src/clock.js';
import { Expense } from '../src/modules/expenses/model.js';
import {
  expenseCostTotal,
  expenseTotalsByCategory,
  inputTaxSummary,
  monthSummary,
} from '../src/modules/expenses/service.js';
import {
  activeMatch,
  expenseListFilter,
  listExpenses,
  monthFacetPipeline,
  recentPayees,
} from '../src/modules/expenses/queries.js';

useTestDb();
const app = buildTestApp();
const { world, upload, add, lockMonth } = expenseHelpers(app);

// "Now" is 15 Nov 2026 (IST): the default month is November 2026.
const NOW = new Date('2026-11-15T06:00:00Z');
const NOV = '2026-11';
const OCT = '2026-10';
beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

let keys = 0;
const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const gstBill = (fields = {}) => ({
  billNo: 'INV-1', billDate: '2026-11-02', rateBp: 1800, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, itcEligible: true, ...fields,
});

async function added(who, body) {
  const r = await add(who, body);
  ok(r, 201);
  return r.body.expense;
}
const list = (who, query = '') => who.agent.get(`/v1/expenses${query}`);
const numbers = (r) => r.body.items.map((i) => i.number.split('/').pop());

test('the list shows a month newest first and pages without repeats', async () => {
  const { ops } = await world();
  for (const date of ['2026-11-01', '2026-11-05', '2026-11-05', '2026-11-09', '2026-11-12']) {
    await added(ops, { date });
  }
  await added(ops, { date: '2026-10-20' });

  const all = await list(ops, '?limit=100');
  ok(all);
  expect(all.body.items.map((i) => i.date)).toEqual(['2026-11-12', '2026-11-09', '2026-11-05', '2026-11-05', '2026-11-01']);
  expect(all.body.items[0]).toMatchObject({ category: { key: 'rent', label: 'Rent' }, payee: { name: 'Lakshmi Textiles' }, total: 118000, hasGst: false, photos: 0, linked: false, status: 'active' });

  const seen = [];
  let cursor = null;
  do {
    const page = await list(ops, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    ok(page);
    expect(page.body.items.length).toBeLessThanOrEqual(2);
    seen.push(...numbers(page));
    cursor = page.body.nextCursor;
  } while (cursor);
  expect(seen).toEqual(numbers(all));
  expect(new Set(seen).size).toBe(5);

  // A named month, and a date range.
  expect((await list(ops, `?month=${OCT}`)).body.items).toHaveLength(1);
  expect((await list(ops, '?from=2026-11-05&to=2026-11-09')).body.items).toHaveLength(3);
  expect((await list(ops, '?month=2026-11&from=2026-11-05')).status).toBe(400);
});

test('the list filters by category, vendor, order and photo missing', async () => {
  const { ops, vendor29, designer } = await world();
  const customerId = (await ops.agent.post('/v1/customers').send({ name: 'Asha Rao', phone: '9876543210' })).body.id;
  const order = (
    await ops.agent.post('/v1/orders').set('Idempotency-Key', `o${++keys}`).send({
      customerId,
      designerId: String(designer.user._id),
      pickupDate: addDaysYmd('2026-11-15', 40),
      garments: [{ type: 'blouse', description: 'Blouse', agreedPrice: 450000, quantity: 1 }],
    })
  ).body;
  expect(order.id).toBeTruthy();

  const date = '2026-11-03';
  await added(ops, { date, category: 'electricity' });
  await added(ops, { date, payee: { vendorId: vendor29.id }, category: 'rent' });
  await added(ops, { date, link: { kind: 'order', id: order.id } });
  const key = await upload(ops);
  await added(ops, { date, payee: { vendorId: vendor29.id }, gst: gstBill(), attachments: [{ key, name: 'bill.jpg' }] });
  await added(ops, { date, payee: { vendorId: vendor29.id }, gst: gstBill() });

  expect((await list(ops, '?category=electricity')).body.items).toHaveLength(1);
  expect((await list(ops, '?category=rent')).body.items).toHaveLength(4);
  expect((await list(ops, `?vendorId=${vendor29.id}`)).body.items).toHaveLength(3);
  const byOrder = await list(ops, `?orderId=${order.id}`);
  expect(byOrder.body.items).toHaveLength(1);
  expect(byOrder.body.items[0].linked).toBe(true);
  // Only a GST bill without a photo.
  const noBill = await list(ops, '?noBill=true');
  expect(noBill.body.items).toHaveLength(1);
  expect(noBill.body.items[0]).toMatchObject({ hasGst: true, photos: 0 });
  expect((await list(ops, '?noBill=false')).body.items).toHaveLength(5);
  // Photo counts show on rows.
  expect((await list(ops, '?limit=100')).body.items.map((i) => i.photos).sort()).toEqual([0, 0, 0, 0, 1]);
});

test('voided expenses are hidden unless asked for', async () => {
  const { ops } = await world();
  const a = await added(ops, { date: '2026-11-04' });
  await added(ops, { date: '2026-11-04' });
  ok(await ops.agent.post(`/v1/expenses/${a.id}/void`).send({ version: a.version, reason: 'Entered twice' }));
  expect((await list(ops)).body.items).toHaveLength(1);
  const voided = await list(ops, '?status=voided');
  expect(voided.body.items.map((i) => i.id)).toEqual([a.id]);
  expect(voided.body.items[0].status).toBe('voided');
  expect((await list(ops, '?status=all')).body.items).toHaveLength(2);
});

test('search finds a number or a payee name', async () => {
  const { ops } = await world();
  await added(ops, { payee: { name: 'Lakshmi Textiles' } });
  await added(ops, { payee: { name: 'Anand Couriers' } });
  await added(ops, { payee: { name: 'Lakshmi Tailors' } });

  expect(numbers(await list(ops, '?q=2'))).toEqual(['0002']);
  expect(numbers(await list(ops, '?q=0003'))).toEqual(['0003']);
  expect((await list(ops, '?q=lakshmi')).body.items).toHaveLength(2);
  expect((await list(ops, '?q=LAKSHMI%20T')).body.items).toHaveLength(2);
  expect((await list(ops, '?q=couriers')).body.items).toHaveLength(0);
  // Characters that are special in a pattern are plain text.
  expect((await list(ops, '?q=.*')).body.items).toHaveLength(0);
  expect((await list(ops, '?q=(')).body.items).toHaveLength(0);
});

test('the month summary totals by category and mode, without voided expenses', async () => {
  const { ops } = await world();
  await added(ops, { date: '2026-11-02', category: 'rent', total: 500000, mode: 'bank_transfer' });
  await added(ops, { date: '2026-11-03', category: 'electricity', total: 120000, mode: 'upi' });
  await added(ops, { date: '2026-11-04', category: 'electricity', total: 30000, mode: 'cash' });
  await added(ops, { date: '2026-11-05', category: 'courier', total: 10000, mode: 'cash' });
  const gone = await added(ops, { date: '2026-11-06', category: 'courier', total: 999900, mode: 'cash' });
  ok(await ops.agent.post(`/v1/expenses/${gone.id}/void`).send({ version: gone.version, reason: 'Wrong' }));

  const r = await ops.agent.get(`/v1/expenses/summary?month=${NOV}`);
  ok(r);
  expect(r.body).toMatchObject({ month: NOV, total: 660000, count: 4, previousMonthTotal: 0, missingBill: 0, locked: false });
  expect(r.body.byCategory).toEqual([
    { category: { key: 'rent', label: 'Rent' }, total: 500000, count: 1 },
    { category: { key: 'electricity', label: 'Electricity' }, total: 150000, count: 2 },
    { category: { key: 'courier', label: 'Courier and delivery' }, total: 10000, count: 1 },
  ]);
  expect(r.body.byMode).toEqual([
    { mode: 'bank_transfer', total: 500000 },
    { mode: 'upi', total: 120000 },
    { mode: 'cash', total: 40000 },
  ]);
  expect((await ops.agent.get('/v1/expenses/summary')).status).toBe(400);
  expect((await ops.agent.get('/v1/expenses/summary?month=2026-13')).status).toBe(400);
});

test("the summary shows last month's total and GST that can be claimed", async () => {
  const { ops, vendor29 } = await world();
  await added(ops, { date: '2026-10-28', total: 70000 });
  await added(ops, { date: '2026-10-29', total: 5000 });
  const payee = { vendorId: vendor29.id };
  await added(ops, { date: '2026-11-02', payee, gst: gstBill() });
  await added(ops, { date: '2026-11-03', payee, gst: gstBill({ itcEligible: false }) });
  await added(ops, {
    date: '2026-11-04', payee, total: 236000, gst: gstBill({ taxable: 200000, cgst: 0, sgst: 0, igst: 36000 }),
  });

  const { body } = await ops.agent.get(`/v1/expenses/summary?month=${NOV}`);
  expect(body.previousMonthTotal).toBe(75000);
  expect(body.gst).toEqual({
    count: 3,
    taxable: 400000,
    cgst: 18000,
    sgst: 18000,
    igst: 36000,
    itc: { cgst: 9000, sgst: 9000, igst: 36000 },
    ineligible: { cgst: 9000, sgst: 9000, igst: 0 },
  });
});

test('the summary counts GST bills without a photo', async () => {
  const { ops, vendor29 } = await world();
  const payee = { vendorId: vendor29.id };
  const key = await upload(ops);
  await added(ops, { payee, gst: gstBill(), attachments: [{ key, name: 'b.jpg' }] });
  await added(ops, { payee, gst: gstBill() });
  await added(ops, { payee, gst: gstBill() });
  await added(ops, {}); // no GST bill, so nothing is missing
  const voided = await added(ops, { payee, gst: gstBill() });
  ok(await ops.agent.post(`/v1/expenses/${voided.id}/void`).send({ version: voided.version, reason: 'Wrong' }));
  expect((await ops.agent.get(`/v1/expenses/summary?month=${NOV}`)).body.missingBill).toBe(2);
});

test('a locked month says so in the summary', async () => {
  const { ops } = await world();
  await added(ops, { date: '2026-10-10' });
  expect((await ops.agent.get(`/v1/expenses/summary?month=${OCT}`)).body.locked).toBe(false);
  await lockMonth(OCT);
  const r = await ops.agent.get(`/v1/expenses/summary?month=${OCT}`);
  expect(r.body).toMatchObject({ locked: true, total: 118000, count: 1 });
  expect((await ops.agent.get(`/v1/expenses/summary?month=${NOV}`)).body.locked).toBe(false);
});

test('payees offer vendors and recent names', async () => {
  const { ops, designer, vendor29 } = await world();
  await added(ops, { date: '2026-11-01', payee: { name: 'Raju Tea Stall' } });
  await added(ops, { date: '2026-11-03', payee: { name: 'Anand Couriers', gstin: '29AAACV1234K1Z3' } });
  await added(ops, { date: '2026-11-04', payee: { name: 'raju tea stall' } });
  await added(ops, { date: '2026-11-05', payee: { vendorId: vendor29.id } });
  const gone = await added(ops, { date: '2026-11-06', payee: { name: 'Voided Payee' } });
  ok(await ops.agent.post(`/v1/expenses/${gone.id}/void`).send({ version: gone.version, reason: 'Wrong' }));

  const all = await ops.agent.get('/v1/expenses/payees');
  ok(all);
  expect(all.body.vendors.map((v) => v.name)).toEqual(['Bengaluru Silks', 'Mumbai Zari']);
  expect(all.body.vendors[0]).toEqual({ id: vendor29.id, name: 'Bengaluru Silks', gstin: '29AAACV1234K1Z3', stateCode: '29' });
  // Newest first, one entry per name, not vendors, not voided.
  expect(all.body.recent.map((p) => p.name)).toEqual(['raju tea stall', 'Anand Couriers']);
  expect(all.body.recent[1]).toMatchObject({ gstin: '29AAACV1234K1Z3', stateCode: '29' });

  const some = await ops.agent.get('/v1/expenses/payees?q=silk');
  expect(some.body.vendors.map((v) => v.name)).toEqual(['Bengaluru Silks']);
  expect(some.body.recent).toEqual([]);
  expect((await ops.agent.get('/v1/expenses/payees?q=ANAND')).body.recent.map((p) => p.name)).toEqual(['Anand Couriers']);

  // Adding needs expenses.write; designers have neither permission.
  expect((await designer.agent.get('/v1/expenses/payees')).status).toBe(403);
  expect((await designer.agent.get('/v1/expenses')).status).toBe(403);
  expect((await designer.agent.get(`/v1/expenses/summary?month=${NOV}`)).status).toBe(403);
});

test('category totals and input tax for any date range', async () => {
  const { ops, branchId, vendor29 } = await world();
  const payee = { vendorId: vendor29.id };
  await added(ops, { date: '2026-10-30', category: 'rent', total: 100000 });
  await added(ops, { date: '2026-11-02', category: 'rent', total: 50000 });
  await added(ops, { date: '2026-11-03', category: 'courier', total: 200000 });
  await added(ops, { date: '2026-10-31', category: 'courier', payee, gst: gstBill({ billDate: '2026-10-30' }) });
  await added(ops, { date: '2026-11-04', category: 'courier', payee, gst: gstBill({ itcEligible: false }) });
  const gone = await added(ops, { date: '2026-11-05', category: 'rent', total: 900000 });
  ok(await ops.agent.post(`/v1/expenses/${gone.id}/void`).send({ version: gone.version, reason: 'Wrong' }));

  expect(await expenseTotalsByCategory(branchId, { from: '2026-10-01', to: '2026-11-30' })).toEqual([
    { category: 'courier', total: 436000, count: 3 },
    { category: 'rent', total: 150000, count: 2 },
  ]);
  expect(await expenseTotalsByCategory(branchId, { from: '2026-11-01', to: '2026-11-03' })).toEqual([
    { category: 'courier', total: 200000, count: 1 },
    { category: 'rent', total: 50000, count: 1 },
  ]);
  expect(await expenseTotalsByCategory(branchId, { from: '2027-01-01', to: '2027-01-31' })).toEqual([]);

  expect(await inputTaxSummary(branchId, { from: '2026-10-01', to: '2026-11-30' })).toEqual({
    count: 2, taxable: 200000, cgst: 18000, sgst: 18000, igst: 0,
    itc: { cgst: 9000, sgst: 9000, igst: 0 }, ineligible: { cgst: 9000, sgst: 9000, igst: 0 },
  });
  expect((await inputTaxSummary(branchId, { from: '2026-11-01', to: '2026-11-30' })).count).toBe(1);
  expect(await inputTaxSummary(branchId, { from: '2027-01-01', to: '2027-01-31' })).toEqual({
    count: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0,
    itc: { cgst: 0, sgst: 0, igst: 0 }, ineligible: { cgst: 0, sgst: 0, igst: 0 },
  });
  expect((await monthSummary(branchId, NOV)).total).toBe(50000 + 200000 + 118000);
});

test('expense cost totals for any date range, with the part bought as stock', async () => {
  const { ops, branchId, vendor29 } = await world();
  const payee = { vendorId: vendor29.id };
  await added(ops, { date: '2026-11-02', total: 50000 }); // no GST: all of it
  await added(ops, { date: '2026-11-03', payee, gst: gstBill() }); // claimable GST: before-GST amount, 100000
  await added(ops, { date: '2026-11-04', payee, gst: gstBill({ itcEligible: false }) }); // 118000
  await added(ops, { date: '2026-10-04', total: 7000 });
  const gone = await added(ops, { date: '2026-11-05', total: 900000 });
  ok(await ops.agent.post(`/v1/expenses/${gone.id}/void`).send({ version: gone.version, reason: 'Wrong' }));
  // Stock purchases are expenses with source 'purchase'.
  await Expense.updateOne({ number: /0003$/ }, { source: 'purchase' }, { bypassDocumentValidation: true });

  expect(await expenseCostTotal(branchId, { from: '2026-11-01', to: '2026-11-30' })).toEqual({
    cost: 50000 + 100000 + 118000,
    purchaseCost: 118000,
  });
  expect(await expenseCostTotal(branchId, { from: '2026-10-01', to: '2026-11-30' })).toEqual({
    cost: 7000 + 50000 + 100000 + 118000,
    purchaseCost: 118000,
  });
  expect(await expenseCostTotal(branchId, { from: '2027-01-01', to: '2027-01-31' })).toEqual({ cost: 0, purchaseCost: 0 });
});

test("figures and suggestions leave out other branches' expenses", async () => {
  const { ops, branchId, vendor29 } = await world();
  const foreign = new mongoose.Types.ObjectId();
  const own = [
    await added(ops, { date: '2026-10-05', total: 30000, category: 'rent', payee: { name: 'Own Oct Shop' } }),
    await added(ops, { date: '2026-11-02', total: 50000, category: 'rent', payee: { name: 'Own Free Text Shop' } }),
    await added(ops, { date: '2026-11-03', total: 118000, category: 'courier', payee: { vendorId: vendor29.id }, gst: gstBill() }),
  ];
  const theirs = [
    await added(ops, { date: '2026-10-06', total: 900000, category: 'rent', payee: { name: 'Other Branch Shop' } }),
    await added(ops, {
      date: '2026-11-04', total: 236000, category: 'courier', payee: { vendorId: vendor29.id },
      gst: gstBill({ taxable: 200000, cgst: 18000, sgst: 18000, igst: 0 }),
    }),
    await added(ops, { date: '2026-11-05', total: 77000, category: 'electricity', payee: { name: 'Other Branch Shop' } }),
  ];
  for (const e of theirs) await Expense.updateOne({ _id: e.id }, { branchId: foreign });

  const novList = await listExpenses(branchId, { month: NOV, limit: 100 });
  expect(novList.items.map((i) => String(i._id)).sort()).toEqual([own[1].id, own[2].id].sort());
  const octList = await listExpenses(branchId, { month: OCT, limit: 100 });
  expect(octList.items.map((i) => String(i._id))).toEqual([own[0].id]);

  const summary = await monthSummary(branchId, NOV);
  expect(summary).toMatchObject({ total: 168000, count: 2, previousMonthTotal: 30000, missingBill: 1 });
  expect(summary.byCategory.map((r) => [r.category.key, r.total, r.count])).toEqual([
    ['courier', 118000, 1],
    ['rent', 50000, 1],
  ]);
  expect(summary.byMode.reduce((t, r) => t + r.total, 0)).toBe(168000);
  expect(summary.gst).toMatchObject({ count: 1, taxable: 100000, cgst: 9000, sgst: 9000 });

  expect(await expenseTotalsByCategory(branchId, { from: '2026-10-01', to: '2026-11-30' })).toEqual([
    { category: 'courier', total: 118000, count: 1 },
    { category: 'rent', total: 80000, count: 2 },
  ]);
  expect(await inputTaxSummary(branchId, { from: '2026-10-01', to: '2026-11-30' })).toMatchObject({ count: 1, cgst: 9000, sgst: 9000 });
  expect(await expenseCostTotal(branchId, { from: '2026-10-01', to: '2026-11-30' })).toEqual({ cost: 30000 + 50000 + 100000, purchaseCost: 0 });
  expect((await recentPayees(branchId)).recent.map((p) => p.name)).toEqual(['Own Free Text Shop', 'Own Oct Shop']);

  // The other branch's own figures show the seeding did what the test relies on.
  expect(await monthSummary(String(foreign), NOV)).toMatchObject({ total: 313000, count: 2, previousMonthTotal: 900000 });
  expect((await recentPayees(String(foreign))).recent.map((p) => p.name)).toEqual(['Other Branch Shop']);
});

test('voided GST bills count for nothing in the GST, cost and last-month figures', async () => {
  const { ops, branchId, vendor29 } = await world();
  const payee = { vendorId: vendor29.id };
  await added(ops, { date: '2026-10-10', payee, gst: gstBill({ billDate: '2026-10-10' }) });
  const big = { taxable: 500000, cgst: 45000, sgst: 45000 }; // 590000 with GST
  const octVoid = await added(ops, { date: '2026-10-11', payee, gst: gstBill({ billDate: '2026-10-11', ...big }), total: 590000 });
  await added(ops, { date: '2026-11-02', payee, gst: gstBill() });
  const novVoid = await added(ops, { date: '2026-11-03', payee, gst: gstBill(big), total: 590000 });
  for (const e of [octVoid, novVoid]) {
    ok(await ops.agent.post(`/v1/expenses/${e.id}/void`).send({ version: e.version, reason: 'Entered twice' }));
  }

  const nov = await monthSummary(branchId, NOV);
  expect(nov).toMatchObject({ total: 118000, count: 1, previousMonthTotal: 118000 });
  expect(nov.gst).toEqual({
    count: 1,
    taxable: 100000,
    cgst: 9000,
    sgst: 9000,
    igst: 0,
    itc: { cgst: 9000, sgst: 9000, igst: 0 },
    ineligible: { cgst: 0, sgst: 0, igst: 0 },
  });
  expect(await inputTaxSummary(branchId, { from: '2026-11-01', to: '2026-11-30' })).toMatchObject({ count: 1, taxable: 100000, cgst: 9000 });
  expect(await inputTaxSummary(branchId, { from: '2026-10-01', to: '2026-10-31' })).toMatchObject({ count: 1, taxable: 100000, cgst: 9000 });
  expect(await expenseCostTotal(branchId, { from: '2026-11-01', to: '2026-11-30' })).toEqual({ cost: 100000, purchaseCost: 0 });

  const oct = await monthSummary(branchId, OCT);
  expect(oct).toMatchObject({ total: 118000, count: 1, previousMonthTotal: 0 });
  expect(oct.gst).toMatchObject({ count: 1, taxable: 100000 });
});

test('month figures include the first and last day of the month only', async () => {
  const { ops, branchId } = await world();
  // Totals are powers of ten so each sum shows exactly which expenses it took.
  const dated = [
    ['2026-08-31', 1000000], // neither
    ['2026-09-01', 1], // September
    ['2026-09-30', 10], // September
    ['2026-10-01', 100], // October
    ['2026-10-15', 10000], // October
    ['2026-10-31', 1000], // October
    ['2026-11-01', 100000], // November
    ['2025-11-30', 9000000], // neither
    ['2025-12-01', 300000], // December, last year
    ['2025-12-31', 500000], // December, last year
    ['2026-01-01', 2000], // January
    ['2026-01-31', 4000], // January
    ['2026-02-01', 8000000], // neither
  ];
  for (const [date, total] of dated) await added(ops, { date, total });

  const octList = await listExpenses(branchId, { month: OCT, limit: 100 });
  expect(octList.items).toHaveLength(3);
  expect(await monthSummary(branchId, OCT)).toMatchObject({ total: 11100, count: 3, previousMonthTotal: 11 });
  expect(await monthSummary(branchId, NOV)).toMatchObject({ total: 100000, count: 1, previousMonthTotal: 11100 });
  expect(await monthSummary(branchId, '2026-09')).toMatchObject({ total: 11, count: 2, previousMonthTotal: 1000000 });
  expect(await monthSummary(branchId, '2026-01')).toMatchObject({ total: 6000, count: 2, previousMonthTotal: 800000 });
});

test('the month figures and the list filter use the by_date index', async () => {
  const { branchId } = await world();
  // The index names used by the winning plan of an explained find or aggregate.
  const winning = (explained) => {
    const plan = explained.queryPlanner?.winningPlan ?? explained.stages.find((st) => st.$cursor).$cursor.queryPlanner.winningPlan;
    const names = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.stage === 'IXSCAN') names.push(node.indexName);
      if (node.stage === 'COLLSCAN') names.push('COLLSCAN');
      walk(node.inputStage);
      for (const child of node.inputStages ?? []) walk(child);
    };
    walk(plan);
    return names;
  };

  // The list of a month: the real filter, sorted as listExpenses sorts it.
  const listPlan = await Expense.find(expenseListFilter(branchId, { month: NOV }))
    .sort({ date: -1, _id: -1 })
    .explain('queryPlanner');
  expect(winning(listPlan)).toEqual(['by_date']);

  // The month figures: the real $facet pipeline.
  const facetPlan = await Expense.aggregate(monthFacetPipeline(branchId, NOV)).explain('queryPlanner');
  expect(winning(facetPlan)).toEqual(['by_date']);

  // A date range's category totals, GST and cost sums: the real match.
  const rangeMatch = activeMatch(branchId, { from: '2026-10-01', to: '2026-11-30' });
  const rangePlan = await Expense.aggregate([{ $match: rangeMatch }, { $group: { _id: '$category', total: { $sum: '$total' } } }]).explain('queryPlanner');
  expect(winning(rangePlan)).toEqual(['by_date']);

  // Filters that add a category or a no-bill check still avoid a full scan.
  for (const filter of [
    expenseListFilter(branchId, { month: NOV, category: 'rent' }),
    expenseListFilter(branchId, { from: '2026-10-01', to: '2026-11-30', noBill: true }),
  ]) {
    const plan = await Expense.find(filter).sort({ date: -1, _id: -1 }).explain('queryPlanner');
    expect(winning(plan)).not.toContain('COLLSCAN');
  }
});
