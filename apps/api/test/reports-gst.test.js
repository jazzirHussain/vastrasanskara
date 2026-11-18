import { test, expect, vi, afterEach } from 'vitest';
import { GSTR1_COLUMNS, addDaysYmd, atIstTime } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { reportHelpers } from './helpers/reports.js';
import { today } from './helpers/production.js';
import { clock } from '../src/clock.js';
import { Customer } from '../src/modules/customers/model.js';
import { Garment } from '../src/modules/orders/model.js';
import { lockPeriod } from '../src/modules/periods/service.js';
import { ReportRun } from '../src/modules/reports/model.js';
import { getBuilder } from '../src/modules/reports/builders/index.js';
import { gstMonthDocs } from '../src/modules/reports/builders/gst.js';

useTestDb();
const app = buildTestApp();
const billing = billingHelpers(app);
const { request, waitFor, download, readXlsx } = reportHelpers(app);

afterEach(() => vi.restoreAllMocks());

let keys = 0;
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const TODAY = today();
const THIS_MONTH = TODAY.slice(0, 7);
const LAST_MONTH_END = addDaysYmd(`${THIS_MONTH}-01`, -1);
const LAST_MONTH = LAST_MONTH_END.slice(0, 7);
const at = (ymd, hhmm = '12:00') => vi.spyOn(clock, 'now').mockReturnValue(new Date(atIstTime(ymd, hhmm)));
const sheetOf = (out, name) => out.files[0].sheets.find((s) => s.name === name);
const build = async (kind, branchId, month) => getBuilder(kind)(branchId, { month }, { maxRows: 200_000 });

async function world() {
  const w = await billing.world();
  const branchId = String(w.admin.user.branchId);
  const customer = async (name, phone, fields) => {
    const r = await w.ops.agent.post('/v1/customers').send({ name, phone });
    ok(r);
    await Customer.updateOne({ _id: r.body.id }, fields);
    return r.body.id;
  };
  const orderFor = async (customerId, price) => {
    const r = await w.ops.agent.post('/v1/orders').set('Idempotency-Key', `g${++keys}`).send({
      customerId, designerId: String(w.d1.user._id), pickupDate: addDaysYmd(today(), 40),
      garments: [{ type: 'blouse', description: 'Blouse', agreedPrice: price, quantity: 1 }],
    });
    ok(r);
    return r.body;
  };
  const bill = async (order) => {
    const r = await billing.issue(w.ops, await billing.draftFor(order));
    ok(r);
    return r.body.invoice;
  };
  const credit = async (invoice, taxable) => {
    const r = await w.admin.agent.post(`/v1/billing/invoices/${invoice.id}/credit-notes`).set('Idempotency-Key', `gc${++keys}`)
      .send({ reason: 'Price reduced', lines: [{ key: invoice.lines[0].key, taxable }] });
    ok(r);
    return r.body.creditNote;
  };
  return { ...w, branchId, customer, orderFor, bill, credit };
}

/** Last month: B2CS, B2B (Maharashtra), B2CL (Kerala) bills, two credit notes, an advance with a receipt voucher, a cancelled bill. */
async function seedMonth(w) {
  const b2b = await w.customer('Sri Silks', '9876500011', { gstin: '27AAAPL1234C1Z5', stateCode: '27' });
  const kerala = await w.customer('Mini', '9876500012', { stateCode: '32', billingAddress: { line1: '1 Beach Road', city: 'Kochi', pincode: '682001' } });
  at(addDaysYmd(LAST_MONTH_END, -5));
  const small = await w.bill(await w.orderFor(w.customerId, 100000));
  const registered = await w.bill(await w.orderFor(b2b, 50000));
  const large = await w.bill(await w.orderFor(kerala, 12000000));
  const mistake = await w.bill(await w.orderFor(w.customerId, 60000));
  ok(await w.admin.agent.post(`/v1/billing/invoices/${mistake.id}/cancel`).send({ reason: 'Entered by mistake' }), 200);
  const noteB2b = await w.credit(registered, 10000);
  const noteSmall = await w.credit(small, 20000);
  const stitching = await w.orderFor(w.customerId, 100000);
  await Garment.updateOne({ _id: stitching.garments[0].id }, { catalogItemId: w.items.stitching.id });
  ok(await billing.pay(w.ops, { customerId: w.customerId, orderId: stitching.id, amount: 105000, mode: 'upi' }));
  vi.restoreAllMocks();
  return { small, registered, large, mistake, noteB2b, noteSmall };
}

test('the GSTR-1 file has the offline tool\'s sheets and headers', async () => {
  const w = await world();
  await seedMonth(w);
  const r = await request(w.admin, { kind: 'gstr1', format: 'xlsx', params: { month: LAST_MONTH } });
  ok(r, 202);
  const done = await waitFor(w.admin, r.body.report.id);
  expect(done).toMatchObject({ status: 'done', filename: expect.stringMatching(/^GSTR-1 \w+ \d{4}\.xlsx$/) });
  const sheets = await readXlsx((await download(w.admin, done.id)).body);
  expect(sheets.map((s) => s.name)).toEqual(Object.keys(GSTR1_COLUMNS));
  for (const s of sheets) expect(s.rows[0]).toEqual(GSTR1_COLUMNS[s.name].map((c) => c.label));
  // The shop's own GSTIN is not part of the return sheets.
  expect(sheets.flatMap((s) => s.rows.flat()).includes('29ABCDE1234F1Z5')).toBe(false);
});

test('a month with B2B, B2CL, B2CS bills, credit notes, an advance and a cancelled bill lands in the right sheets', async () => {
  const w = await world();
  const { small, registered, large, noteB2b } = await seedMonth(w);
  const out = await build('gstr1', w.branchId, LAST_MONTH);
  expect(sheetOf(out, 'b2b').rows).toEqual([
    expect.objectContaining({
      gstin: '27AAAPL1234C1Z5', receiverName: 'Sri Silks', invoiceNumber: registered.number, invoiceValue: registered.totals.total,
      placeOfSupply: '27-Maharashtra', rate: 5, taxableValue: registered.totals.taxable,
    }),
  ]);
  expect(sheetOf(out, 'b2cl').rows).toEqual([
    expect.objectContaining({ invoiceNumber: large.number, invoiceValue: large.totals.total, placeOfSupply: '32-Kerala', rate: 12, taxableValue: large.totals.taxable }),
  ]);
  expect(sheetOf(out, 'b2cs').rows).toEqual([
    expect.objectContaining({ type: 'OE', placeOfSupply: '29-Karnataka', rate: 5, taxableValue: small.totals.taxable - 20000 }),
  ]);
  expect(sheetOf(out, 'cdnr').rows).toEqual([
    expect.objectContaining({ gstin: '27AAAPL1234C1Z5', noteNumber: noteB2b.number, noteType: 'C', rate: 5, taxableValue: 10000, noteValue: noteB2b.totals.total }),
  ]);
  expect(sheetOf(out, 'cdnur').rows).toEqual([]);
  expect(sheetOf(out, 'at').rows).toEqual([
    { placeOfSupply: '29-Karnataka', applicablePercent: '', rate: 5, grossAdvanceReceived: 100000, cessAmount: 0 },
  ]);
  expect(sheetOf(out, 'docs').rows).toEqual([
    expect.objectContaining({ nature: 'Invoices for outward supply', totalNumber: 4, cancelled: 1 }),
    expect.objectContaining({ nature: 'Credit Note', totalNumber: 2, cancelled: 0 }),
    expect.objectContaining({ nature: 'Receipt Voucher', totalNumber: 1, cancelled: 0 }),
  ]);
  expect(sheetOf(out, 'hsn(b2b)').rows.map((r) => r.hsn)).toEqual(['6206']);
});

test('documents count in the month of their date', async () => {
  const w = await world();
  const order = await w.orderFor(w.customerId, 100000);
  const order2 = await w.orderFor(w.customerId, 90000);
  at(LAST_MONTH_END, '23:30');
  const late = await w.bill(order);
  // 00:30 IST on the 1st is still the previous day in UTC: the bill belongs to its IST date.
  at(`${THIS_MONTH}-01`, '00:30');
  const early = await w.bill(order2);
  vi.restoreAllMocks();
  expect(late.date).toBe(LAST_MONTH_END);
  expect(early.date).toBe(`${THIS_MONTH}-01`);
  expect((await gstMonthDocs(w.branchId, LAST_MONTH)).docs.map((d) => d.number)).toEqual([late.number]);
  expect((await gstMonthDocs(w.branchId, THIS_MONTH)).docs.map((d) => d.number)).toContain(early.number);
});

test('a locked month gives identical GST files', async () => {
  const w = await world();
  const { small } = await seedMonth(w);
  await lockPeriod(w.branchId, LAST_MONTH, { note: 'Filed' }, { userId: w.admin.user._id });
  const hashes = async () => {
    const out = [];
    for (const kind of ['gstr1', 'gstr3b']) {
      const r = await request(w.admin, { kind, format: 'xlsx', params: { month: LAST_MONTH } });
      ok(r, 202);
      await waitFor(w.admin, r.body.report.id);
      out.push((await ReportRun.findById(r.body.report.id).lean()).rowsHash);
    }
    return out;
  };
  const before = await hashes();
  expect(before.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
  // This month: a new bill and a credit note against last month's bill.
  await w.bill(await w.orderFor(w.customerId, 70000));
  await w.credit(small, 5000);
  expect(await hashes()).toEqual(before);
});

test('GSTR-3B uses claimable expense GST and shows tax to pay after set-off', async () => {
  const w = await world();
  const vendor = await w.admin.agent.post('/v1/vendors').send({ name: 'Bengaluru Silks', gstin: '29AAACV1234K1Z3', stateCode: '29' });
  ok(vendor);
  at(addDaysYmd(LAST_MONTH_END, -3));
  const bill = await w.bill(await w.orderFor(w.customerId, 100000));
  ok(await w.ops.agent.post('/v1/expenses').set('Idempotency-Key', `ge${++keys}`).send({
    date: addDaysYmd(LAST_MONTH_END, -3), category: 'material_purchase', payee: { vendorId: vendor.body.id, name: 'x' }, total: 118000, mode: 'cash',
    gst: { billNo: 'INV-77', billDate: addDaysYmd(LAST_MONTH_END, -3), rateBp: 1800, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0 },
  }));
  vi.restoreAllMocks();
  const [sheet] = (await build('gstr3b', w.branchId, LAST_MONTH)).files[0].sheets;
  expect(sheet.name).toBe('GSTR-3B summary');
  const row = (description) => sheet.rows.find((r) => r.description === description);
  expect(sheet.rows[0].description).toContain('GSTIN 29ABCDE1234F1Z5');
  expect(row('Outward taxable supplies')).toMatchObject({ section: '3.1(a)', taxable: bill.totals.taxable, cgst: bill.totals.cgst, sgst: bill.totals.sgst, igst: 0 });
  expect(row('Input tax credit (all other ITC)')).toMatchObject({ section: '4(A)(5)', cgst: 9000, sgst: 9000, igst: 0 });
  expect(row('Tax to pay in cash')).toMatchObject({ igst: 0, cgst: 0, sgst: 0 });
  expect(row('Credit carried forward')).toMatchObject({ igst: 0, cgst: 9000 - bill.totals.cgst, sgst: 9000 - bill.totals.sgst });
  expect(sheet.rows.at(-1).description).toBe('Estimate. Your accountant confirms before filing.');
});

test('a month with nothing gives empty sheets with headers', async () => {
  const w = await world();
  const out = await build('gstr1', w.branchId, LAST_MONTH);
  expect(out.files[0].sheets.map((s) => s.name)).toEqual(Object.keys(GSTR1_COLUMNS));
  expect(out.files[0].sheets.every((s) => s.rows.length === 0 && s.columns === GSTR1_COLUMNS[s.name])).toBe(true);
  const [summary] = (await build('gstr3b', w.branchId, LAST_MONTH)).files[0].sheets;
  expect(summary.rows.find((r) => r.description === 'Outward taxable supplies')).toMatchObject({ taxable: 0, igst: 0, cgst: 0, sgst: 0 });
  const r = await request(w.admin, { kind: 'gstr1', format: 'xlsx', params: { month: LAST_MONTH } });
  expect(await waitFor(w.admin, r.body.report.id)).toMatchObject({ status: 'done', rows: 0 });
});
