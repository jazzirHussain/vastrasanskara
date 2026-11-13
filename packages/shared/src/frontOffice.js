// Front-office rules shared by the API and the web: appointment time windows (IST), overlap,
// free start times, which reminder is due, and the enquiry status machine. All pure.
import { addDaysYmd, atIstTime, istDate, istTime } from './fy.js';

export const APPOINTMENT_TYPES = Object.freeze(['consultation', 'measurement', 'fitting', 'pickup']);
export const APPOINTMENT_TYPE_LABELS = Object.freeze({
  consultation: 'Consultation',
  measurement: 'Measurement',
  fitting: 'Fitting',
  pickup: 'Pickup',
});
export const APPOINTMENT_STATUSES = Object.freeze(['booked', 'completed', 'no_show', 'cancelled']);
export const SLOT_STEP_MINUTES = 15;

export const ENQUIRY_STATUSES = Object.freeze(['new', 'contacted', 'appointment_booked', 'converted', 'lost']);
export const OPEN_ENQUIRY_STATUSES = Object.freeze(['new', 'contacted', 'appointment_booked']);
export const LOST_REASONS = Object.freeze(['Too expensive', 'Went elsewhere', 'Could not reach', 'Plans changed', 'Other']);
export const MAX_ENQUIRY_LOG = 100;

const MINUTE_MS = 60 * 1000;
export const REMINDER_DAY_MS = 24 * 60 * MINUTE_MS;
export const REMINDER_SOON_MS = 2 * 60 * MINUTE_MS;

const ms = (d) => (d instanceof Date ? d.getTime() : d);

/** Start and end of an appointment on IST day `date` at `time`; it must end by 24:00 IST that day. */
export function appointmentWindow({ date, time, minutes }) {
  const start = atIstTime(date, time);
  const end = new Date(start.getTime() + minutes * MINUTE_MS);
  if (end > atIstTime(addDaysYmd(date, 1), '00:00')) throw new RangeError('APPOINTMENT_CROSSES_MIDNIGHT');
  return { start, end };
}

/** True when two time ranges share a moment; back-to-back ranges do not. */
export function overlaps(a, b) {
  return ms(a.start) < ms(b.end) && ms(a.end) > ms(b.start);
}

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Quarter-hour start times on `date` from `from` that end by `to`, start after `now` and do not
 * overlap any `taken` range.
 */
export function freeStartTimes({ date, minutes, taken = [], from, to, now }) {
  const result = [];
  const first = Math.ceil(toMinutes(from) / SLOT_STEP_MINUTES) * SLOT_STEP_MINUTES;
  for (let t = first; t + minutes <= toMinutes(to) && t < 24 * 60; t += SLOT_STEP_MINUTES) {
    const time = toHhmm(t);
    const start = atIstTime(date, time);
    const window = { start, end: new Date(start.getTime() + minutes * MINUTE_MS) };
    if (start.getTime() <= ms(now)) continue;
    if (taken.some((slot) => overlaps(window, slot))) continue;
    result.push(time);
  }
  return result;
}

/**
 * Which reminder is due now: 'day' within 24 h of the start (more than 2 h ahead) for an
 * appointment scheduled more than 24 h ahead; 'soon' within 2 h for one scheduled more than 2 h
 * ahead; else null.
 */
export function reminderDue({ start, scheduledAt, now }) {
  const left = ms(start) - ms(now);
  const lead = ms(start) - ms(scheduledAt);
  if (left <= 0) return null;
  if (left <= REMINDER_SOON_MS) return lead > REMINDER_SOON_MS ? 'soon' : null;
  if (left <= REMINDER_DAY_MS) return lead > REMINDER_DAY_MS ? 'day' : null;
  return null;
}

const closed = () => new RangeError('ENQUIRY_CLOSED');

/** The enquiry status after `action` ('call' | 'appointment' | 'lost' | 'reopen' | 'convert'). */
export function nextEnquiryStatus(current, action) {
  const open = OPEN_ENQUIRY_STATUSES.includes(current);
  if (action === 'reopen') {
    if (current !== 'lost') throw closed();
    return 'contacted';
  }
  if (!open) throw closed();
  switch (action) {
    case 'call':
      return current === 'new' ? 'contacted' : current;
    case 'appointment':
      return 'appointment_booked';
    case 'lost':
      return 'lost';
    case 'convert':
      return 'converted';
    default:
      throw new RangeError(`Unknown enquiry action: ${action}`);
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An appointment start for people, in IST: 'Sat 7 Nov, 11:30 am'. */
export function appointmentWhen(start) {
  const [y, m, d] = istDate(start).split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const [hh, mm] = istTime(start).split(':').map(Number);
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${weekday} ${d} ${MONTHS[m - 1]}, ${hour12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`;
}
