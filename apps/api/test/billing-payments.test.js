import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { financialYear } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { today } from './helpers/production.js';
import { clock } from '../src/clock.js';
import { AuditLog } from '../src/core/audit/model.js';
import { Branch } from '../src/modules/branches/model.js';
import { Garment } from '../src/modules/orders/model.js';
import { PeriodLock } from '../src/modules/periods/model.js';
import { Allocation, Invoice, Receipt, ReceiptVoucher } from '../src/modules/billing/model.js';

useTestDb();
const app = buildTestApp();
const { world, draftFor, issue, pay, act } = billingHelpers(app);

const fy = () => financialYear(clock.now()).code;
const branchIdOf = async () => (await Branch.findOne())._id;
const counterValue = async (docType) =>
  (await mongoose.connection.collection('counters').findOne({ _id: `doc:${await branchIdOf()}:${docType}:${fy()}` }))?.value ?? 0;
/** Bills these garments of the order as stitching (a service) instead of the blouse item. */
const asStitching = async (order, items, indexes = order.garments.map((_, i) => i)) => {
  for (const i of indexes) await Garment.updateOne({ _id: order.garments[i].id }, { catalogItemId: items.stitching.id });
};
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);

test('an advance for a ready-made garment gets a receipt only', async () => {
  const { ops, customerId, takeOrder } = await world();
  const order = await takeOrder({ prices: [450000] });
  const r = await pay(ops, { customerId, orderId: order.id, amount: 100000, mode: 'cash', receivedOn: today() });
  ok(r);
  expect(r.body.receipt).toMatchObject({
    type: 'receipt', status: 'issued', number: `RCPT/${fy()}/0001`, date: today(), amount: 100000, mode: 'cash',
    reference: '', receivedOn: today(), note: '', customer: { id: customerId, name: 'Asha Rao' },
    order: { id: order.id, orderNo: order.orderNo }, allocations: [], unallocated: 100000, receiptVoucher: null,
    pdf: { status: 'pending' }, cancellation: null,
  });
  const stored = await Receipt.findById(r.body.receipt.id).lean();
  expect(stored.snapshot).toMatchObject({
    docType: 'receipt', title: 'Payment receipt', number: `RCPT/${fy()}/0001`, date: today(), amount: 100000,
    amountInWords: 'Rupees One Thousand Only', mode: 'cash', receivedOn: today(), against: { orderNo: order.orderNo },
    seller: { gstin: '29ABCDE1234F1Z5' }, customer: { name: 'Asha Rao' },
  });
  expect(await ReceiptVoucher.countDocuments()).toBe(0);
  expect(await AuditLog.countDocuments({ entityType: 'receipt', action: 'create' })).toBe(1);
});

test('an advance for stitching also gets a receipt voucher with GST', async () => {
  const { ops, customerId, items, takeOrder } = await world();
  const order = await takeOrder({ prices: [100000] });
  await asStitching(order, items);
  const r = await pay(ops, { customerId, orderId: order.id, amount: 105000, mode: 'upi', reference: 'UPI-1' });
  ok(r);
  const { receipt } = r.body;
  expect(receipt.receiptVoucher).toMatchObject({ number: `RV/${fy()}/0001`, taxable: 100000, cgst: 2500, sgst: 2500, igst: 0 });

  const rv = await ReceiptVoucher.findById(receipt.receiptVoucher.id).lean();
  expect(rv).toMatchObject({ status: 'issued', gross: 105000, taxable: 100000, cgst: 2500, sgst: 2500, igst: 0, pdf: { status: 'pending' } });
  expect(String(rv.receiptId)).toBe(receipt.id);
  expect(rv.snapshot).toMatchObject({
    docType: 'receipt_voucher', title: 'Receipt voucher', number: `RV/${fy()}/0001`, date: today(),
    placeOfSupply: { stateCode: '29', interState: false }, against: { orderNo: order.orderNo }, receiptNo: receipt.number,
    totals: { gross: 105000, taxable: 100000, cgst: 2500, sgst: 2500, igst: 0 },
    amountInWords: 'Rupees One Thousand Fifty Only',
  });
  expect(rv.snapshot.lines).toEqual([expect.objectContaining({ rateBp: 500, gross: 105000, taxable: 100000 })]);
  expect(String((await Receipt.findById(receipt.id).lean()).receiptVoucherId)).toBe(String(rv._id));
  expect(await AuditLog.countDocuments({ entityType: 'receipt_voucher', action: 'create' })).toBe(1);

  const read = await ops.agent.get(`/v1/billing/receipt-vouchers/${rv._id}`);
  ok(read, 200);
  expect(read.body.receiptVoucher).toMatchObject({
    id: String(rv._id), type: 'receipt_voucher', number: `RV/${fy()}/0001`, date: today(), receiptId: receipt.id,
    gross: 105000, taxable: 100000, cgst: 2500, sgst: 2500, igst: 0, pdf: { status: 'pending' },
  });
  expect(read.body.receiptVoucher.lines).toHaveLength(1);
});

test('a mixed order splits the advance by value', async () => {
  const { ops, customerId, items, takeOrder } = await world();
  // Blouse ₹4,500 + 12 % = ₹5,040 (goods); stitching ₹1,000 + 5 % = ₹1,050 (service); total ₹6,090.
  const order = await takeOrder({ prices: [450000, 100000] });
  await asStitching(order, items, [1]);
  const r = await pay(ops, { customerId, orderId: order.id, amount: 60900, mode: 'cash' });
  ok(r);
  expect(r.body.receipt.receiptVoucher).toMatchObject({ taxable: 10000, cgst: 250, sgst: 250, igst: 0 });
  expect((await ReceiptVoucher.findById(r.body.receipt.receiptVoucher.id).lean()).gross).toBe(10500);
});

test('an advance cannot exceed the order total', async () => {
  const { ops, customerId, takeOrder } = await world();
  const order = await takeOrder({ prices: [100000] }); // ₹1,050 with GST
  ok(await pay(ops, { customerId, orderId: order.id, amount: 50000, mode: 'cash' }));
  const r = await pay(ops, { customerId, orderId: order.id, amount: 60000, mode: 'cash' });
  expect([r.status, r.body.error.code, r.body.error.details]).toEqual([422, 'ADVANCE_EXCEEDS_TOTAL', { maxAmount: 55000 }]);
  expect(r.body.error.message).toBe('This is more than the order total');
  expect(await counterValue('receipt')).toBe(1);
  ok(await pay(ops, { customerId, orderId: order.id, amount: 55000, mode: 'cash' }));
});

test('paying a bill reduces its balance; paying more keeps the rest as advance', async () => {
  const { ops, customerId, takeOrder } = await world();
  const order = await takeOrder({ prices: [450000] }); // ₹5,040
  const bill = (await issue(ops, await draftFor(order))).body.invoice;
  const first = await pay(ops, { customerId, invoiceId: bill.id, amount: 200000, mode: 'card' });
  ok(first);
  expect(first.body.receipt).toMatchObject({
    allocations: [{ invoiceId: bill.id, number: bill.number, amount: 200000 }], unallocated: 0,
    order: { id: order.id },
  });
  expect((await Receipt.findById(first.body.receipt.id).lean()).snapshot.against).toEqual({ invoiceNo: bill.number });
  let view = (await ops.agent.get(`/v1/billing/invoices/${bill.id}`)).body.invoice;
  expect(view.settlement).toMatchObject({ paid: 200000, balance: 304000, payStatus: 'part_paid' });

  const second = await pay(ops, { customerId, invoiceId: bill.id, amount: 400000, mode: 'cash' });
  ok(second);
  expect(second.body.receipt).toMatchObject({ allocations: [{ invoiceId: bill.id, amount: 304000 }], unallocated: 96000 });
  view = (await ops.agent.get(`/v1/billing/invoices/${bill.id}`)).body.invoice;
  expect(view.settlement).toMatchObject({ paid: 504000, balance: 0, payStatus: 'paid' });

  const got = await ops.agent.get(`/v1/billing/payments/${second.body.receipt.id}`);
  ok(got, 200);
  expect(got.body.receipt).toMatchObject({ number: second.body.receipt.number, unallocated: 96000 });
});

test('a payment must match the customer', async () => {
  const { ops, customerId, takeOrder } = await world();
  const otherCustomer = (await ops.agent.post('/v1/customers').send({ name: 'Bina', phone: '9876500000' })).body.id;
  const order = await takeOrder();
  const bill = (await issue(ops, await draftFor(await takeOrder()))).body.invoice;
  const unknown = await pay(ops, { customerId: String(new mongoose.Types.ObjectId()), amount: 100, mode: 'cash' });
  expect([unknown.status, unknown.body.error.details[0].path]).toEqual([400, 'customerId']);
  const wrongOrder = await pay(ops, { customerId: otherCustomer, orderId: order.id, amount: 100, mode: 'cash' });
  expect([wrongOrder.status, wrongOrder.body.error.details[0].path]).toEqual([400, 'orderId']);
  const wrongBill = await pay(ops, { customerId: otherCustomer, invoiceId: bill.id, amount: 100, mode: 'cash' });
  expect([wrongBill.status, wrongBill.body.error.details[0].path]).toEqual([400, 'invoiceId']);
  const draft = await draftFor(await takeOrder());
  const notIssued = await pay(ops, { customerId, invoiceId: draft.id, amount: 100, mode: 'cash' });
  expect([notIssued.status, notIssued.body.error.details[0].path]).toEqual([400, 'invoiceId']);
  expect(await counterValue('receipt')).toBe(0);
});

test('the advance is applied when the bill is issued and the voucher is adjusted', async () => {
  const { ops, admin, customerId, items, takeOrder } = await world();
  const order = await takeOrder({ prices: [100000, 100000] });
  await asStitching(order, items);
  const paid = await pay(ops, { customerId, orderId: order.id, amount: 105000, mode: 'cash' });
  ok(paid);
  const rv = paid.body.receipt.receiptVoucher;
  expect(rv).toMatchObject({ taxable: 100000, cgst: 2500, sgst: 2500 });

  const [, rejected] = order.garments;
  await act(ops, rejected, { action: 'rejected', stage: 'order_taken', reason: 'Refused', resolution: 'refund' });
  const r = await issue(ops, await draftFor(order));
  ok(r);
  const bill = r.body.invoice;
  expect(bill.lines.map((l) => l.garmentId)).toEqual([order.garments[0].id]);
  expect(bill.settlement).toMatchObject({ advanceApplied: 105000, balance: bill.totals.total - 105000 });
  expect(bill.advanceAdjustments[0]).toEqual({ receiptVoucherId: rv.id, number: rv.number, taxable: 100000, tax: 5000 });

  const cancel = await admin.agent.post(`/v1/billing/payments/${paid.body.receipt.id}/cancel`).send({ reason: 'Wrong' });
  expect([cancel.status, cancel.body.error.code]).toEqual([422, 'VOUCHER_ADJUSTED']);
});

test('two payments at once never over-pay a bill', async () => {
  const { ops, customerId, takeOrder } = await world();
  const bill = (await issue(ops, await draftFor(await takeOrder({ prices: [95238] })))).body.invoice;
  expect(bill.settlement.balance).toBe(100000);
  const results = await Promise.all([1, 2].map(() => pay(ops, { customerId, invoiceId: bill.id, amount: 80000, mode: 'cash' })));
  expect(results.map((r) => r.status)).toEqual([201, 201]);
  const rows = await Allocation.find({ invoiceId: bill.id }).lean();
  expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(100000);
  expect(results.reduce((s, r) => s + r.body.receipt.unallocated, 0)).toBe(60000);
  expect((await Invoice.findById(bill.id).lean()).settlement.balance).toBe(0);
});

test('a payment replays with the same key', async () => {
  const { ops, customerId } = await world();
  const send = () => ops.agent.post('/v1/billing/payments').set('Idempotency-Key', 'pay-1').send({ customerId, amount: 50000, mode: 'cash' });
  const first = await send();
  const second = await send();
  expect([first.status, second.status]).toEqual([201, 201]);
  expect(second.headers['idempotent-replayed']).toBe('true');
  expect(second.body.receipt.number).toBe(first.body.receipt.number);
  expect(await Receipt.countDocuments()).toBe(1);
  const noKey = await ops.agent.post('/v1/billing/payments').send({ customerId, amount: 50000, mode: 'cash' });
  expect(noKey.status).toBe(400);
});

test('a payment in a locked month is refused', async () => {
  const { ops, customerId } = await world();
  await PeriodLock.create({ branchId: await branchIdOf(), month: today().slice(0, 7), locked: true });
  const r = await pay(ops, { customerId, amount: 50000, mode: 'cash' });
  expect([r.status, r.body.error.code]).toEqual([422, 'PERIOD_LOCKED']);
  expect(await counterValue('receipt')).toBe(0);
  expect(await Receipt.countDocuments()).toBe(0);
});

test('a receipt is cancelled in an open month and its money released', async () => {
  const { ops, admin, customerId, items, takeOrder } = await world();
  const bill = (await issue(ops, await draftFor(await takeOrder({ prices: [450000] })))).body.invoice;
  const onBill = (await pay(ops, { customerId, invoiceId: bill.id, amount: 200000, mode: 'cash' })).body.receipt;

  expect((await ops.agent.post(`/v1/billing/payments/${onBill.id}/cancel`).send({ reason: 'Wrong' })).status).toBe(403);
  const r = await admin.agent.post(`/v1/billing/payments/${onBill.id}/cancel`).send({ reason: 'Entered twice' });
  ok(r, 200);
  expect(r.body.receipt).toMatchObject({
    status: 'cancelled', number: onBill.number, cancellation: { reason: 'Entered twice' }, allocations: [], unallocated: 0,
  });
  const view = (await ops.agent.get(`/v1/billing/invoices/${bill.id}`)).body.invoice;
  expect(view.settlement).toMatchObject({ paid: 0, balance: 504000 });
  const rows = await Allocation.find({ receiptId: onBill.id }).sort({ at: 1 }).lean();
  expect(rows.map((x) => [x.amount, x.reason])).toEqual([[200000, 'payment'], [-200000, 'release_receipt_cancel']]);
  const twice = await admin.agent.post(`/v1/billing/payments/${onBill.id}/cancel`).send({ reason: 'Again' });
  expect([twice.status, twice.body.error.code]).toEqual([422, 'ALREADY_CANCELLED']);

  const order = await takeOrder({ prices: [100000] });
  await asStitching(order, items);
  const advance = (await pay(ops, { customerId, orderId: order.id, amount: 105000, mode: 'cash' })).body.receipt;
  ok(await admin.agent.post(`/v1/billing/payments/${advance.id}/cancel`).send({ reason: 'Customer changed mind' }), 200);
  const rv = await ReceiptVoucher.findById(advance.receiptVoucher.id).lean();
  expect(rv).toMatchObject({ status: 'cancelled', number: advance.receiptVoucher.number, cancellation: { reason: 'Customer changed mind' } });
  expect(await AuditLog.countDocuments({ entityType: 'receipt', action: 'cancel' })).toBe(2);
  expect(await AuditLog.countDocuments({ entityType: 'receipt_voucher', action: 'cancel' })).toBe(1);

  // Numbers are kept: the next receipt takes the next number.
  const next = (await pay(ops, { customerId, amount: 100, mode: 'cash' })).body.receipt;
  expect(next.number).toBe(`RCPT/${fy()}/0003`);
});

test('a receipt in a locked month cannot be cancelled', async () => {
  const { ops, admin, customerId } = await world();
  const receipt = (await pay(ops, { customerId, amount: 50000, mode: 'cash' })).body.receipt;
  await PeriodLock.create({ branchId: await branchIdOf(), month: today().slice(0, 7), locked: true });
  const r = await admin.agent.post(`/v1/billing/payments/${receipt.id}/cancel`).send({ reason: 'Wrong' });
  expect([r.status, r.body.error.code]).toEqual([422, 'PERIOD_LOCKED']);
  expect((await Receipt.findById(receipt.id).lean()).status).toBe('issued');
});

test('a refunded receipt cannot be cancelled', async () => {
  const { ops, admin, customerId } = await world();
  const receipt = (await pay(ops, { customerId, amount: 50000, mode: 'cash' })).body.receipt;
  const refunded = await admin.agent.post('/v1/billing/refunds').set('Idempotency-Key', 'refund-receipt-1')
    .send({ customerId, amount: 20000, mode: 'cash', reason: 'Not needed' });
  ok(refunded);
  const r = await admin.agent.post(`/v1/billing/payments/${receipt.id}/cancel`).send({ reason: 'Wrong' });
  expect([r.status, r.body.error.code]).toEqual([422, 'RECEIPT_REFUNDED']);
  expect((await Receipt.findById(receipt.id).lean()).status).toBe('issued');
});

test('operations record payments; designers cannot', async () => {
  const { ops, d1, customerId } = await world();
  expect((await pay(d1, { customerId, amount: 50000, mode: 'cash' })).status).toBe(403);
  const r = await pay(ops, { customerId, amount: 50000, mode: 'cash' });
  ok(r);
  expect((await d1.agent.get(`/v1/billing/payments/${r.body.receipt.id}`)).status).toBe(403);
});

// --- Fix round 1: an order payment settles the order's bills first ---------------------------

const lineBody = (l) => ({
  key: l.key, source: l.source, itemId: l.itemId, garmentId: l.garmentId, stageEventId: l.stageEventId,
  description: l.description, quantity: l.quantity, rate: l.rate, discount: l.discount, discountReason: l.discountReason,
});
/** Issues a bill for only the first `count` lines of the order's draft. */
const billFirst = async (ops, order, count) => {
  const draft = await draftFor(order);
  const saved = await ops.agent.put(`/v1/billing/invoices/${draft.id}`).send({
    version: draft.version, lines: draft.lines.slice(0, count).map(lineBody), invoiceDiscount: null, notes: '',
  });
  ok(saved, 200);
  const r = await issue(ops, saved.body.invoice);
  ok(r);
  return r.body.invoice;
};

test('a payment on a billed order reduces that bill', async () => {
  const { ops, customerId, takeOrder } = await world();
  const order = await takeOrder({ prices: [450000] }); // ₹5,040
  const bill = (await issue(ops, await draftFor(order))).body.invoice;
  const r = await pay(ops, { customerId, orderId: order.id, amount: 200000, mode: 'cash' });
  ok(r);
  expect(r.body.receipt).toMatchObject({
    allocations: [{ invoiceId: bill.id, number: bill.number, amount: 200000 }], unallocated: 0, receiptVoucher: null,
    order: { id: order.id },
  });
  const view = (await ops.agent.get(`/v1/billing/invoices/${bill.id}`)).body.invoice;
  expect(view.settlement).toMatchObject({ paid: 200000, balance: 304000 });
});

test('the excess over the bill stays as advance', async () => {
  const { ops, customerId, items, takeOrder } = await world();
  // Blouse ₹4,500 + 12 % = ₹5,040 is billed; stitching ₹1,000 + 5 % = ₹1,050 is not yet.
  const order = await takeOrder({ prices: [450000, 100000] });
  await asStitching(order, items, [1]);
  const bill = await billFirst(ops, order, 1);
  expect(bill.totals.total).toBe(504000);

  const r = await pay(ops, { customerId, orderId: order.id, amount: 609000, mode: 'cash' });
  ok(r);
  expect(r.body.receipt).toMatchObject({ allocations: [{ invoiceId: bill.id, amount: 504000 }], unallocated: 105000 });
  expect(r.body.receipt.receiptVoucher).toMatchObject({ taxable: 100000, cgst: 2500, sgst: 2500 });
  const over = await pay(ops, { customerId, orderId: order.id, amount: 100, mode: 'cash' });
  expect([over.status, over.body.error.code, over.body.error.details]).toEqual([422, 'ADVANCE_EXCEEDS_TOTAL', { maxAmount: 0 }]);

  // Once everything is billed, money above the bills is kept as advance on the order (no voucher).
  const done = await takeOrder({ prices: [450000] });
  const doneBill = (await issue(ops, await draftFor(done))).body.invoice;
  const extra = await pay(ops, { customerId, orderId: done.id, amount: 600000, mode: 'cash' });
  ok(extra);
  expect(extra.body.receipt).toMatchObject({ allocations: [{ invoiceId: doneBill.id, amount: 504000 }], unallocated: 96000, receiptVoucher: null });
});

test('two advances at once on one order cannot exceed its total', async () => {
  const { ops, customerId, takeOrder } = await world();
  const order = await takeOrder({ prices: [100000] }); // ₹1,050 with GST
  const results = await Promise.all([1, 2].map(() => pay(ops, { customerId, orderId: order.id, amount: 60000, mode: 'cash' })));
  expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
  expect(results.find((r) => r.status === 422).body.error).toMatchObject({ code: 'ADVANCE_EXCEEDS_TOTAL', details: { maxAmount: 45000 } });
  expect(await Receipt.countDocuments()).toBe(1);
});

test('a receipt voucher needs the shop GSTIN', async () => {
  const { ops, customerId, items, takeOrder } = await world();
  const order = await takeOrder({ prices: [100000] });
  await asStitching(order, items);
  await Branch.updateOne({}, { gstin: null });
  const r = await pay(ops, { customerId, orderId: order.id, amount: 105000, mode: 'cash' });
  expect([r.status, r.body.error.code]).toEqual([422, 'BRANCH_GSTIN_MISSING']);
  expect(await counterValue('receipt')).toBe(0);
  // Goods only (no voucher) is still a receipt.
  ok(await pay(ops, { customerId, orderId: (await takeOrder({ prices: [100000] })).id, amount: 50000, mode: 'cash' }));
});
