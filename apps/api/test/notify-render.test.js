import { test, expect } from 'vitest';
import { renderTemplate, escapeHtml } from '../src/core/notify/render.js';
import { nextAllowedTime } from '../src/core/notify/quietHours.js';
import { renderEmail } from '../src/core/notify/emailLayout.js';
const w = { start: '21:00', end: '09:00' };

test('renders variables', () => {
  expect(renderTemplate('Hi {customerName}, bill {invoiceNo}', { customerName: 'Asha', invoiceNo: 'INV/2627/0001' })).toBe('Hi Asha, bill INV/2627/0001');
  expect(() => renderTemplate('{customerName}', {})).toThrow('customerName');
  expect(renderTemplate('{x}', { x: '<b>' }, { escape: escapeHtml })).toBe('&lt;b&gt;');
});
test('quiet hours', () => {
  expect(nextAllowedTime(new Date('2026-10-22T16:30:00Z'), w)).toEqual(new Date('2026-10-23T03:30:00Z')); // 22:00 IST
  expect(nextAllowedTime(new Date('2026-10-21T19:00:00Z'), w)).toEqual(new Date('2026-10-22T03:30:00Z')); // 00:30 IST
  expect(nextAllowedTime(new Date('2026-10-22T03:29:00Z'), w)).toEqual(new Date('2026-10-22T03:30:00Z')); // 08:59 IST
  const day = new Date('2026-10-22T04:30:00Z'); // 10:00 IST
  expect(nextAllowedTime(day, w)).toEqual(day);
  expect(nextAllowedTime(day, null)).toEqual(day);
});
test('email layout', () => {
  const e = renderEmail({ branch: { name: 'Vastrasanskara', phone: '9876543210', email: 'a@b.c' }, subject: 'S', body: 'Line1\nLine2 <x>' });
  expect(e.html).toContain('Vastrasanskara');
  expect(e.html).toContain('Line1<br>Line2 &lt;x&gt;');
  expect(e.text).toBe('Line1\nLine2 <x>\n\n— Vastrasanskara, 9876543210');
});

test('quiet-hour boundaries and same-day windows', () => {
  const startOfQuiet = new Date('2026-10-22T15:30:00Z'); // 21:00 IST exactly
  expect(nextAllowedTime(startOfQuiet, w)).toEqual(new Date('2026-10-23T03:30:00Z'));
  const endOfQuiet = new Date('2026-10-22T03:30:00Z'); // 09:00 IST exactly
  expect(nextAllowedTime(endOfQuiet, w)).toEqual(endOfQuiet);
  const lunch = { start: '13:00', end: '14:00' };
  expect(nextAllowedTime(new Date('2026-10-22T08:00:00Z'), lunch)).toEqual(new Date('2026-10-22T08:30:00Z')); // 13:30 → 14:00 IST
  expect(nextAllowedTime(new Date('2026-10-22T09:00:00Z'), lunch)).toEqual(new Date('2026-10-22T09:00:00Z')); // 14:30 IST
  expect(nextAllowedTime(endOfQuiet, { start: '10:00', end: '10:00' })).toEqual(endOfQuiet); // empty window
});
test('template edge cases and email without phone', () => {
  expect(renderTemplate('{n} items, {n} left', { n: 3 })).toBe('3 items, 3 left');
  expect(() => renderTemplate('{a}', { a: null })).toThrow('Missing template variable: a');
  expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  const e = renderEmail({ branch: { name: 'Vastrasanskara', phone: null, email: null }, subject: 'S <b>', body: 'Hi' });
  expect(e.text).toBe('Hi\n\n— Vastrasanskara');
  expect(e.subject).toBe('S <b>');
  expect(e.html).toContain('<title>S &lt;b&gt;</title>');
});
