import { test, expect } from 'vitest';
import { rupeesToPaise, formatINR, roundToRupee, allocateProRata, amountInWords } from '../src/money.js';

test('rupeesToPaise', () => {
  expect(rupeesToPaise('1234.5')).toBe(123450);
  expect(rupeesToPaise(10)).toBe(1000);
  expect(() => rupeesToPaise('0.005')).toThrow(RangeError);
});
test('formatINR uses Indian grouping', () => {
  expect(formatINR(12345678)).toBe('₹1,23,456.78');
  expect(formatINR(-5000)).toBe('-₹50.00');
  expect(formatINR(0)).toBe('₹0.00');
});
test('roundToRupee', () => {
  expect(roundToRupee(12345678)).toEqual({ total: 12345700, roundOff: 22 });
  expect(roundToRupee(12345649)).toEqual({ total: 12345600, roundOff: -49 });
  expect(roundToRupee(12345650)).toEqual({ total: 12345700, roundOff: 50 });
});
test('allocateProRata', () => {
  expect(allocateProRata(1000, [1, 1, 1])).toEqual([334, 333, 333]);
  expect(allocateProRata(1001, [3, 1])).toEqual([751, 250]);
  expect(allocateProRata(0, [5, 5])).toEqual([0, 0]);
  expect(() => allocateProRata(100, [0, 0])).toThrow(RangeError);
});
test('amountInWords', () => {
  expect(amountInWords(12345650)).toBe('Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only');
  expect(amountInWords(10000000000)).toBe('Rupees Ten Crore Only');
  expect(amountInWords(100)).toBe('Rupees One Only');
  expect(amountInWords(0)).toBe('Rupees Zero Only');
});
