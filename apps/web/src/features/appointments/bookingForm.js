// The booking form and the day view's free times, as plain functions (tested on their own).
import { addDaysYmd, atIstTime, istDate } from '@vs/shared/fy.js';
import { APPOINTMENT_TYPES, freeStartTimes, SLOT_STEP_MINUTES } from '@vs/shared/frontOffice.js';

const QUARTER = /^([01]\d|2[0-3]):(00|15|30|45)$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The form from a link: ?type&customerId|enquiryId&designerId&date&time&orderId&garmentId. */
export function bookingDefaults(params, { settings, today }) {
  const garmentId = params.get('garmentId');
  const asked = params.get('type');
  const type = APPOINTMENT_TYPES.includes(asked) ? asked : garmentId ? 'fitting' : 'consultation';
  const time = params.get('time') ?? '';
  return {
    type,
    customerId: params.get('customerId') || null,
    enquiryId: params.get('customerId') ? null : params.get('enquiryId') || null,
    designerId: params.get('designerId') || null,
    date: params.get('date') || today,
    time: QUARTER.test(time) ? time : '',
    minutes: settings.appointmentDurations[type],
    orderId: params.get('orderId') || null,
    garmentIds: garmentId ? [garmentId] : [],
    note: '',
  };
}

/** Appointments of one designer in a day view that still hold their time. */
const takenBy = (day, designerId, exceptId) =>
  (day?.designers.find((d) => d.id === designerId)?.appointments ?? [])
    .filter((a) => a.status !== 'cancelled' && a.id !== exceptId)
    .map((a) => ({ start: new Date(a.start), end: new Date(a.end) }));

/** Free quarter-hour start times of `designerId` on the day view's date, from opening to closing time. */
export function timeChoices(day, { designerId, minutes, settings, now, exceptId = null }) {
  if (!day || !designerId || !minutes) return [];
  return freeStartTimes({
    date: day.date,
    minutes,
    taken: takenBy(day, designerId, exceptId),
    from: settings.openingTime,
    to: settings.closingTime,
    now,
  });
}

/** The POST /v1/appointments body. */
export function bookingBody(form) {
  return {
    type: form.type,
    designerId: form.designerId,
    customerId: form.customerId ?? null,
    enquiryId: form.customerId ? null : (form.enquiryId ?? null),
    date: form.date,
    time: form.time,
    minutes: form.minutes,
    garmentIds: form.type === 'fitting' && form.customerId ? form.garmentIds : [],
    note: form.note.trim(),
  };
}

/** Today, Tomorrow and the next five days ('Thu 3'). */
export function dayChoices(today) {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDaysYmd(today, i);
    const d = new Date(`${date}T00:00:00Z`);
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
    return { label, date };
  });
}

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmmOf = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const istMinutes = (iso, date) => Math.round((new Date(iso) - atIstTime(date, '00:00')) / 60_000);

/**
 * The free stretches of a designer's day between opening and closing time, around `appointments`
 * (not cancelled); on today, nothing before the next quarter hour.
 */
export function freeGaps(appointments, { date, settings, now }) {
  let from = minutesOf(settings.openingTime);
  const close = minutesOf(settings.closingTime);
  if (istDate(now) === date) {
    const nowMinutes = istMinutes(now.toISOString(), date);
    from = Math.max(from, Math.ceil((nowMinutes + 1) / SLOT_STEP_MINUTES) * SLOT_STEP_MINUTES);
  } else if (date < istDate(now)) {
    return [];
  }
  const busy = appointments
    .filter((a) => a.status !== 'cancelled')
    .map((a) => [istMinutes(a.start, date), istMinutes(a.end, date)])
    .sort((x, y) => x[0] - y[0]);
  const gaps = [];
  let cursor = from;
  for (const [start, end] of busy) {
    if (start > cursor && cursor < close) gaps.push({ from: hhmmOf(cursor), to: hhmmOf(Math.min(start, close)) });
    cursor = Math.max(cursor, end);
  }
  if (cursor < close) gaps.push({ from: hhmmOf(cursor), to: hhmmOf(close) });
  return gaps;
}

/** '14:30' → '2:30 pm'. */
export function time12(hhmm) {
  const h = Number(hhmm.slice(0, 2));
  return `${h % 12 === 0 ? 12 : h % 12}:${hhmm.slice(3, 5)} ${h < 12 ? 'am' : 'pm'}`;
}
