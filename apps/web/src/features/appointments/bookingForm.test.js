import { expect, test } from 'vitest';
import { atIstTime } from '@vs/shared/fy.js';
import { DEFAULT_SETTINGS } from '@vs/shared/schemas/settings.js';
import { appointmentFixture, dayFixture } from '../../test/frontOffice.js';
import { bookingBody, bookingDefaults, dayChoices, freeGaps, timeChoices } from './bookingForm.js';

const D = '2026-12-01';
const settings = { ...DEFAULT_SETTINGS, openingTime: '10:00', closingTime: '13:00' };
const day = dayFixture(D, [
  { id: 'des1', name: 'Meera', appointments: [appointmentFixture({ date: D, time: '11:00', minutes: 45 })] },
  { id: 'des2', name: 'Nila', appointments: [] },
]);

test('only free times within opening hours are offered', () => {
  const now = atIstTime('2026-11-30', '09:00');
  expect(timeChoices(day, { designerId: 'des1', minutes: 60, settings, now })).toEqual(['10:00', '11:45', '12:00']);
  expect(timeChoices(day, { designerId: 'des2', minutes: 60, settings, now })).toEqual([
    '10:00', '10:15', '10:30', '10:45', '11:00', '11:15', '11:30', '11:45', '12:00',
  ]);
  // Moving the 11:00 appointment itself: its own time is free.
  expect(timeChoices(day, { designerId: 'des1', minutes: 45, settings, now, exceptId: 'a1' })).toContain('11:00');
  // Done and no-show appointments still hold their time; cancelled ones never reach the day view.
  const done = dayFixture(D, [{ id: 'des1', name: 'Meera', appointments: [appointmentFixture({ date: D, time: '10:00', status: 'completed' })] }]);
  expect(timeChoices(done, { designerId: 'des1', minutes: 60, settings, now })).toEqual(['11:00', '11:15', '11:30', '11:45', '12:00']);
});

test('today offers no past times', () => {
  const now = atIstTime(D, '11:50');
  expect(timeChoices(day, { designerId: 'des2', minutes: 60, settings, now })).toEqual(['12:00']);
});

test('the length comes from settings for the type', () => {
  const params = new URLSearchParams('type=fitting&customerId=c1');
  expect(bookingDefaults(params, { settings, today: D })).toMatchObject({ type: 'fitting', minutes: 45 });
  expect(bookingDefaults(new URLSearchParams('customerId=c1'), { settings, today: D })).toMatchObject({ type: 'consultation', minutes: 60 });
  expect(bookingDefaults(new URLSearchParams('type=pickup'), { settings, today: D }).minutes).toBe(15);
});

test('links pre-fill the form', () => {
  const params = new URLSearchParams('customerId=c1&designerId=des1&date=2026-12-03&time=12:15&orderId=o1&garmentId=g1');
  expect(bookingDefaults(params, { settings, today: D })).toEqual({
    type: 'fitting',
    customerId: 'c1',
    enquiryId: null,
    designerId: 'des1',
    date: '2026-12-03',
    time: '12:15',
    minutes: 45,
    orderId: 'o1',
    garmentIds: ['g1'],
    note: '',
  });
  const blank = bookingDefaults(new URLSearchParams('enquiryId=e1'), { settings, today: D });
  expect(blank).toMatchObject({ customerId: null, enquiryId: 'e1', designerId: null, date: D, time: '', garmentIds: [] });
  expect(bookingDefaults(new URLSearchParams('time=11:10'), { settings, today: D }).time).toBe('');
});

test('the booking body names the party, the time and the garments', () => {
  const form = { ...bookingDefaults(new URLSearchParams('enquiryId=e1&designerId=des1&time=11:00'), { settings, today: D }), note: ' Bring photos ' };
  expect(bookingBody(form)).toEqual({
    type: 'consultation',
    designerId: 'des1',
    customerId: null,
    enquiryId: 'e1',
    date: D,
    time: '11:00',
    minutes: 60,
    garmentIds: [],
    note: 'Bring photos',
  });
  const fitting = { ...form, type: 'fitting', customerId: 'c1', enquiryId: null, garmentIds: ['g1'] };
  expect(bookingBody(fitting).garmentIds).toEqual(['g1']);
  expect(bookingBody({ ...fitting, type: 'pickup' }).garmentIds).toEqual([]);
});

test('day chips are today, tomorrow and the next five days', () => {
  const days = dayChoices(D);
  expect(days.map((d) => d.label)).toEqual(['Today', 'Tomorrow', 'Thu 3', 'Fri 4', 'Sat 5', 'Sun 6', 'Mon 7']);
  expect(days[2].date).toBe('2026-12-03');
});

test('free gaps lie between appointments within opening hours', () => {
  const now = atIstTime('2026-11-30', '09:00');
  expect(freeGaps(day.designers[0].appointments, { date: D, settings, now })).toEqual([
    { from: '10:00', to: '11:00' },
    { from: '11:45', to: '13:00' },
  ]);
  expect(freeGaps([], { date: D, settings, now: atIstTime(D, '12:20') })).toEqual([{ from: '12:30', to: '13:00' }]);
  expect(freeGaps([], { date: D, settings, now: atIstTime(D, '14:00') })).toEqual([]);
});
