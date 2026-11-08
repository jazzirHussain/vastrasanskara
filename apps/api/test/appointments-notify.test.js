import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { frontOfficeHelpers } from './helpers/frontOffice.js';
import { Outbox } from '../src/core/notify/models.js';
import { getJobDefinitions } from '../src/core/jobs/registry.js';
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
/** Messages that will be sent, as 'kind:name:channel', for an event. */
const queued = async (event) =>
  (await Outbox.find({ event, status: 'pending' }).sort({ _id: 1 }).lean()).map((r) => `${r.recipient.kind}:${r.recipient.name}:${r.channel}`).sort();
const varsOf = async (event) => (await Outbox.findOne({ event }).lean())?.vars;

async function setup() {
  const w = await world();
  const bookAt = async (time, fields = {}) => {
    const r = await book(w.ops, {
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

const DESIGNER = (name) => [`user:${name}:email`, `user:${name}:in_app`];

test('booking tells the client and the designer', async () => {
  const { bookAt } = await setup();
  const a = await bookAt('11:00');
  expect(await queued('appointment.booked')).toEqual(['client:Asha Rao:email']);
  expect(await queued('appointment.booked.designer')).toEqual(DESIGNER('Meera'));
  expect(await varsOf('appointment.booked')).toMatchObject({
    customerName: 'Asha Rao',
    type: 'consultation',
    when: 'Tue 1 Dec, 11:00 am',
    designerName: 'Meera',
    link: `/appointments?date=${D}`,
  });
  expect(await varsOf('appointment.booked.designer')).toMatchObject({ type: 'Consultation', customerName: 'Asha Rao' });
  expect((await Outbox.findOne({ event: 'appointment.booked' }).lean()).dedupeKey).toContain(`appointment.booked:${a.id}:1:`);
});

test('a client without consent gets nothing; the designer still does', async () => {
  const { ops, bookAt } = await setup();
  const kavya = (await ops.agent.post('/v1/customers').send({ name: 'Kavya', phone: '9123456780', email: 'k@example.com' })).body;
  await bookAt('11:00', { customerId: kavya.id });
  expect(await queued('appointment.booked')).toEqual([]);
  expect(await queued('appointment.booked.designer')).toEqual(DESIGNER('Meera'));
});

test("an enquiry's appointment tells only the designer", async () => {
  const { ops, bookAt } = await setup();
  const e = (await addEnquiry(ops)).body.enquiry;
  await bookAt('11:00', { customerId: null, enquiryId: e.id });
  expect(await Outbox.countDocuments({ event: 'appointment.booked' })).toBe(0);
  expect(await queued('appointment.booked.designer')).toEqual(DESIGNER('Meera'));
  expect(await varsOf('appointment.booked.designer')).toMatchObject({ customerName: 'Priya Sharma' });
});

test('after conversion the customer gets the reminders', async () => {
  const { ops, customer, bookAt } = await setup();
  const e = (await addEnquiry(ops)).body.enquiry;
  await bookAt('14:00', { customerId: null, enquiryId: e.id, date: D1 });
  ok(await ops.agent.post(`/v1/enquiries/${e.id}/convert`).send({ version: 1, customerId: customer.id }));
  atIst(D1, '12:00');
  expect((await runAppointmentReminders()).queued).toBeGreaterThan(0);
  expect(await queued('appointment.reminder')).toEqual(['client:Asha Rao:email']);
  expect(await queued('appointment.reminder.designer')).toEqual(DESIGNER('Meera'));
});

test('moving tells both and a new designer replaces the old', async () => {
  const { ops, d2, bookAt } = await setup();
  const a = await bookAt('11:00');
  ok(await ops.agent.patch(`/v1/appointments/${a.id}`).send({ version: 0, designerId: String(d2.user._id), time: '15:00' }));
  expect(await queued('appointment.changed')).toEqual(['client:Asha Rao:email']);
  expect(await varsOf('appointment.changed')).toMatchObject({ previousWhen: 'Tue 1 Dec, 11:00 am', when: 'Tue 1 Dec, 3:00 pm', designerName: 'Nila' });
  expect(await queued('appointment.changed.designer')).toEqual(DESIGNER('Nila'));
  expect(await queued('appointment.cancelled.designer')).toEqual(DESIGNER('Meera'));
  expect(await Outbox.countDocuments({ event: 'appointment.cancelled' })).toBe(0);
  ok(await ops.agent.patch(`/v1/appointments/${a.id}`).send({ version: 1, note: 'Bring the blouse' }));
  expect(await Outbox.countDocuments({ event: 'appointment.changed' })).toBe(1);
});

test('cancelling tells both', async () => {
  const { ops, bookAt } = await setup();
  const a = await bookAt('11:00');
  ok(await ops.agent.post(`/v1/appointments/${a.id}/cancel`).send({ version: 0 }));
  expect(await queued('appointment.cancelled')).toEqual(['client:Asha Rao:email']);
  expect(await queued('appointment.cancelled.designer')).toEqual(DESIGNER('Meera'));
});

test("done and didn't come send nothing", async () => {
  const { ops, bookAt } = await setup();
  const a = await bookAt('11:00');
  const b = await bookAt('12:00');
  const before = await Outbox.countDocuments();
  ok(await ops.agent.post(`/v1/appointments/${a.id}/mark`).send({ version: 0, status: 'completed' }));
  ok(await ops.agent.post(`/v1/appointments/${b.id}/mark`).send({ version: 0, status: 'no_show' }));
  expect(await Outbox.countDocuments()).toBe(before);
});

test('the day reminder goes 24 hours before', async () => {
  const { bookAt } = await setup();
  await bookAt('11:00', { date: D1 });
  atIst(D, '10:30');
  expect((await runAppointmentReminders()).queued).toBe(0);
  atIst(D, '11:00');
  await runAppointmentReminders();
  expect(await queued('appointment.reminder')).toEqual(['client:Asha Rao:email']);
  expect(await queued('appointment.reminder.designer')).toEqual(DESIGNER('Meera'));
  expect(await varsOf('appointment.reminder')).toMatchObject({ whenRelative: 'tomorrow', when: 'Wed 2 Dec, 11:00 am' });
  expect(await varsOf('appointment.reminder.designer')).toMatchObject({ time: '11:00 am', type: 'Consultation' });
});

test('a late booking skips the day-before reminder', async () => {
  const { bookAt } = await setup();
  await bookAt('12:00');
  atIst(D, '09:15');
  expect((await runAppointmentReminders()).queued).toBe(0);
  atIst(D, '10:00');
  await runAppointmentReminders();
  expect(await queued('appointment.reminder')).toEqual(['client:Asha Rao:email']);
  expect(await varsOf('appointment.reminder')).toMatchObject({ whenRelative: 'today' });
  expect((await Outbox.find({ event: 'appointment.reminder' }).lean())[0].dedupeKey).toMatch(/:2:email:client:/);
});

test('the two-hour reminder skips the client in quiet hours', async () => {
  const { bookAt } = await setup();
  await bookAt('10:00', { date: D1 });
  await bookAt('14:00', { date: D1 });
  const soon = (event) => Outbox.countDocuments({ event, dedupeKey: { $regex: ':2:' } });
  atIst(D1, '08:00');
  await runAppointmentReminders();
  // 10:00 is two hours away, but email is quiet until 09:00: the designer only.
  expect(await soon('appointment.reminder')).toBe(0);
  expect(await soon('appointment.reminder.designer')).toBe(2);
  atIst(D1, '12:00');
  await runAppointmentReminders();
  // 14:00 at noon: both.
  expect(await soon('appointment.reminder')).toBe(1);
  expect(await soon('appointment.reminder.designer')).toBe(4);
});

test('re-running reminders queues nothing new', async () => {
  const { bookAt } = await setup();
  await bookAt('11:00', { date: D1 });
  atIst(D, '11:15');
  expect((await runAppointmentReminders()).queued).toBe(3);
  expect((await runAppointmentReminders()).queued).toBe(0);
  atIst(D, '11:30');
  expect((await runAppointmentReminders()).queued).toBe(0);
});

test('moving an appointment re-arms its reminders', async () => {
  const { ops, bookAt } = await setup();
  const a = await bookAt('11:00', { date: D1 });
  atIst(D, '11:00');
  expect((await runAppointmentReminders()).queued).toBe(3);
  ok(await ops.agent.patch(`/v1/appointments/${a.id}`).send({ version: 0, time: '12:00' }));
  atIst(D, '12:00');
  expect((await runAppointmentReminders()).queued).toBe(3);
  expect(await Outbox.countDocuments({ event: 'appointment.reminder' })).toBe(2);
});

test('cancelled appointments get no reminders', async () => {
  const { ops, bookAt } = await setup();
  const a = await bookAt('11:00', { date: D1 });
  ok(await ops.agent.post(`/v1/appointments/${a.id}/cancel`).send({ version: 0 }));
  atIst(D, '11:00');
  expect((await runAppointmentReminders()).queued).toBe(0);
});

test('reminder messages carry no phone number', async () => {
  const { ops, bookAt } = await setup();
  const e = (await addEnquiry(ops)).body.enquiry;
  await bookAt('11:00', { date: D1 });
  await bookAt('12:00', { date: D1, customerId: null, enquiryId: e.id });
  atIst(D, '12:00');
  await runAppointmentReminders();
  const all = await Outbox.find({ event: /^appointment\./ }).lean();
  expect(all.length).toBeGreaterThan(0);
  const text = JSON.stringify(all.map((r) => r.vars));
  for (const digits of ['9876543210', '9845012345']) expect(text).not.toContain(digits);
});

test('the reminders job is registered every 15 minutes', () => {
  expect(getJobDefinitions().get('appointments-reminders')).toMatchObject({ schedule: '*/15 * * * *' });
});
