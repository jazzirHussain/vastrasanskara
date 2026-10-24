import { test, expect } from 'vitest';
import { email, phone, gstin, hhmm } from '../src/schemas/common.js';
test('email normalised', () => { expect(email.parse(' Owner@Example.com ')).toBe('owner@example.com'); });
test('phone normalised', () => { expect(phone.parse('+919876543210')).toBe('9876543210'); expect(() => phone.parse('12345')).toThrow(); });
test('gstin', () => { expect(gstin.safeParse('29ABCDE1234F1Z5').success).toBe(true); expect(gstin.safeParse('29abcde1234f1z5').success).toBe(false); });
test('hhmm', () => { expect(hhmm.safeParse('21:00').success).toBe(true); expect(hhmm.safeParse('24:00').success).toBe(false); });
