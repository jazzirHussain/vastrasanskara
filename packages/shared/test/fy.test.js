import { test, expect } from 'vitest';
import { istDate, istTime, periodOf, financialYear, istDayBounds, atIstTime, addDaysYmd } from '../src/fy.js';

test('financial year boundary at IST midnight 1 April', () => {
  expect(financialYear(new Date('2027-03-31T18:29:59.999Z'))).toEqual({ startYear: 2026, label: '2026-27', code: '2627' });
  expect(financialYear(new Date('2027-03-31T18:30:00.000Z'))).toEqual({ startYear: 2027, label: '2027-28', code: '2728' });
});
test('IST date, time and period', () => {
  const d = new Date('2026-10-21T19:00:00Z');
  expect(istDate(d)).toBe('2026-10-22');
  expect(istTime(d)).toBe('00:30');
  expect(periodOf(d)).toBe('2026-10');
});
test('day bounds and wall-clock conversion', () => {
  expect(istDayBounds('2026-10-22')).toEqual({ start: new Date('2026-10-21T18:30:00.000Z'), end: new Date('2026-10-22T18:29:59.999Z') });
  expect(atIstTime('2026-10-22', '09:00')).toEqual(new Date('2026-10-22T03:30:00.000Z'));
  expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
});
