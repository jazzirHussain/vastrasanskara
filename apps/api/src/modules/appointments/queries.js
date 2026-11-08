// Appointment reads: the designer day view, lists and figures. Re-exported by service.js.
//
// M8 dashboard: tile 6 (today's calendar by designer) = appointmentsForDay(today); tile 1 (today's
// fittings) = its cards with type 'fitting'; appointmentCounts for the period figures.
import mongoose from 'mongoose';
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES, istDate } from '@vs/shared';
import { clock } from '../../clock.js';
import { paginate } from '../../core/pagination.js';
import { getCustomerSummaries } from '../customers/service.js';
import { enquiryIdsForCustomer, getEnquiryParties } from '../enquiries/service.js';
import { getGarmentsForAppointment } from '../orders/service.js';
import { readSettings } from '../settings/service.js';
import { getUserNames, listDesigners } from '../users/service.js';
import { clientIdOf, toAppointmentJson } from './json.js';
import { Appointment } from './model.js';

const { ObjectId } = mongoose.Types;
const oid = (id) => new ObjectId(String(id));
const WRITE = 'appointments.write';

/** Users without appointments.write see only appointments where they are the designer. */
export const appointmentScope = (user) => (user?.permissions?.has(WRITE) ? {} : { designerId: user.id });
const seesAll = (user) => Boolean(user?.permissions?.has(WRITE));

/** Everything toAppointmentJson needs for these appointments, in batched reads. */
export async function appointmentJsonContext(branchId, appointments, session) {
  const enquiries = await getEnquiryParties(branchId, appointments.map((a) => a.enquiryId), session);
  const [names, customers, garmentRows] = await Promise.all([
    getUserNames(appointments.flatMap((a) => [a.designerId, a.statusBy])),
    getCustomerSummaries(branchId, appointments.map((a) => clientIdOf(a, enquiries)), session),
    getGarmentsForAppointment(branchId, appointments.flatMap((a) => a.garmentIds ?? []), session),
  ]);
  return { names, customers, enquiries, garments: new Map(garmentRows.map((g) => [g.id, g])) };
}

/** Appointments as the API answers them. */
export async function appointmentsJson(branchId, appointments) {
  const ctx = await appointmentJsonContext(branchId, appointments);
  return appointments.map((a) => toAppointmentJson(a, ctx));
}

/** Appointments of one IST day (not cancelled), optionally for some designers only. */
export function dayFilter(branchId, { date, designerIds }) {
  return {
    branchId: oid(branchId),
    ...(designerIds ? { designerId: { $in: designerIds.map(oid) } } : {}),
    date,
    status: { $ne: 'cancelled' },
  };
}

/**
 * One day, one column per designer, in time order. Front desk sees every active designer (and
 * inactive ones with appointments that day), or the one asked for; a designer sees only their own
 * column whatever is asked.
 */
export async function appointmentsForDay(branchId, user, { date, designerId }) {
  const only = seesAll(user) ? designerId : user.id;
  const [appointments, active, settings] = await Promise.all([
    Appointment.find(dayFilter(branchId, { date, designerIds: only ? [only] : undefined })).sort({ start: 1, _id: 1 }).lean(),
    listDesigners(branchId),
    readSettings(branchId),
  ]);
  const columns = new Map(only ? [] : active.map((d) => [d.id, d.name]));
  const extra = await getUserNames([...(only ? [only] : []), ...appointments.map((a) => a.designerId)]);
  for (const id of [...(only ? [only] : []), ...appointments.map((a) => String(a.designerId))]) {
    if (!columns.has(id)) columns.set(id, extra.get(id) ?? null);
  }
  const json = await appointmentsJson(branchId, appointments);
  const designers = [...columns.entries()]
    .map(([id, name]) => ({ id, name, appointments: json.filter((a) => a.designer.id === id) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id));
  return { date, openingTime: settings.openingTime, closingTime: settings.closingTime, designers };
}

/** The filter of an appointment list; `enquiryIds` are the customer's converted enquiries. */
export function appointmentListFilter(branchId, { from, to, designerId, customerId, enquiryIds = [], enquiryId, status } = {}) {
  const filter = { branchId: oid(branchId) };
  if (designerId) filter.designerId = oid(designerId);
  if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (status) filter.status = status;
  if (enquiryId) filter.enquiryId = { $eq: oid(enquiryId), $type: 'objectId' };
  if (customerId) {
    // Each clause carries the branch so by_customer / by_enquiry serve it (not a scan of the
    // branch's days); partial indexes also need the $type in the query to be chosen.
    const { branchId: branch, ...rest } = filter;
    return {
      ...rest,
      $or: [
        { branchId: branch, customerId: { $eq: oid(customerId), $type: 'objectId' } },
        ...(enquiryIds.length ? [{ branchId: branch, enquiryId: { $in: enquiryIds.map(oid), $type: 'objectId' } }] : []),
      ],
    };
  }
  return filter;
}

/**
 * One page of appointments in the user's scope. A customer's list includes appointments booked for
 * enquiries later converted to that customer. Soonest first; newest first for a past range.
 */
export async function listAppointments(branchId, user, { from, to, designerId, customerId, enquiryId, status, cursor, limit } = {}) {
  const enquiryIds = customerId ? await enquiryIdsForCustomer(branchId, customerId) : [];
  const filter = appointmentListFilter(branchId, {
    from,
    to,
    designerId: seesAll(user) ? designerId : user.id,
    customerId,
    enquiryIds,
    enquiryId,
    status,
  });
  const dir = to && to < istDate(clock.now()) ? -1 : 1;
  return paginate(Appointment, filter, { sort: ['start', dir], cursor, limit });
}

/** Booked appointments starting in (now, now + 24 h] — the reminders scan. */
export function reminderFilter(branchId, now) {
  return {
    status: 'booked',
    start: { $gt: now, $lte: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
    ...(branchId ? { branchId: oid(branchId) } : {}),
  };
}

/** Appointments of IST days from..to by status and by type (cancelled ones count by status only). */
export async function appointmentCounts(branchId, { from, to, designerId }) {
  const rows = await Appointment.aggregate([
    { $match: { branchId: oid(branchId), date: { $gte: from, $lte: to }, ...(designerId ? { designerId: oid(designerId) } : {}) } },
    { $group: { _id: { status: '$status', type: '$type' }, n: { $sum: 1 } } },
  ]);
  const result = Object.fromEntries(APPOINTMENT_STATUSES.map((s) => [s, 0]));
  result.byType = Object.fromEntries(APPOINTMENT_TYPES.map((t) => [t, 0]));
  for (const { _id, n } of rows) {
    result[_id.status] += n;
    if (_id.status !== 'cancelled') result.byType[_id.type] += n;
  }
  return result;
}
