import { test, expect } from 'vitest';
import {
  parseChoice,
  parseDate,
  parseEmail,
  parseList,
  parsePercent,
  parsePhone,
  parseQty,
  parseRupees,
  parseState,
  parseText,
  parseYesNo,
} from '../src/imports/values.js';
import { CsvError, parseCsv } from '../src/imports/csv.js';

const ok = (result) => {
  expect(result.error).toBeUndefined();
  return result.value;
};

test('phones in every common form', () => {
  for (const raw of ['+91 98765 43210', '098765-43210', 9876543210, 9.87654321e9, '9.876543210E+09', '919876543210', '(987) 654-3210']) {
    expect(ok(parsePhone(raw))).toBe('9876543210');
  }
  expect(parsePhone('98765').error).toBe("'98765' is not a 10-digit mobile number.");
  expect(parsePhone('1234567890').error).toMatch(/is not a 10-digit mobile number/);
  expect(ok(parsePhone(''))).toBeNull();
  expect(ok(parsePhone(null))).toBeNull();
});

test('a phone that lost digits in scientific notation is refused, never guessed', () => {
  // Excel shows 919876543210 as 9.19877E+11 and "Save as CSV" writes exactly that.
  for (const raw of ['9.19877E+11', '9.88E+09', '9.876E+09', '9.8765432E+09', '9.87654321E+09']) {
    expect(parsePhone(raw).error).toBe(
      `'${raw}' lost digits when the file was saved. Format the phone column as Text and save again.`,
    );
  }
  // Every digit still there: accepted.
  expect(ok(parsePhone('9.876543210E+09'))).toBe('9876543210');
  expect(ok(parsePhone('9.19876543210E+11'))).toBe('9876543210');
});

test('dates are read day first', () => {
  expect(ok(parseDate('05/11/2026'))).toBe('2026-11-05');
  expect(ok(parseDate('5-11-26'))).toBe('2026-11-05');
  expect(ok(parseDate('5.11.26'))).toBe('2026-11-05');
  expect(ok(parseDate(46331))).toBe('2026-11-05');
  expect(ok(parseDate('2026-11-05'))).toBe('2026-11-05');
  expect(ok(parseDate(new Date(Date.UTC(2026, 10, 5))))).toBe('2026-11-05');
  expect(parseDate('31/02/2026').error).toBe("'31/02/2026' is not a real date.");
  expect(parseDate('next week').error).toMatch(/is not a date/);
});

test('rupee amounts with commas and symbols', () => {
  expect(ok(parseRupees('₹1,20,000.50'))).toBe(12000050);
  expect(ok(parseRupees('Rs. 500'))).toBe(50000);
  expect(ok(parseRupees('INR 75'))).toBe(7500);
  expect(ok(parseRupees(1234.5))).toBe(123450);
  expect(ok(parseRupees(0))).toBe(0);
  expect(parseRupees('12.345').error).toMatch(/more than 2 decimal places/);
  expect(parseRupees('-5').error).toMatch(/cannot be less than zero/);
  expect(parseRupees('five hundred').error).toMatch(/is not an amount in rupees/);
});

test('yes and no in common forms', () => {
  for (const raw of ['Yes', 'y', 'TRUE', '1', 1, true]) expect(ok(parseYesNo(raw))).toBe(true);
  for (const raw of ['No', 'n', 'false', '0', 0, false]) expect(ok(parseYesNo(raw))).toBe(false);
  expect(parseYesNo('maybe').error).toBe("Write Yes or No, not 'maybe'.");
});

test('states by name or code', () => {
  expect(ok(parseState('Karnataka'))).toBe('29');
  expect(ok(parseState(' karnataka '))).toBe('29');
  expect(ok(parseState('29'))).toBe('29');
  expect(ok(parseState(7))).toBe('07');
  expect(parseState('Atlantis').error).toMatch(/is not an Indian state or state code/);
});

test('choices by label or key', () => {
  const choices = [{ key: 'normal', label: 'Normal' }, { key: 'rush', label: 'Rush' }];
  expect(ok(parseChoice('Rush', choices))).toBe('rush');
  expect(ok(parseChoice('rush', choices))).toBe('rush');
  expect(ok(parseChoice(' NORMAL ', choices))).toBe('normal');
  expect(parseChoice('Fast', choices).error).toBe("'Fast' is not a choice. Choose one of: Normal, Rush.");
});

test('quantities keep three decimals', () => {
  expect(ok(parseQty('2.5'))).toBe(2500);
  expect(ok(parseQty(3))).toBe(3000);
  expect(ok(parseQty('1.125'))).toBe(1125);
  expect(parseQty('1.2345').error).toMatch(/more than 3 decimal places/);
  expect(parseQty('-1').error).toMatch(/cannot be less than zero/);
});

test('text, email, lists and percentages', () => {
  expect(ok(parseText('  Asha  ', { max: 10 }))).toBe('Asha');
  expect(ok(parseText(560001, { max: 10 }))).toBe('560001');
  expect(parseText('x'.repeat(11), { max: 10 }).error).toBe('Keep this to 10 characters or fewer.');
  expect(parseText('', { required: true }).error).toBe('Fill this in.');
  expect(ok(parseEmail(' Asha@Example.COM '))).toBe('asha@example.com');
  expect(parseEmail('asha@').error).toMatch(/is not an email address/);
  expect(ok(parseList('Embroidery; dyeing, embroidery ,'))).toEqual(['Embroidery', 'dyeing']);
  expect(ok(parsePercent('5%'))).toBe(500);
  expect(ok(parsePercent(12))).toBe(1200);
  expect(ok(parsePercent('2.5'))).toBe(250);
  expect(parsePercent('abc').error).toMatch(/is not a percentage/);
});

test('quoted commas, quotes and new lines', () => {
  const text = 'Name,Note\n"Rao, Asha","She said ""hi""\nthen left"\nRavi,\n';
  expect(parseCsv(text)).toEqual([
    ['Name', 'Note'],
    ['Rao, Asha', 'She said "hi"\nthen left'],
    ['Ravi', ''],
  ]);
});

test('a BOM and CRLF are handled', () => {
  expect(parseCsv('﻿Name,Phone\r\nAsha,98765\r\n\r\n\r\n')).toEqual([['Name', 'Phone'], ['Asha', '98765']]);
});

test('an unclosed quote is an error', () => {
  expect(() => parseCsv('Name\n"Asha')).toThrow(CsvError);
});
