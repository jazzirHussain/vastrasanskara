import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { AuditLog } from '../src/core/audit/model.js';
import { Outbox } from '../src/core/notify/models.js';
import { emit } from '../src/core/notify/emit.js';
import { defineEvent } from '../src/core/notify/catalog.js';
useTestDb();
const app = buildTestApp();

defineEvent('test.client_ping', { recipients: ['client'], channels: ['email', 'whatsapp'], templates: { email: { subject: 's', body: 'b' }, whatsapp: { body: 'b' } } });
const ops = () => loginAs(app, { roles: ['operations'] });

test('creates a customer with the branch state by default', async () => {
  const { agent } = await ops();
  const r = await agent.post('/v1/customers').send({ name: ' Asha Rao ', phone: '98765 43210', email: 'Asha@X.com' });
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ id: expect.any(String), name: 'Asha Rao', phone: '+919876543210', email: 'asha@x.com', stateCode: '29', type: 'individual', source: 'walk_in', version: 0 });
  expect((await agent.get(`/v1/customers/${r.body.id}`)).body.name).toBe('Asha Rao');
});
test('same phone in another format is a duplicate', async () => {
  const { agent } = await ops();
  const first = await agent.post('/v1/customers').send({ name: 'Asha', phone: '9876543210' });
  const second = await agent.post('/v1/customers').send({ name: 'Asha R', phone: '+91 98765 43210' });
  expect(second.status).toBe(409);
  expect(second.body.error).toMatchObject({ code: 'PHONE_TAKEN', details: { customerId: first.body.id } });
  const third = await agent.post('/v1/customers').send({ name: 'Other', phone: '9123456789' });
  expect((await agent.patch(`/v1/customers/${third.body.id}`).send({ version: 0, phone: '098765 43210' })).body.error.code).toBe('PHONE_TAKEN');
});
test('search by name prefix and by phone digits', async () => {
  const { agent } = await ops();
  await agent.post('/v1/customers').send({ name: 'Asha Rao', phone: '9876543210' });
  await agent.post('/v1/customers').send({ name: 'Ashwin K', phone: '9123456789' });
  await agent.post('/v1/customers').send({ name: 'Bhavna', phone: '9000012345' });
  const names = async (q) => (await agent.get('/v1/customers').query({ q })).body.items.map((c) => c.name);
  expect(await names('ash')).toEqual(['Asha Rao', 'Ashwin K']);
  expect(await names('12345')).toEqual(['Ashwin K', 'Bhavna']);
  expect(await names('543 210')).toEqual(['Asha Rao']);
  expect(await names('a.*')).toEqual([]);
});
test('pages through 30 customers with a cursor', async () => {
  const { agent } = await ops();
  for (let i = 0; i < 30; i++) await agent.post('/v1/customers').send({ name: `Customer ${String(i).padStart(2, '0')}`, phone: `90000${String(i).padStart(5, '0')}` });
  const first = await agent.get('/v1/customers');
  expect(first.body.items).toHaveLength(25);
  const second = await agent.get('/v1/customers').query({ cursor: first.body.nextCursor });
  expect(second.body.items).toHaveLength(5);
  expect(second.body.nextCursor).toBeNull();
  expect(new Set([...first.body.items, ...second.body.items].map((c) => c.id)).size).toBe(30);
});
test('GSTIN change is audited', async () => {
  const { agent } = await ops();
  const c = await agent.post('/v1/customers').send({ name: 'Film Co', phone: '9876543210', type: 'film_production' });
  const r = await agent.patch(`/v1/customers/${c.body.id}`).send({ version: 0, gstin: '29ABCDE1234F1Z5' });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ gstin: '29ABCDE1234F1Z5', version: 1 });
  const audit = await AuditLog.findOne({ entityType: 'customer', action: 'update' }).lean();
  expect(audit.changes.map((ch) => ch.path)).toEqual(['gstin']);
  expect((await agent.patch(`/v1/customers/${c.body.id}`).send({ version: 1, gstin: '32ABCDE1234F1Z5' })).body.error.code).toBe('VALIDATION_FAILED');
  expect((await agent.patch(`/v1/customers/${c.body.id}`).send({ version: 0, name: 'Stale' })).status).toBe(409);
});
test('consent needs a note, also when added later', async () => {
  const { agent } = await ops();
  const c = await agent.post('/v1/customers').send({ name: 'Asha', phone: '9876543210' });
  expect((await agent.patch(`/v1/customers/${c.body.id}`).send({ version: 0, consent: { email: true, whatsapp: false, sms: false } })).body.error.code).toBe('VALIDATION_FAILED');
  expect((await agent.patch(`/v1/customers/${c.body.id}`).send({ version: 0, consent: { email: true, whatsapp: false, sms: false }, consentNote: 'Said yes at the counter' })).status).toBe(200);
});
test('designers can read but not create', async () => {
  const { agent } = await ops();
  const c = await agent.post('/v1/customers').send({ name: 'Asha', phone: '9876543210' });
  const { agent: designer } = await loginAs(app, { roles: ['designer'] });
  expect((await designer.get(`/v1/customers/${c.body.id}`)).status).toBe(200);
  expect((await designer.post('/v1/customers').send({ name: 'X', phone: '9123456789' })).status).toBe(403);
  expect((await designer.patch(`/v1/customers/${c.body.id}`).send({ version: 0, name: 'X' })).status).toBe(403);
  expect((await designer.get('/v1/customers/000000000000000000000000')).status).toBe(404);
});
test('client recipient resolver uses consent', async () => {
  const { agent, user } = await ops();
  const c = await agent.post('/v1/customers').send({ name: 'Asha', phone: '9876543210', email: 'asha@x.com', consent: { email: false, whatsapp: true, sms: false }, consentNote: 'WhatsApp only' });
  await emit('test.client_ping', { branchId: user.branchId, refId: 'p1', data: { customerId: c.body.id } });
  const entries = await Outbox.find({ event: 'test.client_ping' }).lean();
  const byChannel = Object.fromEntries(entries.map((e) => [e.channel, e]));
  expect(byChannel.email).toMatchObject({ status: 'skipped', skipReason: 'no_consent' });
  expect(byChannel.whatsapp).toMatchObject({ status: 'pending', recipient: { kind: 'client', id: c.body.id, address: '+919876543210' } });
});
