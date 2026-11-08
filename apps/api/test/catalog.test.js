import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { AuditLog } from '../src/core/audit/model.js';
import { getItemsByIds, itemForCharge, itemForGarmentType } from '../src/modules/catalog/service.js';

useTestDb();
const app = buildTestApp();

const admin = () => loginAs(app, { roles: ['admin'] });
const SLABS = [{ upToUnitPrice: 100000, rateBp: 500 }, { upToUnitPrice: null, rateBp: 1200 }];
const blouse = (extra = {}) => ({
  name: 'Blouse stitching', kind: 'stitching_service', supplyType: 'service', hsnSac: '998822',
  gstSlabs: SLABS, garmentTypes: ['blouse'], ...extra,
});
const rushItem = (extra = {}) => ({
  name: 'Rush charge', kind: 'extra_charge', supplyType: 'service', hsnSac: '998822',
  gstSlabs: [{ upToUnitPrice: null, rateBp: 1800 }], chargeFor: 'rush', ...extra,
});

test('an admin adds a garment item with clothing slabs', async () => {
  const { agent } = await admin();
  const r = await agent.post('/v1/catalog/items').send(blouse({ defaultPrice: 150000 }));
  expect(r.status).toBe(201);
  expect(r.body).toEqual({
    id: expect.any(String), name: 'Blouse stitching', kind: 'stitching_service', supplyType: 'service',
    hsnSac: '998822', unit: 'PCS', defaultPrice: 150000, gstSlabs: SLABS, garmentTypes: ['blouse'],
    chargeFor: null, stockItemId: null, active: true, version: 0,
  });
  const list = await agent.get('/v1/catalog/items').query({ kind: 'stitching_service', q: 'BLOU' });
  expect(list.body.items.map((i) => i.id)).toEqual([r.body.id]);
  expect((await agent.get('/v1/catalog/items').query({ active: 'false' })).body.items).toEqual([]);
});

test('operations can read the price list but not change it', async () => {
  const { agent } = await admin();
  const item = (await agent.post('/v1/catalog/items').send(blouse())).body;
  const ops = await loginAs(app, { roles: ['operations'] });
  expect((await ops.agent.get('/v1/catalog/items')).body.items).toHaveLength(1);
  expect((await ops.agent.post('/v1/catalog/items').send(blouse({ name: 'X' }))).status).toBe(403);
  expect((await ops.agent.patch(`/v1/catalog/items/${item.id}`).send({ version: 0, name: 'Y' })).status).toBe(403);
});

test('designers cannot read the price list', async () => {
  const { agent } = await loginAs(app, { roles: ['designer'] });
  expect((await agent.get('/v1/catalog/items')).status).toBe(403);
});

test('HSN changes are audited', async () => {
  const { agent } = await admin();
  const item = (await agent.post('/v1/catalog/items').send(blouse())).body;
  const r = await agent
    .patch(`/v1/catalog/items/${item.id}`)
    .send({ version: 0, hsnSac: '998821', gstSlabs: [{ upToUnitPrice: null, rateBp: 1800 }] });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ hsnSac: '998821', version: 1 });
  const entries = await AuditLog.find({ entityType: 'catalog_item', entityId: item.id }).sort({ seq: 1 }).lean();
  expect(entries.map((e) => e.action)).toEqual(['create', 'update']);
  const paths = entries[1].changes.map((c) => c.path);
  expect(paths).toContain('hsnSac');
  expect(paths.some((p) => p.startsWith('gstSlabs'))).toBe(true);
  expect(entries[1].changes.find((c) => c.path === 'hsnSac')).toMatchObject({ before: '998822', after: '998821' });
  // A change outside the tax fields leaves no new entry.
  await agent.patch(`/v1/catalog/items/${item.id}`).send({ version: 1, defaultPrice: 9900 });
  expect(await AuditLog.countDocuments({ entityType: 'catalog_item' })).toBe(2);
});

test('a patch is checked against the whole item', async () => {
  const { agent } = await admin();
  const item = (await agent.post('/v1/catalog/items').send(blouse())).body;
  const r = await agent.patch(`/v1/catalog/items/${item.id}`).send({ version: 0, hsnSac: '6204' });
  expect(r.status).toBe(400);
  expect(r.body.error.code).toBe('VALIDATION_FAILED');
  expect(r.body.error.details).toEqual([expect.objectContaining({ path: 'hsnSac' })]);
});

test('a garment type bills under one item only', async () => {
  const { agent } = await admin();
  const first = (await agent.post('/v1/catalog/items').send(blouse())).body;
  const clash = await agent.post('/v1/catalog/items').send(blouse({ name: 'Blouse again' }));
  expect(clash.status).toBe(422);
  expect(clash.body.error).toMatchObject({
    code: 'CATALOG_MAPPING_TAKEN',
    details: { itemId: first.id, name: 'Blouse stitching' },
  });
  await agent.patch(`/v1/catalog/items/${first.id}`).send({ version: 0, active: false });
  expect((await agent.post('/v1/catalog/items').send(blouse({ name: 'Blouse again' }))).status).toBe(201);
  // Re-activating the first now clashes with the second.
  const back = await agent.patch(`/v1/catalog/items/${first.id}`).send({ version: 1, active: true });
  expect(back.body.error.code).toBe('CATALOG_MAPPING_TAKEN');
});

test('one item per extra charge type', async () => {
  const { agent } = await admin();
  expect((await agent.post('/v1/catalog/items').send(rushItem())).status).toBe(201);
  const again = await agent.post('/v1/catalog/items').send(rushItem({ name: 'Rush 2' }));
  expect(again.status).toBe(422);
  expect(again.body.error.code).toBe('CATALOG_MAPPING_TAKEN');
  expect((await agent.post('/v1/catalog/items').send(rushItem({ name: 'Alter', chargeFor: 'alteration' }))).status).toBe(201);
});

test('unknown garment types are refused', async () => {
  const { agent } = await admin();
  const r = await agent.post('/v1/catalog/items').send(blouse({ garmentTypes: ['blouse', 'spaceship'] }));
  expect(r.status).toBe(400);
  expect(r.body.error.details).toEqual([expect.objectContaining({ path: 'garmentTypes.1' })]);
});

test('a stale version is a conflict', async () => {
  const { agent } = await admin();
  const item = (await agent.post('/v1/catalog/items').send(blouse())).body;
  await agent.patch(`/v1/catalog/items/${item.id}`).send({ version: 0, name: 'A' });
  const stale = await agent.patch(`/v1/catalog/items/${item.id}`).send({ version: 0, name: 'B' });
  expect(stale.status).toBe(409);
  expect((await agent.patch('/v1/catalog/items/0123456789abcdef01234567').send({ version: 0, name: 'x' })).status).toBe(404);
});

test('itemForGarmentType and itemForCharge find active items', async () => {
  const { agent, user } = await admin();
  const item = (await agent.post('/v1/catalog/items').send(blouse())).body;
  const rush = (await agent.post('/v1/catalog/items').send(rushItem())).body;
  expect(String((await itemForGarmentType(user.branchId, 'blouse'))._id)).toBe(item.id);
  expect(await itemForGarmentType(user.branchId, 'kurta')).toBeNull();
  expect(String((await itemForCharge(user.branchId, 'rush'))._id)).toBe(rush.id);
  expect(await itemForCharge(user.branchId, 'rework')).toBeNull();
  const map = await getItemsByIds(user.branchId, [item.id, rush.id, 'bad']);
  expect([...map.keys()].sort()).toEqual([item.id, rush.id].sort());
  await agent.patch(`/v1/catalog/items/${item.id}`).send({ version: 0, active: false });
  expect(await itemForGarmentType(user.branchId, 'blouse')).toBeNull();
});

test('only material price-list items can be linked to stock', async () => {
  const { agent } = await admin();
  const stock = (await agent.post('/v1/stock/items').set('Idempotency-Key', 'cs1').send({ name: 'Silk', usageUnit: 'm', purchaseUnit: 'm', factor: 1000 })).body.item;
  const material = { name: 'Silk by the metre', kind: 'material', supplyType: 'goods', hsnSac: '5007', gstSlabs: SLABS };
  const linked = await agent.post('/v1/catalog/items').send({ ...material, stockItemId: stock.id });
  expect(linked.status, JSON.stringify(linked.body)).toBe(201);
  expect(linked.body.stockItemId).toBe(stock.id);

  const notMaterial = await agent.post('/v1/catalog/items').send(blouse({ stockItemId: stock.id }));
  expect(notMaterial.status).toBe(400);
  expect(notMaterial.body.error.details.map((d) => d.path)).toContain('stockItemId');

  const unknown = await agent.post('/v1/catalog/items').send({ ...material, name: 'Other', stockItemId: '65f000000000000000000000' });
  expect(unknown.status).toBe(400);
  expect(unknown.body.error.details.map((d) => d.path)).toContain('stockItemId');

  const garment = (await agent.post('/v1/catalog/items').send(blouse())).body;
  const patched = await agent.patch(`/v1/catalog/items/${garment.id}`).send({ version: 0, stockItemId: stock.id });
  expect(patched.status).toBe(400);
  const unlinked = await agent.patch(`/v1/catalog/items/${linked.body.id}`).send({ version: 0, stockItemId: null });
  expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
  expect(unlinked.body.stockItemId).toBeNull();
});
