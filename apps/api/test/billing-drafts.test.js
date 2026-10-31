import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { Branch } from '../src/modules/branches/model.js';
import { Customer } from '../src/modules/customers/model.js';
import { Garment, Order } from '../src/modules/orders/model.js';
import { Invoice } from '../src/modules/billing/model.js';
import { updateDraft } from '../src/modules/billing/service.js';

useTestDb();
const app = buildTestApp();
const { world, draftFor, act, advanceTo, history } = billingHelpers(app);
const { ObjectId } = mongoose.Types;

const FROM_ORDER = '/v1/billing/invoices/from-order';
const lineBody = (l) => ({
  key: l.key, source: l.source, itemId: l.itemId, garmentId: l.garmentId, stageEventId: l.stageEventId,
  description: l.description, quantity: l.quantity, rate: l.rate, discount: l.discount, discountReason: l.discountReason,
});
const draftBody = (invoice, over = {}) => ({
  version: invoice.version, lines: invoice.lines.map(lineBody), invoiceDiscount: null, notes: '', ...over,
});
const put = (who, invoice, over) => who.agent.put(`/v1/billing/invoices/${invoice.id}`).send(draftBody(invoice, over));
const manual = (over = {}) => ({
  key: 'm1', source: 'manual', itemId: null, garmentId: null, stageEventId: null,
  description: 'Fall and pico', quantity: 1, rate: 10000, discount: 0, discountReason: '', ...over,
});
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// A bill in the books, built through the model (issuing comes later).
const issuedInvoice = (order, garmentIds = [], extra = {}) =>
  Invoice.create({
    branchId: order.branchId, customerId: order.customer.id, orderId: order.id, status: 'issued',
    number: `INV/2627/${String(Math.floor(Math.random() * 9000) + 1000)}`, fyCode: '2627', date: '2026-10-30', month: '2026-10',
    snapshot: { lines: [] }, garmentIds,
    totals: { gross: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, roundOff: 0, total: 0 },
    settlement: { advanceApplied: 0, paid: 0, credited: 0, balance: 0 }, ...extra,
  });
const branchIdOf = async () => (await Branch.findOne())._id;
const withBranch = async (order) => ({ ...order, branchId: await branchIdOf() });

test('create bill from an order lists every garment at its agreed price', async () => {
  const { ops, items, takeOrder } = await world();
  const order = await takeOrder({ prices: [450000, 250000] });
  const r = await ops.agent.post(FROM_ORDER).send({ orderId: order.id });
  expect(r.status).toBe(201);
  const inv = r.body.invoice;
  expect(inv).toMatchObject({ type: 'invoice', status: 'draft', number: null, version: 0, order: { id: order.id, orderNo: order.orderNo } });
  expect(inv.lines.map((l) => [l.key, l.source, l.rate, l.quantity, l.itemId])).toEqual(
    order.garments.map((g, i) => [`g-${g.id}`, 'garment', [450000, 250000][i], 1, items.blouse.id]),
  );
  expect(inv.lines[0]).toMatchObject({ description: `Blouse — Blouse (${order.garments[0].garmentNo})`, garmentId: order.garments[0].id });
  expect(inv.lines[0].item).toEqual({ name: 'Blouse', hsnSac: '6206', supplyType: 'goods', unit: 'PCS' });
  // Both pieces are above the clothing slab, so 12 %, split into CGST and SGST in the same state.
  expect(inv.totals).toMatchObject({ taxable: 700000, cgst: 42000, sgst: 42000, igst: 0, tax: 84000, total: 784000 });
  expect(inv.placeOfSupply).toMatchObject({ stateCode: '29', interState: false });
  expect(inv.warnings).toEqual([]);
  expect(inv.settlement).toBeNull();
});

test('rejected and cancelled garments are left off', async () => {
  const { ops, takeOrder } = await world();
  const order = await takeOrder({ prices: [100000, 200000, 300000] });
  await act(ops, order.garments[0], { action: 'rejected', stage: 'order_taken', reason: 'Refused', resolution: 'refund' });
  await Garment.updateOne({ _id: order.garments[1].id }, { status: 'cancelled' });
  const inv = await draftFor(order);
  expect(inv.lines.map((l) => l.garmentId)).toEqual([order.garments[2].id]);
});

test('a remade garment is billed, the rejected one is not', async () => {
  const { ops, takeOrder } = await world();
  const order = await takeOrder();
  await act(ops, order.garments[0], { action: 'rejected', stage: 'order_taken', reason: 'Wrong fit', resolution: 'remake' });
  const inv = await draftFor(order);
  expect(inv.lines).toHaveLength(1);
  expect(inv.lines[0]).toMatchObject({ rate: 450000, description: expect.stringContaining(`${order.orderNo}-02`) });
});

test('chargeable rework and alteration become extra lines', async () => {
  const { d1, admin, items, takeOrder } = await world();
  const order = await takeOrder({ prices: [450000, 450000, 450000] });
  const [a, b, c] = order.garments;
  const qc = { action: 'qc_fail', reworkStage: 'handwork', chargeable: true };
  await act(admin, await advanceTo(d1, a, 'quality_check'), { ...qc, chargeAmount: 50000 });
  await act(admin, await advanceTo(d1, b, 'quality_check'), qc);
  await act(admin, await advanceTo(d1, c, 'trials_fittings'), {
    action: 'alteration', stage: 'trials_fittings', chargeable: true, readyBy: inDays(5),
  });
  const inv = await draftFor(order);
  const events = [await history(admin, a), await history(admin, b), await history(admin, c)].map((h) => h.at(-1));
  const charges = inv.lines.filter((l) => l.source === 'charge');
  expect(charges.map((l) => [l.key, l.itemId, l.rate])).toEqual([
    [`e-${events[0].id}`, items.rework.id, 50000],
    [`e-${events[1].id}`, items.rework.id, 30000],
    [`e-${events[2].id}`, items.alteration.id, 20000],
  ]);
  expect(charges[0].description).toBe(`Rework — Blouse (${a.garmentNo})`);
  expect(charges[2].description).toBe(`Alteration — Blouse (${c.garmentNo})`);
  expect(charges[0].stageEventId).toBe(events[0].id);
  expect(inv.lines).toHaveLength(6);
  expect(inv.lines.slice(0, 3).every((l) => l.source === 'garment')).toBe(true);
});

test('a charge without a price list item is flagged', async () => {
  const { d1, admin, items, takeOrder } = await world();
  await admin.agent.patch(`/v1/catalog/items/${items.rework.id}`).send({ version: 0, active: false });
  const order = await takeOrder();
  await act(admin, await advanceTo(d1, order.garments[0], 'quality_check'), { action: 'qc_fail', reworkStage: 'handwork', chargeable: true });
  const inv = await draftFor(order);
  const charge = inv.lines.find((l) => l.source === 'charge');
  expect(charge).toMatchObject({ itemId: null, item: null, rate: 0 });
  expect(inv.warnings).toEqual(
    expect.arrayContaining([{ code: 'ITEM_REQUIRED', lineKey: charge.key }, { code: 'PRICE_NEEDED', lineKey: charge.key }]),
  );
  expect(inv.totals).toBeNull();
});

test('free rework is not billed', async () => {
  const { d1, admin, takeOrder } = await world();
  const order = await takeOrder();
  await act(admin, await advanceTo(d1, order.garments[0], 'quality_check'), { action: 'qc_fail', reworkStage: 'handwork', chargeable: false });
  expect((await draftFor(order)).lines.map((l) => l.source)).toEqual(['garment']);
});

test('a rush order adds the rush charge', async () => {
  const { addItem, takeOrder } = await world();
  const rush = await addItem({
    name: 'Rush charge', kind: 'extra_charge', supplyType: 'service', hsnSac: '998821', defaultPrice: 100000,
    gstSlabs: [{ upToUnitPrice: null, rateBp: 1800 }], chargeFor: 'rush',
  });
  const normal = await draftFor(await takeOrder());
  expect(normal.lines.map((l) => l.source)).toEqual(['garment']);
  const inv = await draftFor(await takeOrder({ priority: 'rush' }));
  expect(inv.lines.map((l) => l.source)).toEqual(['garment', 'rush']);
  expect(inv.lines[1]).toMatchObject({ key: 'rush', itemId: rush.id, description: 'Rush charge', rate: 100000 });
});

test('garments already billed are not offered again', async () => {
  const { ops, takeOrder } = await world();
  const order = await withBranch(await takeOrder({ prices: [100000, 200000] }));
  const draft = await draftFor(order);
  expect(draft.warnings).toEqual([]);
  await issuedInvoice(order, [new ObjectId(order.garments[0].id)]);
  const reread = (await ops.agent.get(`/v1/billing/invoices/${draft.id}`)).body.invoice;
  expect(reread.warnings).toEqual([{ code: 'GARMENT_NOT_BILLABLE', lineKey: `g-${order.garments[0].id}` }]);
  const saved = await put(ops, draft);
  expect(saved.status).toBe(400);
  expect(saved.body.error.details[0].path).toBe('lines.0.garmentId');
  await ops.agent.delete(`/v1/billing/invoices/${draft.id}`);
  expect((await draftFor(order)).lines.map((l) => l.garmentId)).toEqual([order.garments[1].id]);
});

test('a second create opens the same draft', async () => {
  const { ops, takeOrder } = await world();
  const order = await takeOrder();
  const first = await ops.agent.post(FROM_ORDER).send({ orderId: order.id });
  const second = await ops.agent.post(FROM_ORDER).send({ orderId: order.id });
  expect([first.status, second.status]).toEqual([201, 200]);
  expect(second.body.invoice.id).toBe(first.body.invoice.id);
  expect(await Invoice.countDocuments({ orderId: order.id })).toBe(1);
});

test('nothing left to bill is refused', async () => {
  const { ops, takeOrder } = await world();
  const order = await withBranch(await takeOrder());
  await issuedInvoice(order, [new ObjectId(order.garments[0].id)]);
  const r = await ops.agent.post(FROM_ORDER).send({ orderId: order.id });
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('NOTHING_TO_BILL');
});

test('a cancelled order cannot be billed and an unknown one is not found', async () => {
  const { ops, takeOrder } = await world();
  const order = await takeOrder();
  await Order.updateOne({ _id: order.id }, { status: 'cancelled' });
  const r = await ops.agent.post(FROM_ORDER).send({ orderId: order.id });
  expect([r.status, r.body.error.code]).toEqual([422, 'INVALID_STATUS']);
  expect((await ops.agent.post(FROM_ORDER).send({ orderId: String(new ObjectId()) })).status).toBe(404);
});

test('editing a draft recomputes the totals', async () => {
  const { ops, items, takeOrder } = await world();
  const draft = await draftFor(await takeOrder());
  const lines = [
    { ...lineBody(draft.lines[0]), rate: 100000 },
    manual({ itemId: items.stitching.id, description: 'Lining', rate: 200000, quantity: 2 }),
  ];
  const r = await ops.agent.put(`/v1/billing/invoices/${draft.id}`).send({ version: 0, lines, invoiceDiscount: null, notes: 'Pick up Friday' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const inv = r.body.invoice;
  expect(inv).toMatchObject({ version: 1, notes: 'Pick up Friday' });
  // Blouse 1000.00 at the 5 % slab; lining 2 x 2000.00 at 5 %.
  expect(inv.lines[0]).toMatchObject({ taxable: 100000, gstRateBp: 500, cgst: 2500, sgst: 2500, igst: 0, total: 105000 });
  expect(inv.lines[1]).toMatchObject({ key: 'm1', taxable: 400000, gstRateBp: 500, cgst: 10000, sgst: 10000, total: 420000 });
  expect(inv.totals).toMatchObject({ gross: 500000, taxable: 500000, cgst: 12500, sgst: 12500, tax: 25000, total: 525000 });
  expect(inv.amountInWords).toMatch(/five thousand two hundred/i);
  const stale = await ops.agent.put(`/v1/billing/invoices/${draft.id}`).send({ version: 0, lines, invoiceDiscount: null, notes: '' });
  expect(stale.status).toBe(409);
});

test('an inactive item is refused', async () => {
  const { ops, admin, items, takeOrder } = await world();
  const draft = await draftFor(await takeOrder());
  await admin.agent.patch(`/v1/catalog/items/${items.stitching.id}`).send({ version: 0, active: false });
  const r = await put(ops, draft, { lines: [manual({ itemId: items.stitching.id })] });
  expect([r.status, r.body.error.details[0].path]).toEqual([400, 'lines.0.itemId']);
});

test('a discount needs discounts.give and a reason', async () => {
  const { ops, takeOrder } = await world();
  const draft = await draftFor(await takeOrder({ prices: [100000] }));
  const withDiscount = (over) => ({ ...lineBody(draft.lines[0]), discount: 10000, discountReason: 'Regular customer', ...over });
  const noReason = await put(ops, draft, { lines: [withDiscount({ discountReason: '' })] });
  expect([noReason.status, noReason.body.error.details[0].path]).toEqual([400, 'lines.0.discountReason']);
  const ok = await put(ops, draft, { lines: [withDiscount()], invoiceDiscount: { amount: 5000, reason: 'Festival' } });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  expect(ok.body.invoice).toMatchObject({ invoiceDiscount: { amount: 5000, reason: 'Festival' }, totals: { discount: 15000, taxable: 85000 } });
  expect(ok.body.invoice.lines[0]).toMatchObject({ discount: 10000, discountReason: 'Regular customer', invoiceDiscountShare: 5000 });

  // Without discounts.give (the roles in use all hold it, so ask the service directly).
  const without = { permissions: new Set(['billing.draft', 'money.view']) };
  const branchId = await branchIdOf();
  const patch = { lines: [withDiscount()], invoiceDiscount: null, notes: '' };
  await expect(updateDraft(branchId, draft.id, { version: 1, patch }, without, {})).rejects.toMatchObject({ status: 403 });
  const plain = { lines: [{ ...lineBody(draft.lines[0]), discount: 0, discountReason: '' }], invoiceDiscount: null, notes: '' };
  await expect(updateDraft(branchId, draft.id, { version: 1, patch: plain }, without, { userId: null })).resolves.toBeTruthy();
});

test('a discount larger than the line or the bill is refused', async () => {
  const { ops, takeOrder } = await world();
  const draft = await draftFor(await takeOrder({ prices: [100000] }));
  const big = await put(ops, draft, { lines: [{ ...lineBody(draft.lines[0]), discount: 100001, discountReason: 'Too much' }] });
  expect([big.status, big.body.error.code]).toEqual([422, 'DISCOUNT_EXCEEDS_LINE']);
  const bigBill = await put(ops, draft, { invoiceDiscount: { amount: 100001, reason: 'Too much' } });
  expect([bigBill.status, bigBill.body.error.code]).toEqual([422, 'DISCOUNT_EXCEEDS_TOTAL']);
});

test('garments cannot be added to a draft by hand', async () => {
  const { ops, customerId, takeOrder } = await world();
  const order = await takeOrder({ prices: [100000, 200000] });
  const blank = (await ops.agent.post('/v1/billing/invoices').send({ customerId })).body.invoice;
  const added = await put(ops, blank, { lines: [manual({ source: 'garment', garmentId: order.garments[0].id })] });
  expect([added.status, added.body.error.details[0].path]).toEqual([400, 'lines.0.garmentId']);
  const made = await put(ops, blank, { lines: [manual({ garmentId: String(new ObjectId()) })] });
  expect(made.status).toBe(400);
  const event = await put(ops, blank, { lines: [manual({ stageEventId: String(new ObjectId()) })] });
  expect(event.body.error.details[0].path).toBe('lines.0.stageEventId');
  // A real draft cannot take a second line for a garment it already carries, nor another order's garment.
  const draft = await draftFor(order);
  const twice = await put(ops, draft, { lines: [...draft.lines.map(lineBody), manual({ key: 'dup', garmentId: order.garments[0].id })] });
  expect(twice.status).toBe(400);
  const other = await takeOrder();
  const foreign = await put(ops, draft, { lines: [...draft.lines.map(lineBody), manual({ key: 'x', garmentId: other.garments[0].id })] });
  expect(foreign.status).toBe(400);
});

test('drafts are deleted, issued bills are not', async () => {
  const { ops, takeOrder } = await world();
  const order = await withBranch(await takeOrder({ prices: [100000, 200000] }));
  const draft = await draftFor(order);
  expect((await ops.agent.delete(`/v1/billing/invoices/${draft.id}`)).status).toBe(204);
  expect((await ops.agent.get(`/v1/billing/invoices/${draft.id}`)).status).toBe(404);
  expect(await Invoice.countDocuments({})).toBe(0);

  const issued = await issuedInvoice(order, [new ObjectId(order.garments[0].id)]);
  const id = String(issued._id);
  const edit = await ops.agent.put(`/v1/billing/invoices/${id}`).send({ version: 0, lines: [], invoiceDiscount: null, notes: '' });
  expect([edit.status, edit.body.error.code]).toEqual([422, 'DOCUMENT_IMMUTABLE']);
  const del = await ops.agent.delete(`/v1/billing/invoices/${id}`);
  expect([del.status, del.body.error.code]).toEqual([422, 'DOCUMENT_IMMUTABLE']);
  const view = await ops.agent.get(`/v1/billing/invoices/${id}`);
  expect(view.body.invoice).toMatchObject({ status: 'issued', number: issued.number, settlement: { balance: 0, payStatus: 'paid' } });
});

test('a missing item, price, address and branch GSTIN are flagged', async () => {
  const { ops, customerId, items } = await world();
  const blank = (await ops.agent.post('/v1/billing/invoices').send({ customerId })).body.invoice;
  expect(blank).toMatchObject({ lines: [], totals: null, order: null, version: 0 });
  const rough = await put(ops, blank, { lines: [manual({ rate: 0 })] });
  expect(rough.body.invoice.totals).toBeNull();
  expect(rough.body.invoice.warnings).toEqual(
    expect.arrayContaining([{ code: 'ITEM_REQUIRED', lineKey: 'm1' }, { code: 'PRICE_NEEDED', lineKey: 'm1' }]),
  );
  // A large bill to an unregistered customer needs an address.
  const big = await put(ops, rough.body.invoice, { lines: [manual({ itemId: items.stitching.id, rate: 6000000 })] });
  expect(big.status).toBe(200);
  expect(big.body.invoice.warnings).toEqual([{ code: 'ADDRESS_REQUIRED', lineKey: null }]);
  await Customer.updateOne({ _id: customerId }, { billingAddress: { line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' } });
  await Branch.updateOne({}, { gstin: null });
  const fixed = (await ops.agent.get(`/v1/billing/invoices/${blank.id}`)).body.invoice;
  expect(fixed.warnings).toEqual([{ code: 'BRANCH_GSTIN_MISSING', lineKey: null }]);
});

test('a customer in another state is billed IGST', async () => {
  const { ops, customerId, items } = await world();
  await Customer.updateOne({ _id: customerId }, { stateCode: '27' });
  const blank = (await ops.agent.post('/v1/billing/invoices').send({ customerId })).body.invoice;
  const r = await put(ops, blank, { lines: [manual({ itemId: items.stitching.id, rate: 100000 })] });
  expect(r.body.invoice.placeOfSupply).toMatchObject({ stateCode: '27', interState: true });
  expect(r.body.invoice.totals).toMatchObject({ cgst: 0, sgst: 0, igst: 5000, total: 105000 });
});

test('designers cannot see bills', async () => {
  const { d1, customerId, takeOrder } = await world();
  const order = await takeOrder();
  expect((await d1.agent.post(FROM_ORDER).send({ orderId: order.id })).status).toBe(403);
  expect((await d1.agent.post('/v1/billing/invoices').send({ customerId })).status).toBe(403);
  expect((await d1.agent.get(`/v1/billing/invoices/${new ObjectId()}`)).status).toBe(403);
});

test('operations make drafts', async () => {
  const { ops, customerId } = await world();
  const r = await ops.agent.post('/v1/billing/invoices').send({ customerId });
  expect(r.status).toBe(201);
  expect((await ops.agent.post('/v1/billing/invoices').send({ customerId: String(new ObjectId()) })).status).toBe(400);
  expect((await ops.agent.delete(`/v1/billing/invoices/${r.body.invoice.id}`)).status).toBe(204);
  const other = await loginAs(app, { roles: ['operations'] });
  expect((await other.agent.get(`/v1/billing/invoices/${new ObjectId()}`)).status).toBe(404);
});
