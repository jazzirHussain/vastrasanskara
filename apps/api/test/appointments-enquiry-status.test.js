import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { frontOfficeHelpers } from './helpers/frontOffice.js';
import { Outbox } from '../src/core/notify/models.js';
import { runAppointmentReminders } from '../src/modules/appointments/reminders.js';
import '../src/jobs.js';

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
  const e = (await addEnquiry(w.ops)).body.enquiry;
  const bookFor = async (time, date = D1) => {
    const r = await book(w.ops, { type: 'consultation', designerId: String(w.d1.user._id), enquiryId: e.id, date, time });
    ok(r, 201);
    return r.body.appointment;
  };
  const enquiry = async () => (await w.ops.agent.get(`/v1/enquiries/${e.id}`)).body.enquiry;
  const lose = async () => {
    const { version } = await enquiry();
    return w.ops.agent.post(`/v1/enquiries/${e.id}/lost`).send({ version, reason: 'Too costly' });
  };
  return { ...w, e, bookFor, enquiry, lose };
}

test('cancelling the only appointment returns the enquiry to contacted', async () => {
  const { ops, bookFor, enquiry } = await setup();
  const a = await bookFor('11:00');
  expect((await enquiry()).status).toBe('appointment_booked');
  ok(await ops.agent.post(`/v1/appointments/${a.id}/cancel`).send({ version: 0 }));
  expect((await enquiry()).status).toBe('contacted');
});

test('cancelling one of two appointments keeps the enquiry at appointment booked', async () => {
  const { ops, bookFor, enquiry } = await setup();
  const a = await bookFor('11:00');
  await bookFor('14:00');
  ok(await ops.agent.post(`/v1/appointments/${a.id}/cancel`).send({ version: 0 }));
  expect((await enquiry()).status).toBe('appointment_booked');
});

test('cancelling leaves an enquiry that has moved on alone', async () => {
  const { ops, bookFor, enquiry, lose } = await setup();
  const a = await bookFor('11:00');
  ok(await lose());
  // Lost cancelled it already; a second cancel is refused and the enquiry stays lost.
  ok(await ops.agent.post(`/v1/appointments/${a.id}/cancel`).send({ version: 1 }), 422);
  expect((await enquiry()).status).toBe('lost');
});

test('marking an enquiry lost cancels its future appointments and withdraws their reminders', async () => {
  const { ops, bookFor, enquiry, lose } = await setup();
  const future = await bookFor('11:00');
  const today = await bookFor('15:00', D);
  atIst(D, '11:00');
  await runAppointmentReminders();
  expect(await Outbox.countDocuments({ event: /^appointment\.reminder/, status: 'pending' })).toBeGreaterThan(0);
  atIst(D, '12:00');
  ok(await lose());
  expect((await enquiry()).status).toBe('lost');
  const list = (await ops.agent.get('/v1/appointments')).body.items;
  const by = Object.fromEntries(list.map((a) => [a.id, a]));
  expect(by[future.id]).toMatchObject({ status: 'cancelled', cancelReason: 'Enquiry marked lost' });
  expect(by[today.id]).toMatchObject({ status: 'cancelled', cancelReason: 'Enquiry marked lost' });
  expect(await Outbox.countDocuments({ event: /^appointment\.reminder/, status: 'pending' })).toBe(0);
});

test('a past booked appointment is left when the enquiry is marked lost', async () => {
  const { ops, bookFor, lose } = await setup();
  const past = await bookFor('10:00', D);
  atIst(D, '12:00');
  ok(await lose());
  expect((await ops.agent.get(`/v1/appointments/${past.id}`)).body.appointment.status).toBe('booked');
});

test('a refused "lost" cancels nothing', async () => {
  const { ops, bookFor, enquiry, e } = await setup();
  const a = await bookFor('11:00');
  const r = await ops.agent.post(`/v1/enquiries/${e.id}/lost`).send({ version: 99, reason: 'Too costly' });
  expect(r.status).toBe(409);
  expect((await ops.agent.get(`/v1/appointments/${a.id}`)).body.appointment.status).toBe('booked');
  expect((await enquiry()).status).toBe('appointment_booked');
});
