import { test, expect } from 'vitest';
import {
  MOVEMENT_TYPES, StockError, formatQty, toUsage, applyMovement, avgCostOf, costAtAverage,
  unitCostToValue, isLow, suggestedOrder, usedReturnCost,
} from '../src/stock.js';

const shelf = (onHand, reserved = 0, value = 0) => ({ onHand, reserved, value });

test('quantities show like 2.5 m and 1,200 pieces', () => {
  expect(formatQty(2500, 'm')).toBe('2.5 m');
  expect(formatQty(1200000, 'pieces')).toBe('1,200 pieces');
  expect(formatQty(125000, 'm')).toBe('125 m');
  expect(formatQty(250, 'm')).toBe('0.25 m');
  expect(formatQty(1, 'm')).toBe('0.001 m');
  expect(formatQty(123456789000, 'pieces')).toBe('12,34,56,789 pieces');
  expect(formatQty(0, 'm')).toBe('0 m');
  expect(MOVEMENT_TYPES).toEqual(['opening', 'purchase_in', 'reserve', 'release', 'consume', 'adjust', 'sale']);
});

test('two packets of 144 are 288 pieces', () => {
  expect(toUsage(2000, 144000)).toBe(288000);
  expect(toUsage(500, 144000)).toBe(72000);
});

test('weighted average after two purchases', () => {
  let s = applyMovement(shelf(0), { type: 'purchase_in', quantity: 10000, cost: 500000 }).balance;
  s = applyMovement(s, { type: 'purchase_in', quantity: 10000, cost: 700000 }).balance;
  expect(s).toEqual({ onHand: 20000, reserved: 0, value: 1200000 });
  expect(avgCostOf(s)).toBe(60000000);
  const out = applyMovement(s, { type: 'consume', quantity: 5000 });
  expect(out.valueChange).toBe(-300000);
  expect(costAtAverage(avgCostOf(s), 5000)).toBe(300000);
  expect(out.balance).toEqual({ onHand: 15000, reserved: 0, value: 900000 });
});

test('using the whole shelf takes the whole value', () => {
  let s = shelf(3000, 0, 1000);
  const changes = [];
  for (let i = 0; i < 3; i++) {
    const r = applyMovement(s, { type: 'consume', quantity: 1000 });
    changes.push(-r.valueChange);
    s = r.balance;
  }
  expect(changes).toEqual([333, 334, 333]);
  expect(changes.reduce((a, b) => a + b)).toBe(1000);
  expect(s).toEqual({ onHand: 0, reserved: 0, value: 0 });
});

test('tiny unit costs keep their fraction', () => {
  const s = shelf(144000, 0, 10000);
  expect(avgCostOf(s)).toBe(69444);
  expect(costAtAverage(69444, 144000)).toBe(10000);
  expect(applyMovement(s, { type: 'consume', quantity: 144000 }).valueChange).toBe(-10000);
  expect(unitCostToValue(7000, 2500)).toBe(17500);
});

test('a reservation cannot exceed free stock', () => {
  const s = shelf(5000, 3000, 5000);
  expect(applyMovement(s, { type: 'reserve', quantity: 2000 }).balance.reserved).toBe(5000);
  expect(() => applyMovement(s, { type: 'reserve', quantity: 2001 })).toThrow(StockError);
  expect(applyMovement(s, { type: 'release', quantity: 3000 }).balance.reserved).toBe(0);
});

test('consuming more than the reservation takes the rest from free stock', () => {
  const s = shelf(10000, 4000, 10000);
  const r = applyMovement(s, { type: 'consume', quantity: 6000, fromReserved: 4000 });
  expect(r.balance).toEqual({ onHand: 4000, reserved: 0, value: 4000 });
  expect(r.valueChange).toBe(-6000);
  expect(() => applyMovement(s, { type: 'consume', quantity: 10001, fromReserved: 4000 })).toThrow(StockError);
  expect(() => applyMovement(s, { type: 'consume', quantity: 6001 })).toThrow(StockError);
});

test('nothing goes negative', () => {
  const s = shelf(10000, 4000, 10000);
  const cases = [
    { type: 'release', quantity: 4001 },
    { type: 'consume', quantity: 10001 },
    { type: 'sale', quantity: 6001 },
    { type: 'consume', quantity: 5000, fromReserved: 4001 },
    { type: 'purchase_in', quantity: -6001, cost: 100 },
    { type: 'purchase_in', quantity: -1000, cost: 10001 },
  ];
  for (const m of cases) {
    let err;
    try { applyMovement(s, m); } catch (e) { err = e; }
    expect(err, JSON.stringify(m)).toBeInstanceOf(StockError);
    expect(err.code).toBe('STOCK_INSUFFICIENT');
    expect(err.free).toBe(6000);
  }
  const undo = applyMovement(s, { type: 'purchase_in', quantity: -6000, cost: 6000 });
  expect(undo.balance).toEqual({ onHand: 4000, reserved: 4000, value: 4000 });
  expect(undo.valueChange).toBe(-6000);
});

test('putting stock in needs a cost and adds its value', () => {
  expect(() => applyMovement(shelf(0), { type: 'opening', quantity: 1000 })).toThrow(RangeError);
  expect(() => applyMovement(shelf(0), { type: 'opening', quantity: 1000, cost: -1 })).toThrow(RangeError);
  const up = applyMovement(shelf(1000, 0, 500), { type: 'adjust', quantity: 1000, cost: 700 });
  expect(up.balance).toEqual({ onHand: 2000, reserved: 0, value: 1200 });
  expect(up.valueChange).toBe(700);
  const back = applyMovement(shelf(0), { type: 'consume', quantity: -1000, cost: 250 });
  expect(back.balance).toEqual({ onHand: 1000, reserved: 0, value: 250 });
  const down = applyMovement(shelf(2000, 0, 1200), { type: 'adjust', quantity: -500 });
  expect(down.valueChange).toBe(-300);
});

test('an empty shelf has no value and no average', () => {
  expect(avgCostOf({ onHand: 0, value: 0 })).toBe(0);
  expect(avgCostOf({ onHand: 0, value: 55 })).toBe(0);
  const r = applyMovement(shelf(1000, 0, 777), { type: 'sale', quantity: 1000 });
  expect(r.balance).toEqual({ onHand: 0, reserved: 0, value: 0 });
});

test('low means free below the reorder level, never when the level is 0', () => {
  expect(isLow({ onHand: 10000, reserved: 4000, reorderLevel: 6001 })).toBe(true);
  expect(isLow({ onHand: 10000, reserved: 4000, reorderLevel: 6000 })).toBe(false);
  expect(isLow({ onHand: 0, reserved: 0, reorderLevel: 0 })).toBe(false);
});

test('the suggested order fills to twice the reorder level in whole packets', () => {
  // free 30 pieces, level 100, target 200, short 170 -> 2 packets of 144
  expect(suggestedOrder({ onHand: 40000, reserved: 10000, reorderLevel: 100000, factor: 144000 })).toBe(2000);
  // already above target: still at least one
  expect(suggestedOrder({ onHand: 500000, reserved: 0, reorderLevel: 100000, factor: 144000 })).toBe(1000);
  expect(suggestedOrder({ onHand: 0, reserved: 0, reorderLevel: 5000, factor: 1000 })).toBe(10000);
});

test('put back is valued at what the garment paid', () => {
  expect(usedReturnCost({ usedQty: 3000, usedCost: 1000 }, 1000)).toBe(333);
  expect(usedReturnCost({ usedQty: 3000, usedCost: 1000 }, 3000)).toBe(1000);
  expect(usedReturnCost({ usedQty: 3000, usedCost: 1000 }, 9000)).toBe(1000);
  expect(usedReturnCost({ usedQty: 0, usedCost: 0 }, 1000)).toBe(0);
});

test('a movement never releases more reservation than it takes out', () => {
  const s = shelf(10000, 4000, 10000);
  expect(() => applyMovement(s, { type: 'consume', quantity: 1000, fromReserved: 4000 })).toThrow(RangeError);
  expect(() => applyMovement(s, { type: 'sale', quantity: 1000, fromReserved: 1001 })).toThrow(RangeError);
  expect(applyMovement(s, { type: 'consume', quantity: 1000, fromReserved: 1000 }).balance.reserved).toBe(3000);
});

test('a balance cannot reserve more than is on hand', () => {
  expect(() => applyMovement(shelf(1000, 2000, 500), { type: 'reserve', quantity: 1 })).toThrow(RangeError);
});
