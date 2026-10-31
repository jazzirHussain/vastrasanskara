import { test, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { financialYear, istDate } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { today } from './helpers/production.js';
import { clock } from '../src/clock.js';
import { AuditLog } from '../src/core/audit/model.js';
import { Branch } from '../src/modules/branches/model.js';
import { Customer } from '../src/modules/customers/model.js';
import { Garment } from '../src/modules/orders/model.js';
import { Allocation, CreditNote, Invoice, Refund } from '../src/modules/billing/model.js';
import { suggestedRefund } from '../src/modules/billing/service.js';

useTestDb();
const app = buildTestApp();
const { world, draftFor, issue, pay } = billingHelpers(app);

afterEach(() => vi.restoreAllMocks());

let keys = 0;
const fy = () => financialYear(clock.now()).code;
const branchIdOf = async () => (await Branch.findOne())._id;
const counterValue = async (docType, fyCode = fy()) =>
  (await mongoose.connection.collection('counters').findOne({ _id: `doc:${await branchIdOf()}:${docType}:${fyCode}` }))?.value ?? 0;
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const at = (iso) => vi.spyOn(clock, 'now').mockReturnValue(new Date(iso));

const cancelBill = (who, bill, reason = 'Billed by mistake') =>
  who.agent.post(`/v1/billing/invoices/${bill.id}/cancel`).send({ reason });
const credit = (who, bill, body, key = `c${++keys}`) =>
  who.agent.post(`/v1/billing/invoices/${bill.id}/credit-notes`).set('Idempotency-Key', key).send({ reason: 'Price reduced', ...body });
const refund = (who, body, key = `r${++keys}`) =>
  who.agent.post('/v1/billing/refunds').set('Idempotency-Key', key).send({ mode: 'cash', reason: 'Order cancelled', ...body });
const billOf = async (who, bill) => (await who.agent.get(`/v1/billing/invoices/${bill.id}`)).body.invoice;
const receiptOf = async (who, receipt) => (await who.agent.get(`/v1/billing/payments/${receipt.id}`)).body.receipt;
const issued = async (ops, order) => {
  const r = await issue(ops, await draftFor(order));
  ok(r);
  return r.body.invoice;
};

// --- Cancelling a bill -------------------------------------------------------------------------

test('cancelling in an open month keeps the number and turns payments into advance', async () => {
  const { ops, admin, customerId, takeOrder } = await world();
  const order = await takeOrder({ prices: [450000] }); // ₹5,040
  const advance = (await pay(ops, { customerId, orderId: order.id, amount: 100000, mode: 'cash' })).body.receipt;
  const bill = await issued(ops, order);
  expect(bill.settlement).toMatchObject({ advanceApplied: 100000, balance: 404000 });
  const onBill = (await pay(ops, { customerId, invoiceId: bill.id, amount: 200000, mode: 'cash' })).body.receipt;

  const r = await cancelBill(admin, bill, 'Wrong customer');
  ok(r, 200);
  expect(r.body.invoice).toMatchObject({
    id: bill.id, status: 'cancelled', number: bill.number, date: bill.date, totals: bill.totals,
    cancellation: { reason: 'Wrong customer' },
    settlement: { advanceApplied: 0, paid: 0, credited: 0, balance: 0 },
  });
  const rows = await Allocation.find({ invoiceId: bill.id }).lean();
  expect(rows.reduce((s, x) => s + x.amount, 0)).toBe(0);
  expect(rows.filter((x) => x.reason === 'release_cancel').map((x) => x.amount).sort((a, b) => a - b)).toEqual([-200000, -100000]);
  expect((await receiptOf(ops, advance)).unallocated).toBe(100000);
  expect((await receiptOf(ops, onBill)).unallocated).toBe(200000);
  const stored = await Invoice.findById(bill.id).lean();
  expect(stored).toMatchObject({ status: 'cancelled', number: bill.number, snapshot: { number: bill.number } });
  expect(await AuditLog.countDocuments({ entityType: 'invoice', action: 'cancel' })).toBe(1);

  // The garments can be billed again, and the money held is applied to the new bill.
  const draft = await draftFor(order);
  expect(draft.lines.map((l) => l.garmentId)).toEqual([order.garments[0].id]);
  const again = (await issue(ops, draft)).body.invoice;
  expect(again.settlement).toMatchObject({ advanceApplied: 300000, balance: 204000 });

  const twice = await cancelBill(admin, bill);
  expect([twice.status, twice.body.error.code]).toEqual([422, 'ALREADY_CANCELLED']);
  const credited = await credit(admin, bill, { lines: [{ key: bill.lines[0].key, taxable: 100 }] });
  expect([credited.status, credited.body.error.code]).toEqual([422, 'INVALID_STATUS']);
});

test('cancelling in a locked month is refused', async () => {
  const { ops, admin, takeOrder } = await world();
  const order = await takeOrder({ prices: [450000] });
  const draft = await draftFor(order);
  const lastMonth = new Date(Date.now() - 40 * 24 * 3600_000);
  at(lastMonth.toISOString());
  const bill = (await issue(ops, draft)).body.invoice;
  vi.restoreAllMocks();
  const month = istDate(lastMonth).slice(0, 7);
  expect(bill.date.slice(0, 7)).toBe(month);
  ok(await admin.agent.post(`/v1/period-locks/${month}/lock`).send({}), 200);

  const r = await cancelBill(admin, bill);
  expect([r.status, r.body.error.code, r.body.error.details]).toEqual([422, 'PERIOD_LOCKED', { month }]);
  expect((await Invoice.findById(bill.id).lean()).status).toBe('issued');
  expect(await AuditLog.countDocuments({ entityType: 'invoice', action: 'cancel' })).toBe(0);
});

test('a cancelled number is never reused', async () => {
  const { ops, admin, takeOrder } = await world();
  const first = await issued(ops, await takeOrder());
  ok(await cancelBill(admin, first), 200);
  const second = await issued(ops, await takeOrder());
  expect([first.number, second.number]).toEqual([`INV/${fy()}/0001`, `INV/${fy()}/0002`]);
  expect(await Invoice.countDocuments({ number: first.number })).toBe(1);
});

test('a bill with a credit note cannot be cancelled', async () => {
  const { ops, admin, takeOrder } = await world();
  const bill = await issued(ops, await takeOrder());
  ok(await credit(admin, bill, { lines: [{ key: bill.lines[0].key, taxable: 10000 }] }));
  const r = await cancelBill(admin, bill);
  expect([r.status, r.body.error.code]).toEqual([422, 'HAS_CREDIT_NOTES']);
  expect((await Invoice.findById(bill.id).lean()).status).toBe('issued');
});

// --- Credit notes ------------------------------------------------------------------------------

test('a part credit note taxes at the original rate', async () => {
  const { ops, admin, customerId, takeOrder } = await world();
  await Customer.updateOne({ _id: customerId }, { stateCode: '27' });
  const bill = await issued(ops, await takeOrder({ prices: [100000, 200000, 300000] }));
  expect(bill.placeOfSupply).toMatchObject({ stateCode: '27', interState: true });
  const line = bill.lines[1]; // ₹2,000 at 12 % IGST

  const r = await credit(admin, bill, { lines: [{ key: line.key, taxable: 50000 }] });
  ok(r);
  const { creditNote, warnings } = r.body;
  expect(warnings).toEqual([]);
  expect(creditNote).toMatchObject({
    type: 'credit_note', status: 'issued', number: `CN/${fy()}/0001`, date: today(), reason: 'Price reduced',
    invoice: { id: bill.id, number: bill.number, date: bill.date },
    totals: { taxable: 50000, cgst: 0, sgst: 0, igst: 6000, tax: 6000, roundOff: 0, total: 56000 },
    pdf: { status: 'pending' },
  });
  expect(creditNote.lines).toEqual([
    { key: line.key, description: line.description, hsnSac: '6206', taxable: 50000, gstRateBp: 1200, cgst: 0, sgst: 0, igst: 6000, total: 56000 },
  ]);

  const stored = await CreditNote.findById(creditNote.id).lean();
  expect(String(stored.invoiceId)).toBe(bill.id);
  expect(stored.snapshot).toMatchObject({
    docType: 'credit_note', title: 'Credit note', number: creditNote.number, date: today(),
    seller: { gstin: '29ABCDE1234F1Z5' }, customer: { name: 'Asha Rao' },
    placeOfSupply: { stateCode: '27', interState: true }, original: { number: bill.number, date: bill.date },
    reason: 'Price reduced', amountInWords: 'Rupees Five Hundred Sixty Only',
  });
  expect(await AuditLog.countDocuments({ entityType: 'credit_note', action: 'create' })).toBe(1);

  const view = await billOf(ops, bill);
  expect(view.settlement).toMatchObject({ credited: 56000, balance: bill.totals.total - 56000 });
  expect(view.creditNotes).toEqual([
    {
      id: creditNote.id,
      number: creditNote.number,
      date: today(),
      total: 56000,
      lines: creditNote.lines.map(({ key, taxable, cgst, sgst, igst }) => ({ key, taxable, cgst, sgst, igst })),
    },
  ]);
  const read = await ops.agent.get(`/v1/billing/credit-notes/${creditNote.id}`);
  ok(read, 200);
  expect(read.body.creditNote).toEqual(creditNote);
});

test('a full credit note reverses the bill exactly', async () => {
  const { ops, admin, takeOrder } = await world();
  const bill = await issued(ops, await takeOrder({ prices: [450033, 100017] }));
  const r = await credit(admin, bill, { full: true, lines: [] });
  ok(r);
  const { creditNote } = r.body;
  for (const k of ['taxable', 'cgst', 'sgst', 'igst', 'tax', 'roundOff', 'total']) expect(creditNote.totals[k]).toBe(bill.totals[k]);
  expect(creditNote.lines.map((l) => [l.key, l.taxable, l.cgst, l.sgst, l.igst, l.total])).toEqual(
    bill.lines.map((l) => [l.key, l.taxable, l.cgst, l.sgst, l.igst, l.total]),
  );
  expect((await billOf(ops, bill)).settlement).toMatchObject({ credited: bill.totals.total, balance: 0 });
  const more = await credit(admin, bill, { lines: [{ key: bill.lines[0].key, taxable: 1 }] });
  expect([more.status, more.body.error.code]).toEqual([422, 'CREDIT_EXCEEDS_INVOICE']);
});

test('credit beyond what is left is refused', async () => {
  const { ops, admin, takeOrder } = await world();
  const bill = await issued(ops, await takeOrder({ prices: [100000] }));
  const key = bill.lines[0].key;
  ok(await credit(admin, bill, { lines: [{ key, taxable: 60000 }] }));
  for (const body of [
    { lines: [{ key, taxable: 40001 }] },
    { lines: [{ key: 'nope', taxable: 1 }] },
    { full: true, lines: [] },
  ]) {
    const r = await credit(admin, bill, body);
    expect([r.status, r.body.error.code], JSON.stringify(body)).toEqual([422, 'CREDIT_EXCEEDS_INVOICE']);
  }
  expect(await counterValue('credit_note')).toBe(1);
  ok(await credit(admin, bill, { lines: [{ key, taxable: 40000 }] }));
});

test('partial credits never credit more or less tax than the bill', async () => {
  const { ops, admin, takeOrder } = await world();
  const bill = await issued(ops, await takeOrder({ prices: [1050] })); // 5 %: CGST 26, SGST 26
  const line = bill.lines[0];
  expect([line.cgst, line.sgst]).toEqual([26, 26]);
  const notes = [];
  for (let i = 0; i < 3; i++) {
    const r = await credit(admin, bill, { lines: [{ key: line.key, taxable: 350 }] });
    ok(r);
    notes.push(r.body.creditNote.lines[0]);
  }
  expect(notes.reduce((s, l) => s + l.taxable, 0)).toBe(1050);
  expect(notes.reduce((s, l) => s + l.cgst, 0)).toBe(26);
  expect(notes.reduce((s, l) => s + l.sgst, 0)).toBe(26);
  expect(notes[2]).toMatchObject({ cgst: 8, sgst: 8, total: 366 });
  // The note that uses up the bill takes what is left of its total, so the notes add up to it.
  expect((await billOf(ops, bill)).settlement).toMatchObject({ credited: bill.totals.total, balance: 0 });
});

test('a credit note on a paid bill frees the money for a refund', async () => {
  const { ops, admin, customerId, takeOrder } = await world();
  const order = await takeOrder({ prices: [450000] }); // ₹5,040
  const bill = await issued(ops, order);
  const receipt = (await pay(ops, { customerId, invoiceId: bill.id, amount: 504000, mode: 'upi' })).body.receipt;
  ok(await credit(admin, bill, { lines: [{ key: bill.lines[0].key, taxable: 100000 }] })); // ₹1,120
  expect((await billOf(ops, bill)).settlement).toMatchObject({ paid: 392000, credited: 112000, balance: 0 });
  const released = await Allocation.find({ invoiceId: bill.id, reason: 'release_credit' }).lean();
  expect(released.map((x) => x.amount)).toEqual([-112000]);
  expect((await receiptOf(ops, receipt)).unallocated).toBe(112000);

  const r = await refund(admin, { customerId, orderId: order.id, amount: 112000, mode: 'upi' });
  ok(r);
  expect(r.body.refund).toMatchObject({ amount: 112000, sources: [{ receiptId: receipt.id, number: receipt.number, amount: 112000 }] });
  const more = await refund(admin, { customerId, orderId: order.id, amount: 1 });
  expect([more.status, more.body.error.code, more.body.error.details]).toEqual([422, 'REFUND_EXCEEDS_BALANCE', { available: 0 }]);
});

test('a credit note past the correction deadline warns', async () => {
  const { ops, admin, takeOrder } = await world();
  const year = Number(today().slice(0, 4)) - 3;
  const draft = await draftFor(await takeOrder({ prices: [100000] }));
  at(`${year}-05-01T06:00:00Z`);
  const bill = (await issue(ops, draft)).body.invoice;
  expect(bill.date).toBe(`${year}-05-01`);
  const key = bill.lines[0].key;

  at(`${year + 1}-11-15T06:00:00Z`);
  const near = await credit(admin, bill, { lines: [{ key, taxable: 100 }] });
  ok(near);
  expect(near.body.warnings).toEqual([{ code: 'CORRECTION_DEADLINE_NEAR', deadline: `${year + 1}-11-30` }]);

  vi.restoreAllMocks();
  const passed = await credit(admin, bill, { lines: [{ key, taxable: 100 }] });
  ok(passed);
  expect(passed.body.warnings).toEqual([{ code: 'CORRECTION_DEADLINE_PASSED', deadline: `${year + 1}-11-30` }]);
  expect(passed.body.creditNote.date).toBe(today());
});

// --- Refunds -----------------------------------------------------------------------------------

test('a refund within the advance held; more is refused', async () => {
  const { ops, admin, customerId } = await world();
  const older = (await pay(ops, { customerId, amount: 30000, mode: 'cash' })).body.receipt;
  const newer = (await pay(ops, { customerId, amount: 50000, mode: 'cash' })).body.receipt;

  const tooMuch = await refund(admin, { customerId, amount: 80001 });
  expect([tooMuch.status, tooMuch.body.error.code, tooMuch.body.error.details]).toEqual([422, 'REFUND_EXCEEDS_BALANCE', { available: 80000 }]);
  expect(await counterValue('refund')).toBe(0);

  const r = await refund(admin, { customerId, amount: 60000, reference: 'Cash back', reason: 'Not needed' });
  ok(r);
  expect(r.body.refund).toMatchObject({
    type: 'refund', status: 'issued', number: `RF/${fy()}/0001`, date: today(), amount: 60000, mode: 'cash',
    reference: 'Cash back', reason: 'Not needed', customer: { id: customerId, name: 'Asha Rao' }, order: null,
    sources: [{ receiptId: newer.id, number: newer.number, amount: 50000 }, { receiptId: older.id, number: older.number, amount: 10000 }],
    rvReversal: null, pdf: { status: 'pending' },
  });
  const rows = await Allocation.find({ refundId: r.body.refund.id }).lean();
  expect(rows.every((x) => x.reason === 'refund' && x.receiptId && x.invoiceId === null)).toBe(true);
  const stored = await Refund.findById(r.body.refund.id).lean();
  expect(stored.snapshot).toMatchObject({
    docType: 'refund', title: 'Refund voucher', number: `RF/${fy()}/0001`, date: today(), amount: 60000,
    amountInWords: 'Rupees Six Hundred Only', mode: 'cash', reference: 'Cash back', reason: 'Not needed', against: null,
    rvReversal: null, customer: { name: 'Asha Rao' }, seller: { gstin: '29ABCDE1234F1Z5' },
  });
  expect(await AuditLog.countDocuments({ entityType: 'refund', action: 'create' })).toBe(1);
  expect((await receiptOf(ops, newer)).unallocated).toBe(0);
  expect((await receiptOf(ops, older)).unallocated).toBe(20000);

  const again = await refund(admin, { customerId, amount: 20001 });
  expect([again.status, again.body.error.details]).toEqual([422, { available: 20000 }]);
  const read = await admin.agent.get(`/v1/billing/refunds/${r.body.refund.id}`);
  ok(read, 200);
  expect(read.body.refund).toEqual(r.body.refund);

  const other = (await ops.agent.post('/v1/customers').send({ name: 'Bina', phone: '9876500000' })).body.id;
  const wrong = await refund(admin, { customerId: other, amount: 100 });
  expect([wrong.status, wrong.body.error.details]).toEqual([422, { available: 0 }]);
});

test("a refund of a stitching advance reverses the voucher's GST", async () => {
  const { ops, admin, customerId, items, takeOrder } = await world();
  const order = await takeOrder({ prices: [100000] });
  await Garment.updateOne({ _id: order.garments[0].id }, { catalogItemId: items.stitching.id });
  const receipt = (await pay(ops, { customerId, orderId: order.id, amount: 105000, mode: 'cash' })).body.receipt;
  expect(receipt.receiptVoucher).toMatchObject({ taxable: 100000, cgst: 2500, sgst: 2500 });

  const half = await refund(admin, { customerId, orderId: order.id, amount: 52500 });
  ok(half);
  expect(half.body.refund).toMatchObject({
    order: { id: order.id, orderNo: order.orderNo },
    rvReversal: { gross: 52500, taxable: 50000, cgst: 1250, sgst: 1250, igst: 0 },
  });
  expect((await Refund.findById(half.body.refund.id).lean()).snapshot).toMatchObject({
    against: { orderNo: order.orderNo }, rvReversal: { gross: 52500, taxable: 50000, cgst: 1250, sgst: 1250, igst: 0 },
  });
  const rest = await refund(admin, { customerId, orderId: order.id, amount: 52500 });
  ok(rest);
  expect(rest.body.refund.rvReversal).toEqual({ gross: 52500, taxable: 50000, cgst: 1250, sgst: 1250, igst: 0 });
});

test('a cancelled order suggests the scheduled refund', async () => {
  const { ops, admin, customerId, takeOrder } = await world();
  ok(await admin.agent.put('/v1/settings').send({ cancellationRefundSchedule: [{ uptoStage: 'tailors', refundPercent: 80 }] }), 200);
  const order = await takeOrder({ prices: [450000] });
  ok(await pay(ops, { customerId, orderId: order.id, amount: 100001, mode: 'cash' }));
  const branchId = await branchIdOf();
  expect(await suggestedRefund(branchId, order.id)).toBeNull();

  ok(await ops.agent.post(`/v1/orders/${order.id}/cancel`).send({ version: order.version ?? 0, reason: 'Wedding called off' }), 200);
  expect(await suggestedRefund(branchId, order.id)).toEqual({ held: 100001, refundPercent: 80, suggested: 80001 });
});

test('refunds and credit notes replay with the same key', async () => {
  const { ops, admin, customerId, takeOrder } = await world();
  ok(await pay(ops, { customerId, amount: 50000, mode: 'cash' }));
  const first = await refund(admin, { customerId, amount: 10000 }, 'refund-1');
  const second = await refund(admin, { customerId, amount: 10000 }, 'refund-1');
  expect([first.status, second.status]).toEqual([201, 201]);
  expect(second.headers['idempotent-replayed']).toBe('true');
  expect(second.body.refund.number).toBe(first.body.refund.number);
  expect(await Refund.countDocuments()).toBe(1);

  const bill = await issued(ops, await takeOrder());
  const body = { lines: [{ key: bill.lines[0].key, taxable: 10000 }] };
  const a = await credit(admin, bill, body, 'cn-1');
  const b = await credit(admin, bill, body, 'cn-1');
  expect([a.status, b.status]).toEqual([201, 201]);
  expect(b.headers['idempotent-replayed']).toBe('true');
  expect(b.body).toEqual(a.body);
  expect(await CreditNote.countDocuments()).toBe(1);

  const noKey = await admin.agent.post('/v1/billing/refunds').send({ customerId, amount: 100, mode: 'cash', reason: 'x' });
  expect(noKey.status).toBe(400);
});

test('operations cannot cancel, credit or refund', async () => {
  const { ops, d1, customerId, takeOrder } = await world();
  ok(await pay(ops, { customerId, amount: 50000, mode: 'cash' }));
  const bill = await issued(ops, await takeOrder());
  for (const who of [ops, d1]) {
    expect((await cancelBill(who, bill)).status).toBe(403);
    expect((await credit(who, bill, { lines: [{ key: bill.lines[0].key, taxable: 100 }] })).status).toBe(403);
    expect((await refund(who, { customerId, amount: 100 })).status).toBe(403);
  }
  expect(await CreditNote.countDocuments()).toBe(0);
  expect(await Refund.countDocuments()).toBe(0);
  expect((await Invoice.findById(bill.id).lean()).status).toBe('issued');
});
