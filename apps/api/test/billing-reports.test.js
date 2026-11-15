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
import { Allocation, BillingDocument, Invoice } from '../src/modules/billing/model.js';
import {
  advancesByCustomer,
  advancesHeld,
  allocationsMatch,
  billingDocumentsInRange,
  listReceivables,
  customerMoneySummary,
  documentSeries,
  documentsFilter,
  invoicedOrderIds,
  invoicedOrdersMatch,
  moneyRows,
  monthlyMoney,
  orderDocsFilter,
  orderPaymentStatuses,
  periodMatch,
  periodMoney,
  receiptsHeldMatch,
  receivablesAgeing,
  receivablesMatch,
  seriesMatch,
  splitByVoucherLines,
} from '../src/modules/billing/service.js';

useTestDb();
const app = buildTestApp();
const { world, draftFor, issue, pay } = billingHelpers(app);

afterEach(() => vi.restoreAllMocks());

let keys = 0;
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
// Noon IST on the given day.
const on = (ymd) => vi.spyOn(clock, 'now').mockReturnValue(new Date(`${ymd}T06:30:00.000Z`));
const TODAY = today();
const ago = (n) => addDaysYmd(TODAY, -n);
const branchOf = async () => String((await Branch.findOne().lean())._id);

const credit = (who, bill, taxable) =>
  who.agent
    .post(`/v1/billing/invoices/${bill.id}/credit-notes`)
    .set('Idempotency-Key', `brc${++keys}`)
    .send({ reason: 'Price reduced', lines: [{ key: bill.lines[0].key, taxable }] });
const refund = (who, body) =>
  who.agent.post('/v1/billing/refunds').set('Idempotency-Key', `brr${++keys}`).send({ mode: 'cash', reason: 'Order cancelled', ...body });
const cancelBill = (who, bill) => who.agent.post(`/v1/billing/invoices/${bill.id}/cancel`).send({ reason: 'Entered by mistake' });
const issued = async (ops, order) => {
  const r = await issue(ops, await draftFor(order));
  ok(r);
  return r.body.invoice;
};
const asStitching = async (order, items) => {
  for (const g of order.garments) await Garment.updateOne({ _id: g.id }, { catalogItemId: items.stitching.id });
};
const newCustomer = async (ops, name, phone) => {
  const r = await ops.agent.post('/v1/customers').send({ name, phone });
  ok(r);
  return r.body.id;
};
const all = async (iterable) => {
  const out = [];
  for await (const v of iterable) out.push(v);
  return out;
};
const pages = async (fetchPage) => {
  const items = [];
  let cursor;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
};

/** A bill (day −5), a payment on it (−4), a credit note (−3), a cancelled bill (−3), an advance (−2) and a refund of part of it (−1). */
async function history() {
  const w = await world();
  const branchId = await branchOf();
  on(ago(5));
  const bill = await issued(w.ops, await w.takeOrder({ prices: [450000] }));
  on(ago(4));
  const receipt = (await pay(w.ops, { customerId: w.customerId, invoiceId: bill.id, amount: 200000, mode: 'cash' })).body.receipt;
  on(ago(3));
  const noteRes = await credit(w.admin, bill, 10000);
  ok(noteRes);
  const mistake = await issued(w.ops, await w.takeOrder({ prices: [300000] }));
  ok(await cancelBill(w.admin, mistake), 200);
  on(ago(2));
  const advanceOrder = await w.takeOrder({ prices: [200000] });
  ok(await pay(w.ops, { customerId: w.customerId, orderId: advanceOrder.id, amount: 100000, mode: 'upi' }));
  on(ago(1));
  ok(await refund(w.admin, { customerId: w.customerId, orderId: advanceOrder.id, amount: 30000 }));
  vi.restoreAllMocks();
  return { ...w, branchId, bill, receipt, note: noteRes.body.creditNote, mistake, advanceOrder };
}

test('period money adds up bills, credit notes, payments and refunds by document date', async () => {
  const { branchId, bill, note } = await history();
  expect(await periodMoney(branchId, { from: ago(10), to: TODAY })).toEqual({
    billed: bill.totals.total,
    invoices: 1,
    credited: note.totals.total,
    creditedTaxable: 10000,
    taxable: bill.totals.taxable,
    collected: 300000,
    receipts: 2,
    refunded: 30000,
  });
  // Only the days asked for: the credit note, the cancelled bill (nothing), the advance and the refund.
  expect(await periodMoney(branchId, { from: ago(3), to: ago(1) })).toEqual({
    billed: 0, invoices: 0, credited: note.totals.total, creditedTaxable: 10000, taxable: 0,
    collected: 100000, receipts: 1, refunded: 30000,
  });
});

test('a customer type filter keeps only those customers\' documents', async () => {
  const { ops, branchId, customerId, take, bill } = await history();
  const other = await newCustomer(ops, 'Film Co', '9876500000');
  const otherBill = await issued(ops, await take({ customer: other }));
  const range = { from: ago(10), to: TODAY };

  const mine = await periodMoney(branchId, { ...range, customerFilter: { in: [customerId] } });
  expect(mine).toMatchObject({ billed: bill.totals.total, invoices: 1 });
  const theirs = await periodMoney(branchId, { ...range, customerFilter: { notIn: [customerId] } });
  expect(theirs).toEqual({
    billed: otherBill.totals.total, invoices: 1, credited: 0, creditedTaxable: 0, taxable: otherBill.totals.taxable,
    collected: 0, receipts: 0, refunded: 0,
  });
  const ageing = await receivablesAgeing(branchId, { customerFilter: { in: [other] } });
  expect(ageing).toMatchObject({ count: 1, outstanding: otherBill.totals.total });
});

const monthBefore = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) - n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

test('months without bills show zero', async () => {
  const { ops, customerId, takeOrder } = await world();
  const branchId = await branchOf();
  const bill = await issued(ops, await takeOrder({ prices: [450000] }));
  ok(await pay(ops, { customerId, invoiceId: bill.id, amount: 100000, mode: 'cash' }));
  const thisMonth = TODAY.slice(0, 7);
  const first = `${monthBefore(thisMonth, 2)}-01`;
  expect(await monthlyMoney(branchId, { from: first, to: TODAY })).toEqual([
    { month: monthBefore(thisMonth, 2), billed: 0, collected: 0 },
    { month: monthBefore(thisMonth, 1), billed: 0, collected: 0 },
    { month: thisMonth, billed: bill.totals.total, collected: 100000 },
  ]);
});

test('ageing buckets and the top customers match the money owed list', async () => {
  const { ops, customerId, takeOrder, take } = await world();
  const branchId = await branchOf();
  const other = await newCustomer(ops, 'Film Co', '9876500000');
  for (const days of [100, 45, 10, 0]) {
    on(ago(days));
    await issued(ops, await takeOrder({ prices: [100000 + days * 1000] }));
  }
  on(ago(20));
  await issued(ops, await take({ customer: other }));
  vi.restoreAllMocks();

  const owed = await pages((cursor) => listReceivables(branchId, { cursor, limit: 2 }));
  const totals = (await listReceivables(branchId, {})).totals;
  const bucket = (name) => owed.filter((i) => i.bucket === name).reduce((s, i) => s + i.invoice.balance, 0);

  const ageing = await receivablesAgeing(branchId, {});
  expect(ageing).toMatchObject({ count: totals.count, outstanding: totals.balance, overdueAmount: totals.overdue });
  expect(ageing.overdueCount).toBe(owed.filter((i) => i.daysOverdue > 0).length);
  expect(ageing.overdueCount).toBe(4);
  expect(ageing.buckets).toEqual({
    not_due: bucket('not_due'), d0_30: bucket('d0_30'), d31_60: bucket('d31_60'), d61_90: bucket('d61_90'), d90_plus: bucket('d90_plus'),
  });
  expect(ageing.buckets.d90_plus).toBeGreaterThan(0);
  expect(ageing.buckets.d31_60).toBeGreaterThan(0);

  const ownBalance = owed.filter((i) => i.customer.id === customerId).reduce((s, i) => s + i.invoice.balance, 0);
  const otherBalance = owed.filter((i) => i.customer.id === other).reduce((s, i) => s + i.invoice.balance, 0);
  expect(ageing.topCustomers).toEqual([
    { id: customerId, name: 'Asha Rao', balance: ownBalance, oldestDays: 100 },
    { id: other, name: 'Film Co', balance: otherBalance, oldestDays: 20 },
  ]);
  expect((await receivablesAgeing(branchId, { top: 1 })).topCustomers).toHaveLength(1);
});

test('advances held equals the sum of customers\' advances', async () => {
  const { ops, customerId, takeOrder, take } = await world();
  const branchId = await branchOf();
  const other = await newCustomer(ops, 'Film Co', '9876500000');
  const third = await newCustomer(ops, 'Leela', '9876511111');
  // Asha: an advance on an order not yet billed. Film Co: money with no order. Leela: an advance used up by her bill.
  ok(await pay(ops, { customerId, orderId: (await takeOrder({ prices: [300000] })).id, amount: 120000, mode: 'cash' }));
  ok(await pay(ops, { customerId: other, amount: 45000, mode: 'upi' }));
  const leelaOrder = await take({ customer: third });
  ok(await pay(ops, { customerId: third, orderId: leelaOrder.id, amount: 50000, mode: 'cash' }));
  await issued(ops, leelaOrder);

  const summaries = await Promise.all([customerId, other, third].map((id) => customerMoneySummary(branchId, id)));
  const expected = summaries.reduce((s, m) => s + m.advanceHeld, 0);
  expect(summaries[2].advanceHeld).toBe(0);
  expect(await advancesHeld(branchId)).toEqual({ advancesHeld: expected, customers: 2 });

  const listed = await pages((cursor) => advancesByCustomer(branchId, { cursor, limit: 1 }));
  expect(listed).toEqual([
    { customer: { id: customerId, name: 'Asha Rao' }, received: 120000, allocated: 0, advancesHeld: 120000 },
    { customer: { id: other, name: 'Film Co' }, received: 45000, allocated: 0, advancesHeld: 45000 },
  ]);
});

test('order payment status is paid, part paid, unpaid, advance only or nothing yet', async () => {
  const { ops, customerId, takeOrder } = await world();
  const branchId = await branchOf();
  const paidOrder = await takeOrder({ prices: [100000] });
  const paidBill = await issued(ops, paidOrder);
  ok(await pay(ops, { customerId, invoiceId: paidBill.id, amount: paidBill.totals.total, mode: 'cash' }));
  const partOrder = await takeOrder({ prices: [200000] });
  const partBill = await issued(ops, partOrder);
  ok(await pay(ops, { customerId, invoiceId: partBill.id, amount: 1000, mode: 'cash' }));
  const unpaidOrder = await takeOrder({ prices: [300000] });
  const unpaidBill = await issued(ops, unpaidOrder);
  const advanceOrder = await takeOrder({ prices: [400000] });
  ok(await pay(ops, { customerId, orderId: advanceOrder.id, amount: 70000, mode: 'upi' }));
  const newOrder = await takeOrder({ prices: [500000] });

  const ids = [paidOrder, partOrder, unpaidOrder, advanceOrder, newOrder].map((o) => o.id);
  const statuses = await orderPaymentStatuses(branchId, ids);
  expect(Object.fromEntries([...statuses].map(([id, s]) => [id, s]))).toEqual({
    [paidOrder.id]: { status: 'paid', balance: 0, advancesHeld: 0 },
    [partOrder.id]: { status: 'part_paid', balance: partBill.totals.total - 1000, advancesHeld: 0 },
    [unpaidOrder.id]: { status: 'unpaid', balance: unpaidBill.totals.total, advancesHeld: 0 },
    [advanceOrder.id]: { status: 'advance_only', balance: 0, advancesHeld: 70000 },
    [newOrder.id]: { status: 'nothing_yet', balance: 0, advancesHeld: 0 },
  });
  const tooMany = Array.from({ length: 201 }, () => String(new mongoose.Types.ObjectId()));
  await expect(orderPaymentStatuses(branchId, tooMany)).rejects.toThrow(RangeError);
});

test('invoiced orders come most recent first, once each, page by page', async () => {
  const { ops, takeOrder } = await world();
  const branchId = await branchOf();
  const orders = [];
  for (const days of [6, 4, 2]) {
    on(ago(days));
    const order = await takeOrder({ prices: [100000] });
    await issued(ops, order);
    orders.push(order);
  }
  vi.restoreAllMocks();
  const first = await invoicedOrderIds(branchId, { from: ago(10), to: TODAY, limit: 2 });
  expect(first.ids).toEqual([orders[2].id, orders[1].id]);
  const second = await invoicedOrderIds(branchId, { from: ago(10), to: TODAY, limit: 2, cursor: first.nextCursor });
  expect(second).toEqual({ ids: [orders[0].id], nextCursor: null });
  expect((await invoicedOrderIds(branchId, { from: ago(3), to: TODAY })).ids).toEqual([orders[2].id]);
});

test('document views carry lines, place of supply and the original bill of a credit note', async () => {
  const { ops, admin, customerId, items, takeOrder } = await world();
  const branchId = await branchOf();
  const order = await takeOrder({ prices: [100000] });
  await asStitching(order, items);
  ok(await pay(ops, { customerId, orderId: order.id, amount: 52500, mode: 'upi' }));
  const bill = await issued(ops, order);
  const noteRes = await credit(admin, bill, 10000);
  ok(noteRes);
  const note = noteRes.body.creditNote;

  const views = await all(billingDocumentsInRange(branchId, {
    types: ['invoice', 'credit_note', 'receipt', 'receipt_voucher', 'refund'], from: ago(1), to: TODAY,
  }));
  const byType = (type) => views.filter((v) => v.type === type);
  expect(views.map((v) => v.type).sort()).toEqual(['credit_note', 'invoice', 'receipt', 'receipt_voucher']);

  const [inv] = byType('invoice');
  const stored = await Invoice.findById(bill.id).lean();
  expect(inv).toMatchObject({
    id: bill.id, status: 'issued', number: bill.number, date: TODAY,
    customer: { id: customerId, name: 'Asha Rao', gstin: null, stateCode: expect.any(String), registered: false },
    placeOfSupply: { stateCode: '29', interState: false },
    totals: {
      taxable: stored.totals.taxable, cgst: stored.totals.cgst, sgst: stored.totals.sgst, igst: 0,
      tax: stored.totals.tax, roundOff: stored.totals.roundOff, total: stored.totals.total,
    },
    original: null,
  });
  expect(inv.lines).toEqual(stored.snapshot.lines.map((l) => ({
    hsnSac: '998821', description: l.description, supplyType: 'service', unit: 'PCS', quantity: l.quantity,
    gstRateBp: 500, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: 0,
  })));
  // The advance taxed on the voucher, now used on the bill, at the voucher's state and rate.
  const adj = stored.advanceAdjustments;
  expect(adj).toHaveLength(1);
  expect(inv.advanceAdjustments).toEqual([
    { stateCode: '29', gstRateBp: 500, taxable: adj[0].taxable, cgst: adj[0].cgst, sgst: adj[0].sgst, igst: 0 },
  ]);

  const [cn] = byType('credit_note');
  expect(cn).toMatchObject({
    id: note.id, number: note.number, placeOfSupply: { stateCode: '29', interState: false },
    original: { id: bill.id, number: bill.number, date: TODAY, total: stored.totals.total, registered: false, interState: false },
    totals: expect.objectContaining({ taxable: 10000, total: note.totals.total }),
  });
  expect(cn.lines).toEqual([expect.objectContaining({ hsnSac: '998821', gstRateBp: 500, taxable: 10000, supplyType: 'service', unit: 'PCS' })]);

  const [rv] = byType('receipt_voucher');
  expect(rv.lines).toEqual([expect.objectContaining({ gstRateBp: 500, taxable: 50000, cgst: 1250, sgst: 1250, igst: 0 })]);
  expect(rv.totals).toMatchObject({ taxable: 50000, total: 52500 });
  const [rc] = byType('receipt');
  expect(rc).toMatchObject({ amount: 52500, mode: 'upi', totals: null, lines: [], placeOfSupply: null });
});

test('a refund view carries the voucher tax it gives back, at the voucher\'s state and rate', async () => {
  const { ops, admin, customerId, items, takeOrder } = await world();
  const branchId = await branchOf();
  const order = await takeOrder({ prices: [100000] });
  await asStitching(order, items);
  ok(await pay(ops, { customerId, orderId: order.id, amount: 105000, mode: 'cash' }));
  ok(await refund(admin, { customerId, orderId: order.id, amount: 21000 }));
  const [view] = await all(billingDocumentsInRange(branchId, { types: ['refund'], from: TODAY, to: TODAY }));
  expect(view).toMatchObject({ type: 'refund', amount: 21000, mode: 'cash' });
  expect(view.rvReversal).toEqual({ taxable: 20000, cgst: 500, sgst: 500, igst: 0, gstRateBp: 500, stateCode: '29' });
  expect(view.rvReversalParts).toEqual([{ stateCode: '29', gstRateBp: 500, taxable: 20000, cgst: 500, sgst: 500, igst: 0 }]);
});

test('an adjustment on a two-rate voucher is split pro rata over its lines, to the paisa', () => {
  const rv = {
    stateCode: '29',
    lines: [
      { rateBp: 500, gross: 63000, taxable: 60000, cgst: 1500, sgst: 1500, igst: 0 },
      { rateBp: 1800, gross: 23600, taxable: 20000, cgst: 1800, sgst: 1800, igst: 0 },
    ],
  };
  const parts = splitByVoucherLines({ taxable: 40001, cgst: 1651, sgst: 1649, igst: 0 }, rv);
  expect(parts.map((p) => [p.stateCode, p.gstRateBp])).toEqual([['29', 500], ['29', 1800]]);
  for (const head of ['taxable', 'cgst', 'sgst', 'igst']) {
    expect(parts.reduce((s, p) => s + p[head], 0)).toBe({ taxable: 40001, cgst: 1651, sgst: 1649, igst: 0 }[head]);
  }
  // Roughly 63000 : 23600 of each head.
  expect(parts[0].taxable).toBe(29100);
  // A one-rate voucher takes the whole adjustment.
  expect(splitByVoucherLines({ taxable: 100, cgst: 3, sgst: 2, igst: 0 }, { stateCode: '32', lines: [rv.lines[0]] })).toEqual([
    { stateCode: '32', gstRateBp: 500, taxable: 100, cgst: 3, sgst: 2, igst: 0 },
  ]);
});

test('document series give first, last, count and cancelled per series', async () => {
  const { ops, admin, takeOrder } = await world();
  const branchId = await branchOf();
  const bills = [];
  for (let i = 0; i < 3; i += 1) bills.push(await issued(ops, await takeOrder({ prices: [100000 + i] })));
  ok(await cancelBill(admin, bills[1]), 200);
  const noteRes = await credit(admin, bills[0], 1000);
  ok(noteRes);
  const prefixOf = (n) => n.slice(0, n.lastIndexOf('/'));

  expect(await documentSeries(branchId, { from: TODAY, to: TODAY })).toEqual([
    { nature: 'invoice', prefix: prefixOf(bills[0].number), from: bills[0].number, to: bills[2].number, total: 3, cancelled: 1 },
    { nature: 'credit_note', prefix: prefixOf(noteRes.body.creditNote.number), from: noteRes.body.creditNote.number, to: noteRes.body.creditNote.number, total: 1, cancelled: 0 },
  ]);
});

test('money drill-down rows sum to the figure', async () => {
  const { branchId, ops, take } = await history();
  on(ago(30));
  await issued(ops, await take());
  vi.restoreAllMocks();
  const range = { from: ago(40), to: TODAY };
  const sum = (rows) => rows.reduce((s, r) => s + r.amount, 0);
  const rowsOf = (metric) => pages((cursor) => moneyRows(branchId, metric, { ...range, cursor, limit: 1 }));

  const money = await periodMoney(branchId, range);
  const ageing = await receivablesAgeing(branchId, {});
  const billed = await rowsOf('billed');
  expect(billed).toHaveLength(money.invoices);
  expect(sum(billed)).toBe(money.billed);
  expect(billed[0]).toEqual({
    id: expect.any(String), type: 'invoice', number: expect.any(String), date: expect.any(String),
    customer: { id: expect.any(String), name: 'Asha Rao' }, amount: expect.any(Number),
  });
  expect(sum(await rowsOf('collected'))).toBe(money.collected);
  expect(sum(await rowsOf('outstanding'))).toBe(ageing.outstanding);
  expect(sum(await rowsOf('overdue_bills'))).toBe(ageing.overdueAmount);
  expect(ageing.overdueAmount).toBeGreaterThan(0);
  await expect(moneyRows(branchId, 'stock_value', range)).rejects.toThrow(RangeError);
});

test('billing report queries use indexes', async () => {
  await history();
  const branchId = await branchOf();
  const stages = (explained) => {
    const plan = explained.queryPlanner?.winningPlan ?? explained.stages?.[0]?.$cursor?.queryPlanner?.winningPlan;
    const names = [];
    const walk = (node) => {
      if (!node) return;
      names.push(node.stage);
      walk(node.inputStage);
      (node.inputStages ?? []).forEach(walk);
      walk(node.queryPlan);
    };
    walk(plan);
    return names;
  };
  const range = { from: ago(10), to: TODAY };
  const someId = String(new mongoose.Types.ObjectId());
  const finds = [
    [BillingDocument, periodMatch(branchId, range)],
    [BillingDocument, periodMatch(branchId, { ...range, customerFilter: { notIn: [someId] } })],
    [BillingDocument, receivablesMatch(branchId, { customerFilter: { in: [someId] } })],
    [BillingDocument, receiptsHeldMatch(branchId)],
    [Allocation, allocationsMatch(branchId)],
    [BillingDocument, orderDocsFilter(branchId, [someId])],
    [BillingDocument, invoicedOrdersMatch(branchId, range)],
    [BillingDocument, documentsFilter(branchId, { types: ['invoice', 'credit_note'], ...range })],
    [BillingDocument, seriesMatch(branchId, range)],
  ];
  for (const [Model, filter] of finds) {
    const names = stages(await Model.find(filter).explain('queryPlanner'));
    expect(names, JSON.stringify(filter)).toContain('IXSCAN');
    expect(names, JSON.stringify(filter)).not.toContain('COLLSCAN');
  }
});
