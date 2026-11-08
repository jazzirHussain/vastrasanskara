import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { frontOfficeHelpers } from './helpers/frontOffice.js';
import { Appointment } from '../src/modules/appointments/model.js';
import { Garment } from '../src/modules/orders/model.js';

useTestDb();
const app = buildTestApp();
const { world, addEnquiry, book, atIst } = frontOfficeHelpers(app);

// A fixed business day: the clock starts at 09:00 IST on D (sessions are made then).
const D = '2026-12-01';
const D1 = '2026-12-02';
beforeEach(() => atIst(D, '09:00'));
afterEach(() => vi.restoreAllMocks());

const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const err = (r, status, code) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.error.code).toBe(code);
};

async function setup() {
  const w = await world();
  const at = (time, fields = {}) => ({
    type: 'consultation',
    designerId: String(w.d1.user._id),
    customerId: w.customer.id,
    date: D,
    time,
    ...fields,
  });
  const bookAt = async (time, fields) => {
    const r = await book(w.ops, at(time, fields));
    ok(r, 201);
    return r.body.appointment;
  };
  const move = (a, patch, who = w.ops) => who.agent.patch(`/v1/appointments/${a.id}`).send({ version: a.version, ...patch });
  return { ...w, at, bookAt, move };
}

async function takeOrder(w, customerId = w.customer.id) {
  const r = await w.ops.agent.post('/v1/orders').set('Idempotency-Key', `o-${Math.random()}`).send({
    customerId,
    designerId: String(w.d1.user._id),
    pickupDate: '2027-01-15',
    garments: [{ type: 'blouse', description: 'Silk blouse', agreedPrice: 450000, quantity: 2 }],
  });
  ok(r, 201);
  return r.body;
}

test('a consultation is booked with the default length from settings', async () => {
  const { ops, d1, customer, at } = await setup();
  const r = await book(ops, at('11:30'));
  ok(r, 201);
  expect(r.body.appointment).toMatchObject({
    id: expect.any(String),
    type: 'consultation',
    date: D,
    time: '11:30',
    minutes: 60,
    start: '2026-12-01T06:00:00.000Z',
    end: '2026-12-01T07:00:00.000Z',
    status: 'booked',
    designer: { id: String(d1.user._id), name: 'Meera' },
    customer: { id: customer.id, name: 'Asha Rao', phone: '+919876543210' },
    enquiry: null,
    garments: [],
    note: '',
    cancelReason: null,
    statusAt: null,
    statusBy: null,
    version: 0,
  });
});

test('a length can be chosen', async () => {
  const { bookAt } = await setup();
  const a = await bookAt('10:00', { type: 'fitting', minutes: 90 });
  expect(a).toMatchObject({ minutes: 90, end: '2026-12-01T06:00:00.000Z' });
  const p = await bookAt('12:00', { type: 'pickup' });
  expect(p.minutes).toBe(15);
});

test("an enquiry's appointment moves it to appointment booked", async () => {
  const { ops, at } = await setup();
  const e = (await addEnquiry(ops)).body.enquiry;
  const r = await book(ops, at('11:00', { customerId: null, enquiryId: e.id }));
  ok(r, 201);
  expect(r.body.appointment).toMatchObject({ customer: null, enquiry: { id: e.id, name: 'Priya Sharma', phone: '+919845012345' } });
  const after = (await ops.agent.get(`/v1/enquiries/${e.id}`)).body.enquiry;
  expect(after.status).toBe('appointment_booked');
  expect(after.log.at(-1)).toMatchObject({ kind: 'appointment', text: 'Appointment booked for Tue 1 Dec, 11:00 am' });
});

test('a lost enquiry cannot be booked', async () => {
  const { ops, at } = await setup();
  const e = (await addEnquiry(ops)).body.enquiry;
  await ops.agent.post(`/v1/enquiries/${e.id}/lost`).send({ version: 0, reason: 'Other' });
  err(await book(ops, at('11:00', { customerId: null, enquiryId: e.id })), 422, 'ENQUIRY_CLOSED');
  expect(await Appointment.countDocuments()).toBe(0);
  const missing = await book(ops, at('11:00', { customerId: '0123456789abcdef01234567' }));
  err(missing, 400, 'VALIDATION_FAILED');
  expect(missing.body.error.details).toEqual([{ path: 'customerId', message: 'Not found' }]);
});

test('an overlapping booking is refused with the booked slot', async () => {
  const { ops, at, bookAt } = await setup();
  const first = await bookAt('11:00');
  const r = await book(ops, at('11:30', { minutes: 30 }));
  err(r, 422, 'SLOT_TAKEN');
  expect(r.body.error).toMatchObject({
    message: 'That time is already booked for this designer',
    details: { appointmentId: first.id, start: first.start, end: first.end },
  });
  err(await book(ops, at('10:30', { minutes: 45 })), 422, 'SLOT_TAKEN');
});

test('back-to-back bookings are allowed', async () => {
  const { bookAt } = await setup();
  await bookAt('11:00');
  await bookAt('12:00');
  await bookAt('10:30', { minutes: 30 });
  expect(await Appointment.countDocuments()).toBe(3);
});

test('another designer is free at the same time', async () => {
  const { d2, bookAt } = await setup();
  await bookAt('11:00');
  const other = await bookAt('11:00', { designerId: String(d2.user._id) });
  expect(other.designer.name).toBe('Nila');
});

test('cancelled appointments free their slot', async () => {
  const { ops, bookAt } = await setup();
  const a = await bookAt('11:00');
  const c = await ops.agent.post(`/v1/appointments/${a.id}/cancel`).send({ version: a.version, reason: 'Client unwell' });
  ok(c);
  expect(c.body.appointment).toMatchObject({ status: 'cancelled', cancelReason: 'Client unwell', statusBy: { id: String(ops.user._id) } });
  await bookAt('11:00');
});

test('concurrent bookings of one slot book exactly one', async () => {
  const { ops, at } = await setup();
  await Appointment.init();
  for (const [n, time] of [[2, '11:00'], [5, '14:00']]) {
    const results = await Promise.all(Array.from({ length: n }, () => book(ops, at(time))));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(results.map((r) => r.body))).toEqual([201, ...Array(n - 1).fill(422)]);
    for (const r of results.filter((x) => x.status === 422)) expect(r.body.error.code).toBe('SLOT_TAKEN');
  }
  expect(await Appointment.countDocuments()).toBe(2);
});

test('concurrent bookings of adjacent slots both succeed', async () => {
  const { ops, at } = await setup();
  const results = await Promise.all([book(ops, at('11:00')), book(ops, at('12:00')), book(ops, at('13:00'))]);
  expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
});

test('double tap with one key books once', async () => {
  const { ops, at } = await setup();
  const [a, b] = await Promise.all([book(ops, at('11:00'), 'tap'), book(ops, at('11:00'), 'tap')]);
  expect([a.status, b.status]).toContain(201);
  for (const r of [a, b]) expect([201, 409]).toContain(r.status);
  const again = await book(ops, at('11:00'), 'tap');
  ok(again, 201);
  expect(await Appointment.countDocuments()).toBe(1);
  err(await ops.agent.post('/v1/appointments').send(at('12:00')), 400, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('a move into a slot booked meanwhile is refused', async () => {
  const { ops, at, bookAt, move } = await setup();
  // The booking commits first: the move sees it.
  const a = await bookAt('10:00');
  await bookAt('11:00');
  err(await move(a, { time: '11:00' }), 422, 'SLOT_TAKEN');
  // The move commits first: the booking sees it.
  const moved = await move(a, { time: '13:00' });
  ok(moved);
  err(await book(ops, at('13:30', { minutes: 15 })), 422, 'SLOT_TAKEN');
  // At the same moment: exactly one wins.
  const b = await bookAt('15:00');
  const [m, n] = await Promise.all([move(b, { time: '16:00' }), book(ops, at('16:00'))]);
  expect([m.status, n.status].sort()).toEqual([200, 422].sort());
  expect(await Appointment.countDocuments({ status: 'booked', date: D, start: new Date('2026-12-01T10:30:00.000Z') })).toBe(1);
});

test("moving to another day or designer checks the new day", async () => {
  const { d2, bookAt, move } = await setup();
  const a = await bookAt('11:00');
  const nila = await bookAt('11:00', { designerId: String(d2.user._id), date: D1 });
  err(await move(a, { designerId: String(d2.user._id), date: D1 }), 422, 'SLOT_TAKEN');
  const r = await move(a, { date: D1, time: '15:00' });
  ok(r);
  expect(r.body.appointment).toMatchObject({ date: D1, time: '15:00', minutes: 60, version: 1 });
  const r2 = await move(r.body.appointment, { designerId: String(d2.user._id) });
  ok(r2);
  expect(r2.body.appointment.designer.name).toBe('Nila');
  expect(nila.id).not.toBe(a.id);
  err(await move(r2.body.appointment, { time: '23:30' }), 400, 'VALIDATION_FAILED');
  err(await move(a, { time: '16:00' }), 409, 'CONFLICT');
  const note = await move(r2.body.appointment, { note: 'Bring the dupatta' });
  ok(note);
  expect(note.body.appointment).toMatchObject({ note: 'Bring the dupatta', time: '15:00' });
});

test('a past time is refused for booking and moving', async () => {
  const { ops, at, bookAt, move } = await setup();
  const a = await bookAt('14:00');
  atIst(D, '12:10');
  const r = await book(ops, at('12:00'));
  err(r, 422, 'APPOINTMENT_IN_PAST');
  expect(r.body.error.message).toBe('This time has already passed');
  err(await move(a, { time: '11:00' }), 422, 'APPOINTMENT_IN_PAST');
  await bookAt('12:15');
});

test("a fitting names the customer's own garments only", async () => {
  const w = await setup();
  const order = await takeOrder(w);
  const [g1, g2] = order.garments;
  const fit = await w.bookAt('11:00', { type: 'fitting', garmentIds: [g1.id, g2.id] });
  expect(fit.garments).toEqual([
    { id: g1.id, garmentNo: g1.garmentNo, description: 'Silk blouse' },
    { id: g2.id, garmentNo: g2.garmentNo, description: 'Silk blouse' },
  ]);
  const other = (await w.ops.agent.post('/v1/customers').send({ name: 'Kavya', phone: '9123456780' })).body;
  const theirs = await takeOrder(w, other.id);
  const r = await book(w.ops, w.at('12:00', { type: 'fitting', garmentIds: [theirs.garments[0].id] }));
  err(r, 400, 'VALIDATION_FAILED');
  expect(r.body.error.details[0].path).toBe('garmentIds');
  await Garment.updateOne({ _id: g2.id }, { status: 'cancelled' });
  err(await book(w.ops, w.at('12:00', { type: 'fitting', garmentIds: [g2.id] })), 400, 'VALIDATION_FAILED');
  err(await w.move(fit, { garmentIds: [theirs.garments[0].id] }), 400, 'VALIDATION_FAILED');
  const consult = await w.bookAt('13:00');
  err(await w.move(consult, { garmentIds: [g1.id] }), 400, 'VALIDATION_FAILED');
});

test('a closed appointment cannot be moved or cancelled', async () => {
  const { ops, bookAt, move } = await setup();
  const a = await bookAt('11:00');
  const c = (await ops.agent.post(`/v1/appointments/${a.id}/cancel`).send({ version: 0 })).body.appointment;
  expect(c.cancelReason).toBeNull();
  const r = await move(c, { time: '12:00' });
  err(r, 422, 'APPOINTMENT_CLOSED');
  expect(r.body.error.message).toBe('This appointment is closed');
  err(await ops.agent.post(`/v1/appointments/${a.id}/cancel`).send({ version: c.version }), 422, 'APPOINTMENT_CLOSED');
  err(await ops.agent.post(`/v1/appointments/${a.id}/mark`).send({ version: c.version, status: 'completed' }), 422, 'APPOINTMENT_CLOSED');
});

test("done and didn't come are allowed from the appointment's day", async () => {
  const { ops, bookAt } = await setup();
  const tomorrow = await bookAt('11:00', { date: D1 });
  const r = await ops.agent.post(`/v1/appointments/${tomorrow.id}/mark`).send({ version: 0, status: 'no_show' });
  err(r, 422, 'APPOINTMENT_NOT_DUE');
  expect(r.body.error.message).toBe('You can mark this from the day of the appointment');
  const todays = await bookAt('11:00');
  const done = await ops.agent.post(`/v1/appointments/${todays.id}/mark`).send({ version: 0, status: 'completed' });
  ok(done);
  expect(done.body.appointment).toMatchObject({ status: 'completed', statusBy: { id: String(ops.user._id) }, version: 1 });
  atIst(D1, '18:00');
  const noShow = await ops.agent.post(`/v1/appointments/${tomorrow.id}/mark`).send({ version: 0, status: 'no_show' });
  ok(noShow);
  expect(noShow.body.appointment.status).toBe('no_show');
});

test("a designer can mark their own appointment but not another's", async () => {
  const { d1, d2, bookAt } = await setup();
  const mine = await bookAt('11:00');
  const theirs = await bookAt('11:00', { designerId: String(d2.user._id) });
  ok(await d1.agent.get(`/v1/appointments/${mine.id}`));
  err(await d1.agent.get(`/v1/appointments/${theirs.id}`), 404, 'NOT_FOUND');
  err(await d1.agent.post(`/v1/appointments/${theirs.id}/mark`).send({ version: 0, status: 'completed' }), 404, 'NOT_FOUND');
  const r = await d1.agent.post(`/v1/appointments/${mine.id}/mark`).send({ version: 0, status: 'completed' });
  ok(r);
  expect(r.body.appointment.statusBy.name).toBe('Meera');
  expect((await d1.agent.patch(`/v1/appointments/${theirs.id}`).send({ version: 0, time: '12:00' })).status).toBe(403);
});

test('an inactive designer cannot be booked', async () => {
  const { ops, admin, d1, at } = await setup();
  ok(await admin.agent.patch(`/v1/users/${d1.user._id}`).send({ active: false }));
  const r = await book(ops, at('11:00'));
  err(r, 400, 'VALIDATION_FAILED');
  expect(r.body.error.details).toEqual([{ path: 'designerId', message: 'Choose a designer' }]);
  err(await book(ops, at('11:00', { designerId: String(ops.user._id) })), 400, 'VALIDATION_FAILED');
});
