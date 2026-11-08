import { test, expect } from 'vitest';
import { qtyInput, showQty, showUnitCost } from './qty.js';

test('typed quantities become milli-units', () => {
  expect(qtyInput('2.5')).toBe(2500);
  expect(qtyInput(' 12 ')).toBe(12000);
  expect(qtyInput('0.125')).toBe(125);
  expect(qtyInput('0')).toBe(0);
  expect(qtyInput('1.2345')).toBeNull();
  expect(qtyInput('')).toBeNull();
  expect(qtyInput('abc')).toBeNull();
  expect(qtyInput('-1')).toBeNull();
  expect(showQty(12500, 'm')).toBe('12.5 m');
});

test('unit costs under a rupee keep four decimals', () => {
  expect(showUnitCost(50_000_000, 'metre')).toBe('₹500.00 per metre');
  expect(showUnitCost(69_444, 'piece')).toBe('₹0.6944 per piece');
  expect(showUnitCost(100_000, 'piece')).toBe('₹1.00 per piece');
});
