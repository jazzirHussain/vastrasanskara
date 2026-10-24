import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, createTestBranch, loginAs } from './helpers/app.js';
import { captureLogger } from './helpers/logs.js';
import { AuditLog } from '../src/core/audit/model.js';
import { Worker } from '../src/modules/workers/model.js';
useTestDb();
const { logger, lines } = captureLogger();
const app = buildTestApp({ logger });

const ops = () => loginAs(app, { roles: ['operations'] });

test('operations adds, edits and deactivates a worker', async () => {
  const { agent } = await ops();
  const created = await agent.post('/v1/workers').send({ name: ' Ravi ', skill: 'Master tailor', phone: '98765 43210' });
  expect(created.status).toBe(201);
  expect(created.body).toEqual({ id: expect.any(String), name: 'Ravi', skill: 'Master tailor', phone: '+919876543210', active: true, version: 0 });
  const edited = await agent.patch(`/v1/workers/${created.body.id}`).send({ version: 0, skill: 'Cutting master' });
  expect(edited.body).toMatchObject({ skill: 'Cutting master', version: 1 });
  const off = await agent.patch(`/v1/workers/${created.body.id}`).send({ version: 1, active: false });
  expect(off.body.active).toBe(false);
  expect((await agent.get('/v1/workers').query({ active: 'true' })).body.items).toEqual([]);
  expect((await agent.get('/v1/workers')).body.items.map((w) => w.name)).toEqual(['Ravi']);
});

test('designers can list active workers and vendors but not change them', async () => {
  const { agent } = await ops();
  const worker = (await agent.post('/v1/workers').send({ name: 'Sita' })).body;
  const vendor = (await agent.post('/v1/vendors').send({ name: 'Zari works', services: ['Embroidery'] })).body;
  const designer = await loginAs(app, { roles: ['designer'] });
  expect((await designer.agent.get('/v1/workers')).body.items.map((w) => w.id)).toEqual([worker.id]);
  expect((await designer.agent.get('/v1/vendors')).body.items.map((v) => v.id)).toEqual([vendor.id]);
  expect((await designer.agent.post('/v1/workers').send({ name: 'X' })).status).toBe(403);
  expect((await designer.agent.patch(`/v1/vendors/${vendor.id}`).send({ version: 0, name: 'Y' })).status).toBe(403);
});

test('a stale version is a conflict', async () => {
  const { agent } = await ops();
  const worker = (await agent.post('/v1/workers').send({ name: 'Sita' })).body;
  await agent.patch(`/v1/workers/${worker.id}`).send({ version: 0, skill: 'Handwork' });
  const stale = await agent.patch(`/v1/workers/${worker.id}`).send({ version: 0, skill: 'Beads' });
  expect(stale.status).toBe(409);
  expect(stale.body.error.code).toBe('CONFLICT');
  expect((await agent.patch('/v1/workers/0123456789abcdef01234567').send({ version: 0, skill: 'x' })).status).toBe(404);
});

test('vendor GSTIN must match the state code', async () => {
  const { agent } = await ops();
  const bad = await agent.post('/v1/vendors').send({ name: 'Dye house', gstin: '27ABCDE1234F1Z5', stateCode: '29' });
  expect(bad.status).toBe(400);
  const ok = await agent.post('/v1/vendors').send({ name: 'Dye house', gstin: '29ABCDE1234F1Z5' });
  expect(ok.body).toMatchObject({ stateCode: '29', gstin: '29ABCDE1234F1Z5', services: [], phone: null, active: true });
  // A patch changing only the GSTIN is checked against the stored state.
  const mismatch = await agent.patch(`/v1/vendors/${ok.body.id}`).send({ version: 0, gstin: '27ABCDE1234F1Z5' });
  expect(mismatch.status).toBe(400);
});

test('vendor changes are audited', async () => {
  const { agent } = await ops();
  const vendor = (await agent.post('/v1/vendors').send({ name: 'Dye house' })).body;
  await agent.patch(`/v1/vendors/${vendor.id}`).send({ version: 0, gstin: '29ABCDE1234F1Z5' });
  const entries = await AuditLog.find({ entityType: 'vendor', entityId: vendor.id }).sort({ seq: 1 }).lean();
  expect(entries.map((e) => e.action)).toEqual(['create', 'update']);
  expect(entries[1].changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'gstin', after: '29ABCDE1234F1Z5' })]));
});

test('lists are per branch and sorted by name', async () => {
  const { agent } = await ops();
  for (const name of ['Zoya', 'arun', 'Meena']) await agent.post('/v1/workers').send({ name });
  const other = await createTestBranch({ name: 'Other' });
  await Worker.create({ branchId: other._id, name: 'Elsewhere', searchName: 'elsewhere' });
  expect((await agent.get('/v1/workers')).body.items.map((w) => w.name)).toEqual(['arun', 'Meena', 'Zoya']);
});

test('phone numbers are not logged', async () => {
  const { agent } = await ops();
  lines.length = 0;
  const r = await agent.post('/v1/vendors').send({ name: 'Dye house', phone: '98765 4321x' });
  expect(r.status).toBe(400);
  expect(JSON.stringify(lines)).not.toContain('98765');
});
