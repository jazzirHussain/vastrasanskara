// Appointment notification events. Templates are per event and channel, so each change has a
// client event (email, sent only with consent) and a '.designer' event (in-app and email). No phone
// number ever goes into the message variables.
import { APPOINTMENT_TYPE_LABELS, appointmentWhen, istDate } from '@vs/shared';
import { clock } from '../../clock.js';
import { defineEvent } from '../../core/notify/catalog.js';
import { emit } from '../../core/notify/emit.js';
import { getCustomerSummaries } from '../customers/service.js';
import { getEnquiryParties } from '../enquiries/service.js';
import { getUserNames } from '../users/service.js';

const CLIENT = (subject, body) => ({ recipients: ['client'], channels: ['email'], templates: { email: { subject, body } } });
const DESIGNER = (subject, body) => ({
  recipients: ['designer'],
  channels: ['in_app', 'email'],
  templates: { in_app: { body }, email: { subject, body } },
});

defineEvent(
  'appointment.booked',
  CLIENT(
    'Your appointment on {when}',
    'Hello {customerName},\n\nYour {type} at Vastrasanskara is booked for {when} with {designerName}.\n\nIf you need to change it, please call us.',
  ),
);
defineEvent('appointment.booked.designer', DESIGNER('New appointment: {when}', '{type} with {customerName} on {when}.'));
defineEvent(
  'appointment.changed',
  CLIENT(
    'Your appointment has moved to {when}',
    'Hello {customerName},\n\nYour {type} has moved from {previousWhen} to {when} with {designerName}.',
  ),
);
defineEvent(
  'appointment.changed.designer',
  DESIGNER('Appointment moved: {when}', '{type} with {customerName} moved from {previousWhen} to {when}.'),
);
defineEvent(
  'appointment.cancelled',
  CLIENT(
    'Your appointment on {when} is cancelled',
    'Hello {customerName},\n\nYour {type} on {when} is cancelled. Please call us to book another time.',
  ),
);
defineEvent('appointment.cancelled.designer', DESIGNER('Appointment cancelled: {when}', '{type} with {customerName} on {when} is cancelled.'));
defineEvent(
  'appointment.reminder',
  CLIENT(
    'Reminder: your appointment {whenRelative}',
    'Hello {customerName},\n\nA reminder of your {type} at Vastrasanskara {whenRelative} ({when}) with {designerName}.',
  ),
);
defineEvent(
  'appointment.reminder.designer',
  DESIGNER('Reminder: {type} with {customerName} at {time}', 'Reminder: {type} with {customerName} at {time}.'),
);

/**
 * Queues `event` ('appointment.booked' | '.changed' | '.cancelled' | '.reminder') for the
 * appointment's client (unless `includeClient` is false) and its designer (or `designerId`, e.g.
 * the designer it moved away from). Inside the caller's `session`. Returns how many were queued.
 */
export async function emitAppointmentEvent(
  event,
  appointment,
  { previous = null, refId, sequence = 1, includeClient = true, designerId = appointment.designerId, now = clock.now() },
  session,
) {
  const { branchId } = appointment;
  const enquiries = await getEnquiryParties(branchId, [appointment.enquiryId], session);
  const enquiry = appointment.enquiryId ? enquiries.get(String(appointment.enquiryId)) : null;
  const customerId = appointment.customerId ?? enquiry?.convertedCustomerId ?? null;
  const [customers, names] = await Promise.all([
    getCustomerSummaries(branchId, [customerId], session),
    getUserNames([appointment.designerId]),
  ]);
  const when = appointmentWhen(appointment.start);
  const label = APPOINTMENT_TYPE_LABELS[appointment.type];
  const vars = {
    customerName: (customerId && customers.get(String(customerId))?.name) || enquiry?.name || '',
    when,
    previousWhen: previous ? appointmentWhen(previous.start) : '',
    designerName: names.get(String(appointment.designerId)) ?? '',
    time: when.split(', ')[1],
    whenRelative: istDate(appointment.start) === istDate(now) ? 'today' : 'tomorrow',
    link: `/appointments?date=${appointment.date}`,
  };
  let queued = 0;
  if (includeClient && customerId) {
    queued += await emit(
      event,
      { branchId, refId, sequence, data: { customerId: String(customerId) }, vars: { ...vars, type: label.toLowerCase() } },
      { session },
    );
  }
  queued += await emit(
    `${event}.designer`,
    { branchId, refId, sequence, data: { designerId: String(designerId) }, vars: { ...vars, type: label } },
    { session },
  );
  return queued;
}
