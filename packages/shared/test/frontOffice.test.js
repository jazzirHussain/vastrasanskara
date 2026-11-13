import { test, expect } from 'vitest';
import {
  APPOINTMENT_TYPES,
  APPOINTMENT_TYPE_LABELS,
  appointmentWindow,
  appointmentWhen,
  freeStartTimes,
  nextEnquiryStatus,
  overlaps,
  reminderDue,
  REMINDER_DAY_MS,
  REMINDER_SOON_MS,
} from '../src/frontOffice.js';
import { atIstTime } from '../src/fy.js';

const H = 60 * 60 * 1000;

test('appointment types have labels', () => {
  expect(APPOINTMENT_TYPES).toEqual(['consultation', 'measurement', 'fitting', 'pickup']);
  expect(APPOINTMENT_TYPES.map((t) => APPOINTMENT_TYPE_LABELS[t])).toEqual(['Consultation', 'Measurement', 'Fitting', 'Pickup']);
});

test('appointment windows are IST and never cross midnight', () => {
  const w = appointmentWindow({ date: '2026-11-07', time: '23:30', minutes: 15 });
  expect(w.start.toISOString()).toBe('2026-11-07T18:00:00.000Z');
  expect(w.end.toISOString()).toBe('2026-11-07T18:15:00.000Z');
  expect(appointmentWindow({ date: '2026-11-07', time: '23:30', minutes: 30 }).end.toISOString()).toBe('2026-11-07T18:30:00.000Z');
  expect(() => appointmentWindow({ date: '2026-11-07', time: '23:45', minutes: 30 })).toThrow('APPOINTMENT_CROSSES_MIDNIGHT');
  const day = appointmentWindow({ date: '2026-11-07', time: '00:00', minutes: 480 });
  expect(day.start.toISOString()).toBe('2026-11-06T18:30:00.000Z');
  expect(day.end.toISOString()).toBe('2026-11-07T02:30:00.000Z');
});

test('back-to-back appointments do not overlap', () => {
  const a = appointmentWindow({ date: '2026-11-07', time: '10:00', minutes: 60 });
  const b = appointmentWindow({ date: '2026-11-07', time: '11:00', minutes: 30 });
  const c = appointmentWindow({ date: '2026-11-07', time: '10:45', minutes: 30 });
  expect(overlaps(a, b)).toBe(false);
  expect(overlaps(b, a)).toBe(false);
  expect(overlaps(a, c)).toBe(true);
  expect(overlaps({ start: a.start.getTime(), end: a.end.getTime() }, c)).toBe(true);
});

test('free start times skip taken slots, the past and the closing time', () => {
  const taken = [appointmentWindow({ date: '2026-11-07', time: '11:00', minutes: 45 })];
  const base = { date: '2026-11-07', minutes: 60, taken, from: '10:00', to: '13:00' };
  expect(freeStartTimes({ ...base, now: atIstTime('2026-11-07', '09:00') })).toEqual(['10:00', '11:45', '12:00']);
  expect(freeStartTimes({ ...base, now: atIstTime('2026-11-07', '10:20') })).toEqual(['11:45', '12:00']);
  expect(
    freeStartTimes({ date: '2026-11-07', minutes: 15, taken: [], from: '12:00', to: '13:00', now: atIstTime('2026-11-06', '09:00') }),
  ).toEqual(['12:00', '12:15', '12:30', '12:45']);
});

test('a day reminder is due within 24 hours only for appointments booked earlier', () => {
  const start = atIstTime('2026-11-08', '11:00');
  const at = (h) => new Date(start.getTime() - h * H);
  expect(REMINDER_DAY_MS).toBe(24 * H);
  expect(reminderDue({ start, scheduledAt: at(48), now: at(24) })).toBe('day');
  expect(reminderDue({ start, scheduledAt: at(48), now: at(25) })).toBe(null);
  expect(reminderDue({ start, scheduledAt: at(48), now: at(3) })).toBe('day');
  expect(reminderDue({ start, scheduledAt: at(20), now: at(19) })).toBe(null);
});

test('a soon reminder is due within 2 hours unless booked within 2 hours', () => {
  const start = atIstTime('2026-11-08', '11:00');
  const at = (h) => new Date(start.getTime() - h * H);
  expect(REMINDER_SOON_MS).toBe(2 * H);
  expect(reminderDue({ start, scheduledAt: at(48), now: at(2) })).toBe('soon');
  expect(reminderDue({ start, scheduledAt: at(3), now: at(1.5) })).toBe('soon');
  expect(reminderDue({ start, scheduledAt: at(1.5), now: at(1) })).toBe(null);
});

test('no reminder after the start', () => {
  const start = atIstTime('2026-11-08', '11:00');
  const booked = new Date(start.getTime() - 48 * H);
  expect(reminderDue({ start, scheduledAt: booked, now: start })).toBe(null);
  expect(reminderDue({ start, scheduledAt: booked, now: new Date(start.getTime() + H) })).toBe(null);
});

test('a logged call moves a new enquiry to contacted', () => {
  expect(nextEnquiryStatus('new', 'call')).toBe('contacted');
  expect(nextEnquiryStatus('contacted', 'call')).toBe('contacted');
  expect(nextEnquiryStatus('appointment_booked', 'call')).toBe('appointment_booked');
});

test('booking moves an open enquiry to appointment booked', () => {
  expect(nextEnquiryStatus('new', 'appointment')).toBe('appointment_booked');
  expect(nextEnquiryStatus('contacted', 'appointment')).toBe('appointment_booked');
  expect(nextEnquiryStatus('appointment_booked', 'appointment')).toBe('appointment_booked');
  expect(nextEnquiryStatus('contacted', 'lost')).toBe('lost');
  expect(nextEnquiryStatus('appointment_booked', 'convert')).toBe('converted');
});

test('a converted enquiry accepts nothing', () => {
  for (const action of ['call', 'appointment', 'lost', 'reopen', 'convert']) {
    expect(() => nextEnquiryStatus('converted', action)).toThrow('ENQUIRY_CLOSED');
  }
  for (const action of ['call', 'appointment', 'lost', 'convert']) {
    expect(() => nextEnquiryStatus('lost', action)).toThrow('ENQUIRY_CLOSED');
  }
});

test('only a lost enquiry can be reopened', () => {
  expect(nextEnquiryStatus('lost', 'reopen')).toBe('contacted');
  for (const s of ['new', 'contacted', 'appointment_booked']) {
    expect(() => nextEnquiryStatus(s, 'reopen')).toThrow('ENQUIRY_CLOSED');
  }
});

test('appointment times read like Sat 7 Nov, 11:30 am', () => {
  expect(appointmentWhen(atIstTime('2026-11-07', '11:30'))).toBe('Sat 7 Nov, 11:30 am');
  expect(appointmentWhen(atIstTime('2026-11-09', '15:05'))).toBe('Mon 9 Nov, 3:05 pm');
  expect(appointmentWhen(atIstTime('2026-11-09', '00:15'))).toBe('Mon 9 Nov, 12:15 am');
  expect(appointmentWhen(atIstTime('2026-11-09', '12:00'))).toBe('Mon 9 Nov, 12:00 pm');
});
