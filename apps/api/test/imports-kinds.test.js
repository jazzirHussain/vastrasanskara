import { test, expect, vi, afterEach } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { importHelpers, xlsx } from './helpers/imports.js';
import { AuditLog } from '../src/core/audit/model.js';
import { Outbox } from '../src/core/notify/models.js';
import { Customer } from '../src/modules/customers/model.js';
import { Vendor } from '../src/modules/vendors/model.js';
import { CatalogItem } from '../src/modules/catalog/model.js';
import { StockItem, StockMovement } from '../src/modules/stock/model.js';
import { ImportRun } from '../src/modules/imports/model.js';

useTestDb();
const app = buildTestApp();
const { world, check, add, rows, waitFor } = importHelpers(app);

afterEach(() => vi.restoreAllMocks());

const CUSTOMER_HEAD = ['Name', 'Phone', 'Email', 'State', 'GSTIN', 'Email OK?', 'How consent was given'];

test('customers are added with consent notes and states', async () => {
  const { admin } = await world();
  const run = await check(admin, 'customers', await xlsx([
    CUSTOMER_HEAD,
    ['Asha Rao', '98765 43210', 'Asha@Example.com', '', '', 'Yes', 'Signed the order form'],
    ['Kerala Silks', 9123456789, '', 'Kerala', '32ABCDE1234F1Z5', 'No', ''],
    ['No Consent', '9000000001', '', '', '', 'Yes', ''],
  ]));
  expect(run.counts).toMatchObject({ ready: 2, error: 1 });
  expect((await rows(admin, run.id, 'error'))[0].errors).toEqual([{ column: 'How consent was given', message: 'Say how the customer gave consent.' }]);
  const done = await add(admin, run);
  expect(done.counts.added).toBe(2);
  const asha = await Customer.findOne({ phone: '+919876543210' }).lean();
  expect(asha).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com', stateCode: '29', consent: { email: true }, consentNote: 'Signed the order form' });
  expect((await Customer.findOne({ phone: '+919123456789' }).lean()).stateCode).toBe('32');
});

test('a customer whose phone is already in the system is left as it is', async () => {
  const { admin } = await world();
  await admin.agent.post('/v1/customers').send({ name: 'Original Name', phone: '9876543210' });
  const run = await check(admin, 'customers', await xlsx([['Name', 'Mobile'], ['New Name', '+91 98765 43210'], ['Other', '9123456789']]));
  expect(run.counts).toMatchObject({ ready: 1, exists: 1 });
  expect((await rows(admin, run.id, 'exists'))[0]).toMatchObject({ rowNo: 2, label: 'New Name' });
  await add(admin, run);
  expect((await Customer.findOne({ phone: '+919876543210' }).lean()).name).toBe('Original Name');
  expect(await Customer.countDocuments()).toBe(2);
});

test('vendors and price-list items are matched by name whatever the case', async () => {
  const { admin } = await world();
  await admin.agent.post('/v1/vendors').send({ name: 'Lakshmi Dyers' });
  const vendors = await check(admin, 'vendors', await xlsx([['Name', 'Services'], ['LAKSHMI  dyers', 'Dyeing'], ['Ravi Embroidery', 'Embroidery, Zari']]));
  expect(vendors.counts).toMatchObject({ ready: 1, exists: 1 });
  await add(admin, vendors);
  expect((await Vendor.findOne({ name: 'Ravi Embroidery' }).lean()).services).toEqual(['Embroidery', 'Zari']);

  const head = ['Name', 'Kind', 'Goods or service', 'HSN or SAC', 'GST rate %', 'Price'];
  const first = await check(admin, 'catalog', await xlsx([head, ['Hemming', 'Stitching service', 'Service', '998821', 5, 300]]));
  await add(admin, first);
  const again = await check(admin, 'catalog', await xlsx([head, ['  HEMMING ', 'Stitching service', 'Service', '998821', 5, 300], ['Fall and pico', 'Stitching service', 'Service', '998821', '5%', '₹150']]));
  expect(again.counts).toMatchObject({ ready: 1, exists: 1 });
  await add(admin, again);
  expect(await CatalogItem.countDocuments()).toBe(2);
  expect((await CatalogItem.findOne({ name: 'Fall and pico' }).lean()).defaultPrice).toBe(15000);
});

test('a price-list row with a garment type already mapped is reported, the rest are added', async () => {
  const { admin } = await world();
  const head = ['Name', 'Kind', 'Goods or service', 'HSN or SAC', 'GST rate %', 'Garment types'];
  const run = await check(admin, 'catalog', await xlsx([
    head,
    ['Blouse stitching', 'Stitching service', 'Service', '998821', 5, 'Blouse'],
    ['Blouse premium', 'Stitching service', 'Service', '998821', 5, 'blouse'],
    ['Lehenga stitching', 'Stitching service', 'Service', '998821', 5, 'Lehenga'],
    ['Saree', 'Garment', 'Goods', '5007', 5, 'Spacesuit'],
  ]));
  expect(run.counts).toMatchObject({ ready: 3, error: 1 });
  expect((await rows(admin, run.id, 'error'))[0].errors[0]).toMatchObject({ column: 'Garment types' });
  const done = await add(admin, run);
  expect(done.counts).toMatchObject({ added: 2, failed: 1 });
  const [failed] = await rows(admin, run.id, 'failed');
  expect(failed).toMatchObject({ rowNo: 3, errors: [{ column: null, message: 'Another item already bills this' }] });
});

test('stock comes in with an opening movement at its cost', async () => {
  const { admin } = await world();
  const head = ['Name', 'Brand', 'Colour', 'Unit', 'Bought in', 'Units in one', 'Quantity in stock', 'Cost per unit'];
  const run = await check(admin, 'stock', await xlsx([head, ['Raw silk', 'Mysore', 'Red', 'm', 'roll', 25, '2.5', '₹400'], ['Thread', '', '', 'spool', 'box', 10, '', '']]));
  expect(run.counts).toMatchObject({ ready: 2 });
  await add(admin, run);
  const silk = await StockItem.findOne({ name: 'Raw silk' }).lean();
  expect(silk).toMatchObject({ onHand: 2500, value: 100000, brand: 'Mysore', colour: 'Red' });
  const moves = await StockMovement.find({ stockItemId: silk._id }).lean();
  expect(moves.map((m) => m.type)).toEqual(['opening']);
  expect(await AuditLog.countDocuments({ entityType: 'stock_item', entityId: String(silk._id), action: 'create', userAgent: `import:${run.id}` })).toBe(1);
  expect((await StockItem.findOne({ name: 'Thread' }).lean()).onHand).toBe(0);

  const again = await check(admin, 'stock', await xlsx([head, ['raw SILK', 'mysore', 'RED', 'm', 'roll', 25, '1', '400'], ['Raw silk', 'Mysore', 'Blue', 'm', 'roll', 25, '', '']]));
  expect(again.counts).toMatchObject({ ready: 1, exists: 1 });
});

test('stock without a cost cannot be added with quantity', async () => {
  const { admin } = await world();
  const run = await check(admin, 'stock', await xlsx([['Name', 'Unit', 'Bought in', 'Units in one', 'Quantity in stock'], ['Lace', 'm', 'roll', 50, 12]]));
  expect(run.counts).toMatchObject({ ready: 0, error: 1 });
  expect((await rows(admin, run.id, 'error'))[0].errors).toEqual([{ column: 'Cost per unit', message: 'Fill this in when there is stock.' }]);
});

test('an import interrupted half way resumes without duplicates', async () => {
  const { admin } = await world();
  const people = Array.from({ length: 60 }, (_, i) => [`Customer ${i + 1}`, `90000${String(i + 1).padStart(5, '0')}`]);
  const run = await check(admin, 'customers', await xlsx([['Name', 'Phone'], ...people]));
  expect(run.counts.ready).toBe(60);
  const create = Customer.create.bind(Customer);
  let calls = 0;
  vi.spyOn(Customer, 'create').mockImplementation((...args) => {
    calls += 1;
    if (calls === 30) throw new Error('connection lost');
    return create(...args);
  });
  const stopped = await add(admin, run);
  expect(stopped.status).toBe('failed');
  expect(stopped.fileError.message).toMatch(/Continue adding/);
  expect(stopped.counts.added).toBe(29);
  const stored = await ImportRun.findById(run.id).lean();
  expect(stored.nextRow).toBeGreaterThan(0);

  const r = await admin.agent.post(`/v1/imports/${run.id}/resume`).send({ version: stopped.version });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const done = await waitFor(admin, run.id, ['done']);
  expect(await Customer.countDocuments()).toBe(60);
  expect(new Set((await Customer.find().lean()).map((c) => c.phone)).size).toBe(60);
  expect(done.counts.added + done.counts.skipped).toBe(60);
  expect(done.counts.ready).toBe(0);
});

test('imported customers get no messages', async () => {
  const { admin } = await world();
  const run = await check(admin, 'customers', await xlsx([['Name', 'Phone', 'Email', 'Email OK?', 'WhatsApp OK?', 'How consent was given'], ['Asha', '9876543210', 'a@x.in', 'Yes', 'Yes', 'At the counter']]));
  await add(admin, run);
  expect(await Customer.countDocuments()).toBe(1);
  expect(await Outbox.countDocuments()).toBe(0);
});
