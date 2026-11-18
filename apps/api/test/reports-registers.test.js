import { test, expect, vi, afterEach } from 'vitest';
import { addDaysYmd } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { reportHelpers } from './helpers/reports.js';
import { itemBody } from './helpers/stock.js';
import { today } from './helpers/production.js';
import { clock } from '../src/clock.js';
import { Garment } from '../src/modules/orders/model.js';
import { Enquiry } from '../src/modules/enquiries/model.js';
import { getBuilder } from '../src/modules/reports/builders/index.js';
import '../src/modules/reports/runner.js';
import * as billingService from '../src/modules/billing/service.js';
import * as expensesService from '../src/modules/expenses/service.js';
import * as stockService from '../src/modules/stock/service.js';
import { orderProfits } from '../src/modules/costing/service.js';

// Pass-through spies on the paged list functions the builders read.
vi.mock('../src/modules/billing/service.js', async (importOriginal) => {
  const m = await importOriginal();
  return { ...m, advancesByCustomer: vi.fn(m.advancesByCustomer), customerLedger: vi.fn(m.customerLedger), listReceivables: vi.fn(m.listReceivables), invoicedOrderIds: vi.fn(m.invoicedOrderIds) };
});
vi.mock('../src/modules/expenses/service.js', async (importOriginal) => {
  const m = await importOriginal();
  return { ...m, listExpenses: vi.fn(m.listExpenses) };
});
vi.mock('../src/modules/stock/service.js', async (importOriginal) => {
  const m = await importOriginal();
  return { ...m, listMovementsByDate: vi.fn(m.listMovementsByDate) };
});

useTestDb();
const app = buildTestApp();
const billing = billingHelpers(app);
const { request, waitFor, download } = reportHelpers(app);

afterEach(() => vi.useRealTimers());

let keys = 0;
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const TODAY = today();
const FROM = addDaysYmd(TODAY, -20);
const RANGE = { from: FROM, to: TODAY };
const on = (ymd) => vi.spyOn(clock, 'now').mockReturnValue(new Date(`${ymd}T06:30:00.000Z`));
const run = (kind, branchId, params = RANGE, format = 'xlsx') => getBuilder(kind)(branchId, params, { maxRows: 200_000, format });
const sheet = (out, i = 0) => out.files[0].sheets[i];
const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);

/**
 * A month of activity: a bill before the period (day −30), bills, a cash and a UPI payment, a credit
 * note, an advance with a receipt voucher and a refund of part of it, two expenses and a voided one,
 * stock bought and used, enquiries, a garment ready on time and a garment back from the vendor.
 */
async function world() {
  const w = await billing.world();
  const branchId = String(w.admin.user.branchId);
  const bill = async (prices) => {
    const r = await billing.issue(w.ops, await billing.draftFor(await w.takeOrder({ prices })));
    ok(r);
    return r.body.invoice;
  };
  on(addDaysYmd(TODAY, -30));
  const before = await bill([80000]);
  on(addDaysYmd(TODAY, -10));
  const first = await bill([100000]);
  ok(await billing.pay(w.ops, { customerId: w.customerId, invoiceId: first.id, amount: 50000, mode: 'cash' }));
  on(addDaysYmd(TODAY, -5));
  const second = await bill([200000]);
  ok(await billing.pay(w.ops, { customerId: w.customerId, invoiceId: second.id, amount: 30000, mode: 'upi' }));
  const note = await w.admin.agent.post(`/v1/billing/invoices/${first.id}/credit-notes`).set('Idempotency-Key', `rr${++keys}`)
    .send({ reason: 'Price reduced', lines: [{ key: first.lines[0].key, taxable: 10000 }] });
  ok(note);
  const stitching = await w.takeOrder({ prices: [100000] });
  await Garment.updateOne({ _id: stitching.garments[0].id }, { catalogItemId: w.items.stitching.id });
  ok(await billing.pay(w.ops, { customerId: w.customerId, orderId: stitching.id, amount: 105000, mode: 'upi' }));
  ok(await w.admin.agent.post('/v1/billing/refunds').set('Idempotency-Key', `rr${++keys}`)
    .send({ customerId: w.customerId, orderId: stitching.id, amount: 21000, mode: 'cash', reason: 'Changed order' }));
  const expense = async (body) => {
    const r = await w.admin.agent.post('/v1/expenses').set('Idempotency-Key', `rr${++keys}`)
      .send({ date: addDaysYmd(TODAY, -5), payee: { name: 'Landlord' }, mode: 'cash', ...body });
    ok(r);
    return r.body.expense;
  };
  await expense({ category: 'rent', total: 118000 });
  await expense({ category: 'electricity', total: 5000 });
  const voided = await expense({ category: 'electricity', total: 9999 });
  ok(await w.admin.agent.post(`/v1/expenses/${voided.id}/void`).send({ version: voided.version, reason: 'Entered twice' }), 200);

  const silk = await w.admin.agent.post('/v1/stock/items').set('Idempotency-Key', `rr${++keys}`).send({ ...itemBody({ name: 'Silk' }), sellingPrice: 80000 });
  ok(silk);
  ok(await w.ops.agent.post(`/v1/stock/items/${silk.body.item.id}/receive`).set('Idempotency-Key', `rr${++keys}`)
    .send({ quantity: 10000, total: 500000, mode: 'cash', payee: { name: 'Bengaluru Silks' } }));
  const used = await w.ops.agent.post('/v1/orders').set('Idempotency-Key', `rr${++keys}`).send({
    customerId: w.customerId, designerId: String(w.d1.user._id), pickupDate: addDaysYmd(TODAY, 40),
    garments: [{ type: 'blouse', description: 'Silk blouse', agreedPrice: 100000, quantity: 1, materials: [{ stockItemId: silk.body.item.id, quantity: 4000 }] }],
  });
  ok(used);
  await billing.act(w.d1, used.body.garments[0], { action: 'complete' });

  const vendorOrder = await w.take();
  const atHandwork = await billing.advanceTo(w.d1, vendorOrder.garments[0], 'handwork');
  const away = await billing.act(w.d1, atHandwork, { action: 'sent_to_vendor', vendorId: w.vendor.id, dueBackDate: addDaysYmd(TODAY, -2) });
  on(addDaysYmd(TODAY, -3));
  await billing.act(w.d1, away, { action: 'returned_from_vendor' });
  vi.restoreAllMocks();
  const ready = await w.take();
  await billing.makeReady(w.d1, ready.garments[0]);
  for (const [name, phone, source] of [['Insta One', '9845000301', 'instagram'], ['Insta Two', '9845000302', 'instagram'], ['Walk In', '9845000303', 'walk_in']]) {
    ok(await w.ops.agent.post('/v1/enquiries').set('Idempotency-Key', `rr${++keys}`).send({ name, phone, source }));
  }
  await Enquiry.updateOne({ name: 'Insta One' }, { status: 'converted', isOpen: false });
  return { ...w, branchId, before, first, second, note: note.body.creditNote, silkId: silk.body.item.id };
}

test.each([
  ['sales_register', (rows, m) => expect(sum(rows, 'total')).toBe(m.billed)],
  ['credit_note_register', (rows, m) => expect(sum(rows, 'total')).toBe(m.credited)],
  ['refund_register', (rows, m) => expect(sum(rows, 'amount')).toBe(m.refunded)],
  ['collections_by_mode', (rows, m) => {
    expect(sum(rows, 'receipts')).toBe(m.collected);
    expect(sum(rows, 'refunds')).toBe(m.refunded);
    expect(sum(rows, 'net')).toBe(m.collected - m.refunded);
  }],
  ['receipt_voucher_register', (rows) => expect(rows.map((r) => r.taxable)).toEqual([100000])],
])('each register matches the documents of the period (%s)', async (kind, check) => {
  const w = await world();
  const out = await run(kind, w.branchId);
  const money = await billingService.periodMoney(w.branchId, RANGE);
  expect(sheet(out).rows.length).toBeGreaterThan(0);
  check(sheet(out).rows, money);
});

test('the advances register lists what each customer has left', async () => {
  const w = await world();
  const rows = sheet(await run('advances_held', w.branchId, {})).rows;
  // All payments received; those used on bills (₹800) or refunded (₹210) are not held.
  expect(rows).toEqual([{ customer: 'Asha Rao', received: 185000, allocated: 101000, held: 84000 }]);
});

test('the expense register shows input GST by category without voided expenses', async () => {
  const w = await world();
  const out = await run('expense_register', w.branchId);
  const [register, byCategory] = sheet(out) && out.files[0].sheets;
  expect(register.name).toBe('Expenses');
  expect(byCategory.name).toBe('By category');
  const manual = register.rows.filter((r) => r.category !== 'Materials and fabric');
  expect(manual.map((r) => [r.category, r.total, r.status]).sort()).toEqual([
    ['Electricity', 0, 'Voided'], ['Electricity', 5000, 'Active'], ['Rent', 118000, 'Active'],
  ].sort());
  const electricity = byCategory.rows.find((r) => r.category === 'Electricity');
  expect(electricity).toMatchObject({ count: 1, total: 5000, cgst: 0, sgst: 0, igst: 0, itc: 0 });
  expect(sum(byCategory.rows, 'total')).toBe(118000 + 5000 + 500000);
});

test('a customer statement opens and closes with the ledger balance, as Excel and as PDF', async () => {
  const w = await world();
  const params = { customerId: w.customerId, from: FROM, to: TODAY };
  const rows = sheet(await run('customer_statement', w.branchId, params)).rows;
  expect(rows[0]).toMatchObject({ label: 'Opening balance', balance: w.before.totals.total });
  const summary = await billingService.customerMoneySummary(w.branchId, w.customerId);
  const closing = summary.billed - summary.received - summary.credited + summary.refunded;
  expect(rows.at(-1)).toMatchObject({ label: 'Closing balance', balance: closing });
  const entries = rows.slice(1, -1);
  expect(entries.map((r) => r.number)).not.toContain(w.before.number);
  expect(entries[0].date <= entries.at(-1).date).toBe(true);
  expect(w.before.totals.total + sum(entries, 'debit') - sum(entries, 'credit')).toBe(closing);

  const r = await request(w.admin, { kind: 'customer_statement', format: 'pdf', params });
  ok(r, 202);
  const done = await waitFor(w.admin, r.body.report.id);
  expect(done).toMatchObject({ status: 'done', filename: `Statement Asha Rao ${FROM} to ${TODAY}.pdf` });
  const { body } = await download(w.admin, done.id);
  expect(body.subarray(0, 4).toString()).toBe('%PDF');
});

test('ageing by customer matches money owed', async () => {
  const w = await world();
  const rows = sheet(await run('receivables_ageing', w.branchId, {})).rows;
  const { totals } = await billingService.listReceivables(w.branchId, {});
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ customer: 'Asha Rao', total: totals.balance });
  expect(rows[0].not_due + rows[0].d0_30 + rows[0].d31_60 + rows[0].d61_90 + rows[0].d90_plus).toBe(totals.balance);
});

test('the day book lists bills, payments, refunds and expenses by date', async () => {
  const w = await world();
  const rows = sheet(await run('day_book', w.branchId)).rows;
  expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['Bill', 'Payment', 'Credit note', 'Refund', 'Expense']));
  expect(rows.map((r) => r.date)).toEqual([...rows.map((r) => r.date)].sort());
  expect(rows.find((r) => r.number === w.first.number)).toMatchObject({ kind: 'Bill', in: w.first.totals.total, out: 0 });
  expect(rows.some((r) => r.out === 9999)).toBe(false);
});

test('order profitability matches costing for each order', async () => {
  const w = await world();
  const rows = sheet(await run('order_profitability', w.branchId)).rows;
  expect(rows).toHaveLength(2);
  const ids = rows.map((r) => r.orderId);
  const costing = await orderProfits(w.branchId, ids);
  for (const r of rows) {
    const c = costing.get(r.orderId);
    expect(r).toMatchObject({ customer: 'Asha Rao', revenue: c.revenue, material: c.material, expense: c.expense, profit: c.profit });
  }
});

test('on time by designer and vendor', async () => {
  const w = await world();
  const out = await run('on_time', w.branchId);
  const [designers, vendors] = out.files[0].sheets;
  expect(designers.name).toBe('By designer');
  expect(designers.rows).toEqual([{ designer: 'Meera', ready: 1, onTime: 1, rate: 100 }]);
  expect(vendors.name).toBe('By vendor');
  expect(vendors.rows).toEqual([{ vendor: 'Zari works', returned: 1, onTime: 1, rate: 100 }]);
});

test('enquiry conversion and profit per stock item for a period', async () => {
  const w = await world();
  const enquiries = sheet(await run('enquiry_conversion', w.branchId)).rows;
  expect(enquiries.find((r) => r.source === 'Instagram')).toMatchObject({ total: 2, converted: 1, rate: 50 });
  const items = sheet(await run('stock_item_profit', w.branchId)).rows;
  expect(items).toEqual([{ item: 'Silk', quantity: 4, cost: 200000, sales: 320000, profit: 120000, note: '' }]);
});

test('long reports read page by page', async () => {
  const w = await world();
  for (const fn of [billingService.advancesByCustomer, billingService.customerLedger, billingService.listReceivables, billingService.invoicedOrderIds, expensesService.listExpenses, stockService.listMovementsByDate]) {
    vi.mocked(fn).mockClear();
  }
  await run('advances_held', w.branchId, {});
  await run('customer_statement', w.branchId, { customerId: w.customerId, from: FROM, to: TODAY });
  await run('receivables_ageing', w.branchId, {});
  await run('order_profitability', w.branchId);
  await run('expense_register', w.branchId);
  await run('stock_movements', w.branchId);
  const calls = [billingService.advancesByCustomer, billingService.customerLedger, billingService.listReceivables, billingService.invoicedOrderIds, expensesService.listExpenses, stockService.listMovementsByDate]
    .map((fn) => vi.mocked(fn).mock.calls);
  for (const list of calls) {
    expect(list.length).toBeGreaterThan(0);
    for (const args of list) {
      const options = args.find((a, i) => i > 0 && a && typeof a === 'object' && 'limit' in a);
      expect(options?.limit).toBeLessThanOrEqual(100);
    }
  }
  const movements = sheet(await run('stock_movements', w.branchId)).rows;
  expect(movements.some((m) => m.item === 'Silk' && m.type === 'Used on a garment')).toBe(true);
  const valuation = sheet(await run('stock_valuation', w.branchId, {})).rows;
  expect(valuation.find((v) => v.item === 'Silk')).toMatchObject({ onHand: 6, value: 300000 });
});
