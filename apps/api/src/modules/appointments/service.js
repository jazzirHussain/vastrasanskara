// Appointments: book, move, cancel and mark, with no double-booking. Every booking or move writes
// the (designer, IST day) lock of each day it touches, then checks for an overlap, all in one
// transaction: two writes to one designer-day conflict and the loser is retried by withTransaction
// against the committed data, where the overlap check refuses it with SLOT_TAKEN.
import mongoose from 'mongoose';
import { appointmentWhen, appointmentWindow, istDate, istTime } from '@vs/shared';
import { clock } from '../../clock.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, conflict, notFound, validationError } from '../../core/errors.js';
import { getCustomer } from '../customers/service.js';
import { getEnquiry, noteAppointmentBooked } from '../enquiries/service.js';
import { getGarmentsForAppointment } from '../orders/service.js';
import { readSettings } from '../settings/service.js';
import { isActiveDesigner } from '../users/service.js';
import { Appointment, ensureDesignerDayLocks, lockDesignerDay, lockKey } from './model.js';
import { appointmentScope } from './queries.js';

export {
  appointmentCounts,
  appointmentScope,
  appointmentJsonContext,
  appointmentListFilter,
  appointmentsForDay,
  appointmentsJson,
  dayFilter,
  listAppointments,
  reminderFilter,
} from './queries.js';

const fieldError = (path, message) => validationError([{ path, message }]);
const closedAppointment = () => businessRule('APPOINTMENT_CLOSED', 'This appointment is closed');
const inPast = () => businessRule('APPOINTMENT_IN_PAST', 'This time has already passed');
const slotTaken = (a) =>
  businessRule('SLOT_TAKEN', 'That time is already booked for this designer', {
    appointmentId: String(a._id),
    start: a.start.toISOString(),
    end: a.end.toISOString(),
  });


function windowOf({ date, time, minutes }) {
  try {
    return appointmentWindow({ date, time, minutes });
  } catch (err) {
    if (err instanceof RangeError) throw fieldError('minutes', 'The appointment must end by midnight');
    throw err;
  }
}

async function assertDesigner(branchId, designerId) {
  if (!(await isActiveDesigner(branchId, designerId))) throw fieldError('designerId', 'Choose a designer');
}

// A fitting may name garments of its customer that are still being made.
async function checkGarments(branchId, { type, customerId, garmentIds }, session) {
  if (!garmentIds.length) return;
  if (type !== 'fitting') throw fieldError('garmentIds', 'Garments can be named on fittings only');
  const garments = await getGarmentsForAppointment(branchId, garmentIds, session);
  const usable = garments.filter(
    (g) => customerId && g.customerId === String(customerId) && !['cancelled', 'picked_up'].includes(g.status),
  );
  if (usable.length !== new Set(garmentIds.map(String)).size) {
    throw fieldError('garmentIds', "Choose this customer's garments that are still being made");
  }
}

async function assertFree(branchId, { designerId, date, start, end }, exceptId, session) {
  const clash = await Appointment.findOne({
    branchId,
    designerId,
    date,
    status: 'booked',
    start: { $lt: end },
    end: { $gt: start },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  })
    .session(session)
    .lean();
  if (clash) throw slotTaken(clash);
}

// Locks every (designer, day) in sorted order so two moves never wait on each other in a cycle.
async function lockDays(branchId, days, session) {
  const unique = [...new Map(days.map((d) => [lockKey(branchId, d.designerId, d.date), d])).entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [, d] of unique) await lockDesignerDay(branchId, d.designerId, d.date, session);
}

async function partyOf(branchId, { customerId, enquiryId }, session) {
  try {
    if (customerId) return { customer: await getCustomer(branchId, customerId, session) };
    const enquiry = await getEnquiry(branchId, enquiryId, session);
    if (!enquiry.isOpen) throw businessRule('ENQUIRY_CLOSED', 'This enquiry is closed');
    return { enquiry };
  } catch (err) {
    if (err?.code === 'NOT_FOUND') throw fieldError(customerId ? 'customerId' : 'enquiryId', 'Not found');
    throw err;
  }
}

/** Books an appointment; the length defaults to the type's length in settings. */
export async function bookAppointment(branchId, input, actor) {
  const now = clock.now();
  const settings = await readSettings(branchId);
  const minutes = input.minutes ?? settings.appointmentDurations[input.type];
  const { start, end } = windowOf({ date: input.date, time: input.time, minutes });
  if (start < now) throw inPast();
  await assertDesigner(branchId, input.designerId);
  await ensureDesignerDayLocks([lockKey(branchId, input.designerId, input.date)]);

  return withTransaction(async (session) => {
    const { enquiry } = await partyOf(branchId, input, session);
    await checkGarments(branchId, input, session);
    await lockDays(branchId, [{ designerId: input.designerId, date: input.date }], session);
    await assertFree(branchId, { designerId: input.designerId, date: input.date, start, end }, null, session);
    const [appointment] = await Appointment.create(
      [
        {
          branchId,
          type: input.type,
          designerId: input.designerId,
          customerId: input.customerId,
          enquiryId: input.enquiryId,
          date: input.date,
          start,
          end,
          minutes,
          garmentIds: input.garmentIds,
          note: input.note,
          scheduledAt: now,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      ],
      { session },
    );
    if (enquiry) await noteAppointmentBooked(branchId, enquiry._id, { when: appointmentWhen(start) }, actor, session);
    return appointment.toObject();
  });
}

async function loadForChange(branchId, id, version, session, scope = {}) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const appointment = await Appointment.findOne({ _id: id, branchId, ...scope }).session(session ?? null);
  if (!appointment) throw notFound();
  if (appointment.__v !== version) throw conflict();
  if (appointment.status !== 'booked') throw closedAppointment();
  return appointment;
}

/**
 * Moves an appointment (day, time, length, designer) and/or changes its garments or note. A new
 * time is checked against the past, midnight and the designer's other appointments; reminders
 * re-arm because `scheduledAt` moves. Returns the appointment and where it was before.
 */
export async function moveAppointment(branchId, id, { version, patch }, actor) {
  const now = clock.now();
  const current = await loadForChange(branchId, id, version);
  const target = {
    designerId: patch.designerId ?? String(current.designerId),
    date: patch.date ?? current.date,
    time: patch.time ?? istTime(current.start),
    minutes: patch.minutes ?? current.minutes,
  };
  const timingChanged =
    target.designerId !== String(current.designerId) ||
    target.date !== current.date ||
    target.time !== istTime(current.start) ||
    target.minutes !== current.minutes;
  const { start, end } = windowOf(target);
  if (timingChanged && start < now) throw inPast();
  if (target.designerId !== String(current.designerId)) await assertDesigner(branchId, target.designerId);
  const days = [
    { designerId: String(current.designerId), date: current.date },
    { designerId: target.designerId, date: target.date },
  ];
  if (timingChanged) await ensureDesignerDayLocks(days.map((d) => lockKey(branchId, d.designerId, d.date)));

  return withTransaction(async (session) => {
    const appointment = await loadForChange(branchId, id, version, session);
    const previous = { designerId: String(appointment.designerId), start: appointment.start, end: appointment.end };
    if (patch.garmentIds) {
      await checkGarments(branchId, { type: appointment.type, customerId: appointment.customerId, garmentIds: patch.garmentIds }, session);
      appointment.garmentIds = patch.garmentIds;
    }
    if (patch.note !== undefined) appointment.note = patch.note;
    if (timingChanged) {
      await lockDays(branchId, days, session);
      await assertFree(branchId, { designerId: target.designerId, date: target.date, start, end }, appointment._id, session);
      appointment.set({ designerId: target.designerId, date: target.date, start, end, minutes: target.minutes, scheduledAt: now });
    }
    appointment.updatedBy = actor.userId;
    appointment.increment();
    await appointment.save({ session });
    return { appointment: appointment.toObject(), previous, timingChanged };
  });
}

/** Cancels a booked appointment (reason optional); its time is free again. */
export function cancelAppointment(branchId, id, { version, patch: { reason } }, actor) {
  return withTransaction(async (session) => {
    const appointment = await loadForChange(branchId, id, version, session);
    appointment.set({ status: 'cancelled', cancelReason: reason || null, statusAt: clock.now(), statusBy: actor.userId });
    appointment.updatedBy = actor.userId;
    appointment.increment();
    await appointment.save({ session });
    return appointment.toObject();
  });
}

/**
 * "Done" / "Didn't come", from the appointment's day onwards. Designers (no appointments.write)
 * may mark only their own; another's is 404.
 */
export function markAppointment(branchId, user, id, { version, patch: { status } }, actor) {
  return withTransaction(async (session) => {
    const now = clock.now();
    const appointment = await loadForChange(branchId, id, version, session, appointmentScope(user));
    if (appointment.date > istDate(now)) {
      throw businessRule('APPOINTMENT_NOT_DUE', 'You can mark this from the day of the appointment');
    }
    appointment.set({ status, statusAt: now, statusBy: actor.userId });
    appointment.updatedBy = actor.userId;
    appointment.increment();
    await appointment.save({ session });
    return appointment.toObject();
  });
}

/** One appointment in the user's scope; 404 otherwise. */
export async function getAppointment(branchId, user, id) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const appointment = await Appointment.findOne({ _id: id, branchId, ...appointmentScope(user) }).lean();
  if (!appointment) throw notFound();
  return appointment;
}

