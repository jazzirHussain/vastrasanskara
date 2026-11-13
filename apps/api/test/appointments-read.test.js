import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { frontOfficeHelpers } from './helpers/frontOffice.js';
import { Appointment } from '../src/modules/appointments/model.js';
import { appointmentCounts, appointmentListFilter, dayFilter, reminderFilter } from '../src/modules/appointments/queries.js';
import { Enquiry } from '../src/modules/enquiries/model.js';
import { conversionMatch, enquiryConversionBySource } from '../src/modules/enquiries/queries.js';

useTestDb();
const app = buildTestApp();
const { world, addEnquiry, book, atIst } = frontOfficeHelpers(app);

const D = '2026-12-01';
const D1 = '2026-12-02';
beforeEach(() => atIst(D, '09:00'));
afterEach(() => vi.restoreAllMocks());

const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);

async function setup() {
  const w = await world();
  const bookAt = async (time, fields = {}, who = w.ops) => {
    const r = await book(who, {
      type: 'consultation',
      designerId: String(w.d1.user._id),
      customerId: w.customer.id,
      date: D,
      time,
      ...fields,
    });
    ok(r, 201);
    return r.body.appointment;
  };
  return { ...w, bookAt };
}

test('the day view is the IST day', async () => {
  const { ops, bookAt } = await setup();
  const late = await bookAt('23:30', { minutes: 15 });
  expect(late.start).toBe('2026-12-01T18:00:00.000Z');
  await bookAt('00:15', { date: D1, minutes: 15 });
  const r = await ops.agent.get('/v1/appointments/day').query({ date: D });
  ok(r);
  const meera = r.body.designers.find((d) => d.name === 'Meera');
  expect(meera.appointments.map((a) => a.id)).toEqual([late.id]);
  expect(r.body).toMatchObject({ date: D, openingTime: '10:00', closingTime: '20:00' });
  const next = await ops.agent.get('/v1/appointments/day').query({ date: D1 });
  expect(next.body.designers.find((d) => d.name === 'Meera').appointments.map((a) => a.time)).toEqual(['00:15']);
});

test('the day view lists every active designer, busy or free', async () => {
  const { ops, admin, d1, d2, bookAt } = await setup();
  await bookAt('12:00');
  await bookAt('10:00', { minutes: 30 });
  const r = await ops.agent.get('/v1/appointments/day').query({ date: D });
  expect(r.body.designers.map((d) => [d.name, d.appointments.map((a) => a.time)])).toEqual([
    ['Meera', ['10:00', '12:00']],
    ['Nila', []],
  ]);
  ok(await admin.agent.patch(`/v1/users/${d1.user._id}`).send({ active: false }));
  ok(await admin.agent.patch(`/v1/users/${d2.user._id}`).send({ active: false }));
  const after = await ops.agent.get('/v1/appointments/day').query({ date: D });
  expect(after.body.designers.map((d) => d.name)).toEqual(['Meera']);
  const one = await ops.agent.get('/v1/appointments/day').query({ date: D, designerId: String(d1.user._id) });
  expect(one.body.designers.map((d) => d.name)).toEqual(['Meera']);
});

test('cancelled appointments are left out of the day', async () => {
  const { ops, bookAt } = await setup();
  const a = await bookAt('11:00');
  const b = await bookAt('12:00');
  await ops.agent.post(`/v1/appointments/${a.id}/cancel`).send({ version: 0 });
  await ops.agent.post(`/v1/appointments/${b.id}/mark`).send({ version: 0, status: 'no_show' });
  const r = await ops.agent.get('/v1/appointments/day').query({ date: D });
  expect(r.body.designers[0].appointments.map((x) => [x.time, x.status])).toEqual([['12:00', 'no_show']]);
});

test("a designer's day shows only their own column", async () => {
  const { d1, d2, bookAt } = await setup();
  await bookAt('11:00');
  await bookAt('11:00', { designerId: String(d2.user._id) });
  const r = await d1.agent.get('/v1/appointments/day').query({ date: D });
  ok(r);
  expect(r.body.designers.map((d) => [d.name, d.appointments.length])).toEqual([['Meera', 1]]);
  const widened = await d1.agent.get('/v1/appointments/day').query({ date: D, designerId: String(d2.user._id) });
  expect(widened.body.designers.map((d) => d.name)).toEqual(['Meera']);
  const list = await d1.agent.get('/v1/appointments').query({ designerId: String(d2.user._id) });
  expect(list.body.items.map((a) => a.designer.name)).toEqual(['Meera']);
});

test('a customer\'s appointments include those booked while they were an enquiry', async () => {
  const { ops, bookAt } = await setup();
  const e = (await addEnquiry(ops)).body.enquiry;
  const early = await bookAt('10:00', { customerId: null, enquiryId: e.id });
  const converted = (await ops.agent.post(`/v1/enquiries/${e.id}/convert`).send({ version: 1 })).body;
  expect(converted.customer.id).toBeTruthy();
  const later = await bookAt('14:00', { customerId: converted.customer.id });
  await bookAt('16:00');
  const r = await ops.agent.get('/v1/appointments').query({ customerId: converted.customer.id });
  ok(r);
  expect(r.body.items.map((a) => a.id)).toEqual([early.id, later.id]);
  expect(r.body.items[0]).toMatchObject({ customer: { id: converted.customer.id, name: 'Priya Sharma' }, enquiry: { id: e.id } });
  const byEnquiry = await ops.agent.get('/v1/appointments').query({ enquiryId: e.id });
  expect(byEnquiry.body.items.map((a) => a.id)).toEqual([early.id]);
});

test('lists page without repeats', async () => {
  const { ops, bookAt } = await setup();
  const times = ['10:00', '11:00', '12:00', '13:00', '14:00'];
  for (const t of times) await bookAt(t);
  const seen = [];
  let cursor;
  do {
    const r = await ops.agent.get('/v1/appointments').query({ limit: 2, ...(cursor ? { cursor } : {}) });
    ok(r);
    seen.push(...r.body.items.map((a) => a.time));
    cursor = r.body.nextCursor;
  } while (cursor);
  expect(seen).toEqual(times);
  const past = await ops.agent.get('/v1/appointments').query({ to: '2026-11-30' });
  expect(past.body.items).toEqual([]);
  const booked = await ops.agent.get('/v1/appointments').query({ status: 'completed' });
  expect(booked.body.items).toEqual([]);
});

test('past lists are newest first', async () => {
  const { ops, bookAt } = await setup();
  const a = await bookAt('10:00');
  const b = await bookAt('11:00', { date: D1 });
  // Seen from later: move both into last month (the API never books in the past).
  const back = 20 * 24 * 60 * 60 * 1000;
  for (const [x, date] of [[a, '2026-11-11'], [b, '2026-11-12']]) {
    await Appointment.updateOne(
      { _id: x.id },
      { date, start: new Date(Date.parse(x.start) - back), end: new Date(Date.parse(x.end) - back) },
    );
  }
  const r = await ops.agent.get('/v1/appointments').query({ to: '2026-11-30' });
  expect(r.body.items.map((x) => x.date)).toEqual(['2026-11-12', '2026-11-11']);
  const future = await ops.agent.get('/v1/appointments').query({ from: '2026-11-01' });
  expect(future.body.items.map((x) => x.date)).toEqual(['2026-11-11', '2026-11-12']);
});

test('appointment counts by status and type', async () => {
  const { ops, d2, bookAt, branchId } = await setup();
  const a = await bookAt('10:00');
  await bookAt('11:00', { type: 'fitting' });
  await bookAt('12:00', { type: 'pickup', designerId: String(d2.user._id) });
  await bookAt('12:00', { type: 'measurement', date: D1 });
  await ops.agent.post(`/v1/appointments/${a.id}/mark`).send({ version: 0, status: 'completed' });
  expect(await appointmentCounts(branchId, { from: D, to: D })).toEqual({
    booked: 2,
    completed: 1,
    no_show: 0,
    cancelled: 0,
    byType: { consultation: 1, measurement: 0, fitting: 1, pickup: 1 },
  });
  const nila = await appointmentCounts(branchId, { from: D, to: D1, designerId: String(d2.user._id) });
  expect(nila.byType).toEqual({ consultation: 0, measurement: 0, fitting: 0, pickup: 1 });
});

test('enquiry conversion by source counts converted, lost and open', async () => {
  const { ops, d1, branchId } = await setup();
  const insta = (await addEnquiry(ops, { source: 'instagram', phone: '9845000001' })).body.enquiry;
  await addEnquiry(ops, { source: 'instagram', phone: '9845000002' });
  const lost = (await addEnquiry(ops, { source: 'referral', phone: '9845000003' })).body.enquiry;
  await ops.agent.post(`/v1/enquiries/${lost.id}/lost`).send({ version: 0, reason: 'Other' });
  const ready = (await ops.agent.post(`/v1/enquiries/${insta.id}/convert`).send({ version: 0 })).body;
  ok(
    await ops.agent.post('/v1/orders').set('Idempotency-Key', 'conv-1').send({
      customerId: ready.customer.id,
      designerId: String(d1.user._id),
      pickupDate: '2027-01-15',
      enquiryId: insta.id,
      garments: [{ type: 'blouse', description: 'Blouse', agreedPrice: 100000 }],
    }),
    201,
  );
  expect(await enquiryConversionBySource(branchId, { from: D, to: D })).toEqual([
    { source: 'instagram', total: 2, converted: 1, lost: 0, open: 1 },
    { source: 'referral', total: 1, converted: 0, lost: 1, open: 0 },
  ]);
  expect(await enquiryConversionBySource(branchId, { from: D1, to: D1 })).toEqual([]);
});

test('appointment queries use indexes', async () => {
  const { bookAt, branchId, d1, customer } = await setup();
  await Promise.all([Appointment.init(), Enquiry.init()]);
  await bookAt('11:00');
  const winning = (explained) => {
    const plan = explained.queryPlanner?.winningPlan ?? explained.stages.find((st) => st.$cursor).$cursor.queryPlanner.winningPlan;
    const names = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.stage === 'IXSCAN') names.push(node.indexName);
      if (node.stage === 'COLLSCAN') names.push('COLLSCAN');
      walk(node.inputStage);
      for (const child of node.inputStages ?? []) walk(child);
    };
    walk(plan);
    return names;
  };
  const designerId = String(d1.user._id);
  expect(winning(await Appointment.find(dayFilter(branchId, { date: D })).sort({ start: 1 }).explain('queryPlanner'))).toEqual(['by_day']);
  expect(
    winning(await Appointment.find(dayFilter(branchId, { date: D, designerIds: [designerId] })).sort({ start: 1 }).explain('queryPlanner')),
  ).toEqual(['by_designer_day']);
  const custFilter = appointmentListFilter(branchId, { customerId: customer.id, enquiryIds: [new mongoose.Types.ObjectId()] });
  const custPlan = winning(await Appointment.find(custFilter).sort({ start: 1, _id: 1 }).explain('queryPlanner'));
  expect(custPlan).not.toContain('COLLSCAN');
  expect(custPlan).toEqual(expect.arrayContaining(['by_customer', 'by_enquiry']));
  const now = new Date();
  expect(winning(await Appointment.find(reminderFilter(branchId, now)).explain('queryPlanner'))).toEqual(['reminders']);
  const conv = await Enquiry.aggregate([{ $match: conversionMatch(branchId, { from: D, to: D }) }, { $group: { _id: '$source' } }]).explain(
    'queryPlanner',
  );
  expect(winning(conv)).toEqual(['by_date']);
});
