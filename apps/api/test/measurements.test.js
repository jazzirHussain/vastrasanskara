import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { captureLogger } from './helpers/logs.js';
import { Measurement } from '../src/modules/measurements/model.js';
useTestDb();
const { logger, lines } = captureLogger();
const app = buildTestApp({ logger });

const blouse = (bust) => ({ garmentType: 'blouse', values: [{ name: 'Bust', value: bust, unit: 'in' }, { name: 'Waist', value: 28.25, unit: 'in' }] });

async function customerOf(agent) {
  return (await agent.post('/v1/customers').send({ name: 'Asha', phone: '9876543210' })).body.id;
}

test('records a new set every time, never overwrites', async () => {
  const { agent } = await loginAs(app, { roles: ['operations'] });
  const id = await customerOf(agent);
  const first = await agent.post(`/v1/customers/${id}/measurements`).send(blouse(34));
  expect(first.status).toBe(201);
  expect(first.body).toMatchObject({ id: expect.any(String), customerId: id, garmentType: 'blouse', values: blouse(34).values, notes: '', takenBy: { id: expect.any(String), name: expect.any(String) } });
  await agent.post(`/v1/customers/${id}/measurements`).send(blouse(35));
  expect(await Measurement.countDocuments({ customerId: id })).toBe(2);
  const list = await agent.get(`/v1/customers/${id}/measurements`);
  expect(list.body.items.map((m) => m.values[0].value)).toEqual([35, 34]);
  expect((await agent.get(`/v1/customers/${id}/measurements/latest`)).body.blouse.values[0].value).toBe(35);
  await expect(Measurement.updateOne({ customerId: id }, { notes: 'x' })).rejects.toThrow('append-only');
  await expect(Measurement.deleteMany({ customerId: id })).rejects.toThrow('append-only');
});
test('a loaded measurement cannot be changed and saved', async () => {
  const { agent } = await loginAs(app, { roles: ['operations'] });
  const id = await customerOf(agent);
  await agent.post(`/v1/customers/${id}/measurements`).send(blouse(34));
  const loaded = await Measurement.findOne({ customerId: id });
  loaded.notes = 'edited';
  await expect(loaded.save()).rejects.toThrow('append-only');
  expect((await Measurement.findOne({ customerId: id })).notes).toBe('');
});
test('latest per garment type', async () => {
  const { agent } = await loginAs(app, { roles: ['operations'] });
  const id = await customerOf(agent);
  await agent.post(`/v1/customers/${id}/measurements`).send(blouse(34));
  await agent.post(`/v1/customers/${id}/measurements`).send({ garmentType: 'lehenga', values: [{ name: 'Waist', value: 71, unit: 'cm' }] });
  const latest = (await agent.get(`/v1/customers/${id}/measurements/latest`)).body;
  expect(Object.keys(latest).sort()).toEqual(['blouse', 'lehenga']);
  expect(latest.lehenga.values).toEqual([{ name: 'Waist', value: 71, unit: 'cm' }]);
});
test('designers can record measurements', async () => {
  const { agent } = await loginAs(app, { roles: ['operations'] });
  const id = await customerOf(agent);
  const { agent: designer } = await loginAs(app, { roles: ['designer'] });
  expect((await designer.post(`/v1/customers/${id}/measurements`).send(blouse(34))).status).toBe(201);
  expect((await designer.get(`/v1/customers/${id}/measurements`)).body.items).toHaveLength(1);
});
test('unknown garment type or customer is rejected', async () => {
  const { agent } = await loginAs(app, { roles: ['operations'] });
  const id = await customerOf(agent);
  const r = await agent.post(`/v1/customers/${id}/measurements`).send({ ...blouse(34), garmentType: 'saree_fall' });
  expect(r.status).toBe(400);
  expect(r.body.error.details).toEqual([{ path: 'garmentType', message: expect.any(String) }]);
  expect((await agent.post('/v1/customers/000000000000000000000000/measurements').send(blouse(34))).status).toBe(404);
});
test('measurement values never reach the logs', async () => {
  const { agent } = await loginAs(app, { roles: ['operations'] });
  const id = await customerOf(agent);
  lines.length = 0;
  await agent.post(`/v1/customers/${id}/measurements`).send(blouse(36.75));
  await agent.post(`/v1/customers/${id}/measurements`).send({ garmentType: 'blouse', values: [{ name: 'Bust', value: -1, unit: 'in' }] });
  const text = JSON.stringify(lines);
  expect(lines.length).toBeGreaterThan(0);
  for (const secret of ['36.75', '28.25', 'Bust', 'Waist']) expect(text).not.toContain(secret);
});
