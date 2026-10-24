import { test, expect } from 'vitest';
import { email, phone, gstin, hhmm } from '../src/schemas/common.js';
test('email normalised', () => { expect(email.parse(' Owner@Example.com ')).toBe('owner@example.com'); });
test('phone normalised to E.164', () => {
  expect(phone.parse('+919876543210')).toBe('+919876543210');
  expect(phone.parse('98765 43210')).toBe('+919876543210');
  expect(phone.parse('+44 7911 123456')).toBe('+447911123456');
  expect(phone.parse('+1 (415) 555-2671')).toBe('+14155552671');
  expect(phone.parse('00971 50 123 4567')).toBe('+971501234567');
  expect(() => phone.parse('12345')).toThrow();
  expect(() => phone.parse('+44 12')).toThrow();
  expect(() => phone.parse('call me')).toThrow();
});
test('gstin', () => { expect(gstin.safeParse('29ABCDE1234F1Z5').success).toBe(true); expect(gstin.safeParse('29abcde1234f1z5').success).toBe(false); });
test('hhmm', () => { expect(hhmm.safeParse('21:00').success).toBe(true); expect(hhmm.safeParse('24:00').success).toBe(false); });
