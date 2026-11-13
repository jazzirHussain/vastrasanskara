import { test, expect } from 'vitest';
import {
  DASHBOARD_TILES,
  MAX_LIVE_RANGE_DAYS,
  METRICS,
  MONEY_KEYS,
  PRESETS,
  changeOf,
  comparisonRange,
  isOnTime,
  onTimeRate,
  presetRange,
  requiredPermissions,
} from '../src/dashboard.js';
import { safeCell, toCsv } from '../src/reports/csv.js';
import { REPORTS, isLight, reportFilename } from '../src/reports/catalog.js';

test('presets and the live range cap', () => {
  expect(PRESETS).toEqual(['today', 'week', 'month', 'fy', 'custom']);
  expect(MAX_LIVE_RANGE_DAYS).toBe(400);
});

test('this month runs from the 1st to today and compares with the same days last month', () => {
  const range = presetRange('month', '2027-03-31', {});
  expect(range).toEqual({ from: '2027-03-01', to: '2027-03-31' });
  expect(comparisonRange({ preset: 'month', ...range })).toEqual({ from: '2027-02-01', to: '2027-02-28' });
  expect(comparisonRange({ preset: 'month', from: '2026-11-01', to: '2026-11-13' })).toEqual({ from: '2026-10-01', to: '2026-10-13' });
  expect(comparisonRange({ preset: 'month', from: '2027-01-01', to: '2027-01-20' })).toEqual({ from: '2026-12-01', to: '2026-12-20' });
});

test('this week starts on Monday', () => {
  // 2026-11-13 is a Friday, 2026-11-15 a Sunday and 2026-11-16 a Monday.
  expect(presetRange('week', '2026-11-13', {})).toEqual({ from: '2026-11-09', to: '2026-11-13' });
  expect(presetRange('week', '2026-11-15', {})).toEqual({ from: '2026-11-09', to: '2026-11-15' });
  expect(presetRange('week', '2026-11-16', {})).toEqual({ from: '2026-11-16', to: '2026-11-16' });
  expect(comparisonRange({ preset: 'week', from: '2026-11-09', to: '2026-11-13' })).toEqual({ from: '2026-11-02', to: '2026-11-06' });
});

test('today compares with yesterday', () => {
  expect(presetRange('today', '2026-11-13', {})).toEqual({ from: '2026-11-13', to: '2026-11-13' });
  expect(comparisonRange({ preset: 'today', from: '2026-11-13', to: '2026-11-13' })).toEqual({ from: '2026-11-12', to: '2026-11-12' });
});

test('this year is the financial year to date', () => {
  const range = presetRange('fy', '2027-04-05', {});
  expect(range).toEqual({ from: '2027-04-01', to: '2027-04-05' });
  expect(comparisonRange({ preset: 'fy', ...range })).toEqual({ from: '2026-04-01', to: '2026-04-05' });
  expect(presetRange('fy', '2027-03-31', {})).toEqual({ from: '2026-04-01', to: '2027-03-31' });
  // 29 February has no equivalent a year earlier.
  expect(comparisonRange({ preset: 'fy', from: '2023-04-01', to: '2024-02-29' })).toEqual({ from: '2022-04-01', to: '2023-02-28' });
});

test('a custom range compares with the range just before it', () => {
  const range = presetRange('custom', '2026-11-13', { from: '2026-11-05', to: '2026-11-14' });
  expect(range).toEqual({ from: '2026-11-05', to: '2026-11-14' });
  expect(comparisonRange({ preset: 'custom', ...range })).toEqual({ from: '2026-10-26', to: '2026-11-04' });
});

test('change is up, down or the same, and absent without a previous figure', () => {
  expect(changeOf(120, 100)).toEqual({ previous: 100, diff: 20, direction: 'up' });
  expect(changeOf(80, 100)).toEqual({ previous: 100, diff: -20, direction: 'down' });
  expect(changeOf(100, 100)).toEqual({ previous: 100, diff: 0, direction: 'same' });
  expect(changeOf(5, null)).toBeNull();
  expect(changeOf(5, undefined)).toBeNull();
  expect(changeOf(5, 0)).toEqual({ previous: 0, diff: 5, direction: 'up' });
});

test('a garment is on time when ready by its original date', () => {
  expect(isOnTime({ readyDate: '2026-11-10', originalDueDate: '2026-11-10', originalPickupDate: '2026-11-01' })).toBe(true);
  expect(isOnTime({ readyDate: '2026-11-11', originalDueDate: '2026-11-10', originalPickupDate: '2026-11-20' })).toBe(false);
  // Without its own original due date the order's original pickup date applies.
  expect(isOnTime({ readyDate: '2026-11-09', originalDueDate: null, originalPickupDate: '2026-11-10' })).toBe(true);
  expect(isOnTime({ readyDate: '2026-11-11', originalPickupDate: '2026-11-10' })).toBe(false);
});

test('on-time rate counts garments ready by their original date', () => {
  expect(onTimeRate([])).toEqual({ ready: 0, onTime: 0, rate: null });
  const rows = [{ onTime: true }, { onTime: true }, { onTime: false }];
  expect(onTimeRate(rows)).toEqual({ ready: 3, onTime: 2, rate: 6667 });
  expect(onTimeRate([{ onTime: true }])).toEqual({ ready: 1, onTime: 1, rate: 10000 });
});

test('every metric belongs to a tile and money metrics need money.view', () => {
  expect(DASHBOARD_TILES).toEqual([
    'attention', 'key_numbers', 'production', 'pickups', 'money', 'calendar', 'stock', 'enquiries', 'workload', 'expenses', 'profit',
  ]);
  expect(Object.keys(METRICS)).toHaveLength(31);
  for (const [id, m] of Object.entries(METRICS)) {
    expect(DASHBOARD_TILES, id).toContain(m.tile);
    expect(m.label, id).toMatch(/^[A-Z]/);
    expect(typeof m.permission, id).toBe('string');
    expect(typeof m.money, id).toBe('boolean');
    expect(typeof m.periodic, id).toBe('boolean');
    expect(['designer', 'priority', 'customerType']).toEqual(expect.arrayContaining(m.filters));
    const needs = requiredPermissions(id);
    if (m.money) expect(needs, id).toContain('money.view');
    else expect(needs, id).toEqual([m.permission]);
  }
  expect(METRICS.billed.money).toBe(true);
  expect(METRICS.stock_low.money).toBe(false);
  expect(METRICS.late_garments.money).toBe(false);
  expect(METRICS.outstanding.label).toBe('Owed to you');
  expect(requiredPermissions('stock_reserved')).toEqual(['stock.view', 'money.view']);
  expect(Object.isFrozen(METRICS)).toBe(true);
});

test('money keys are the agreed list', () => {
  expect(MONEY_KEYS).toContain('outstanding');
  expect(MONEY_KEYS).toHaveLength(23);
  expect(Object.isFrozen(MONEY_KEYS)).toBe(true);
});

test('cells that look like formulas are neutralised', () => {
  expect(safeCell('=SUM(A1)')).toBe("'=SUM(A1)");
  expect(safeCell('+919876543210')).toBe("'+919876543210");
  expect(safeCell('-5')).toBe("'-5");
  expect(safeCell('@x')).toBe("'@x");
  expect(safeCell('\tx')).toBe("'\tx");
  expect(safeCell('\rx')).toBe("'\rx");
  expect(safeCell('Priya')).toBe('Priya');
  expect(safeCell(-5)).toBe(-5);
  expect(safeCell(1200)).toBe(1200);
  expect(safeCell(null)).toBeNull();
});

test('CSV quotes commas, quotes and new lines and starts with a BOM', () => {
  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'amount', label: 'Amount', kind: 'money' },
    { key: 'note', label: 'Note, plain' },
  ];
  const csv = toCsv(columns, [
    { name: 'A "B", C', amount: 123450, note: 'line one\nline two' },
    { name: '=HYPERLINK("x")', amount: 5, note: null },
  ]);
  expect(csv.startsWith('﻿')).toBe(true);
  expect(csv).toBe(
    '﻿Name,Amount,"Note, plain"\r\n' +
      '"A ""B"", C",1234.50,"line one\nline two"\r\n' +
      '"\'=HYPERLINK(""x"")",0.05,\r\n',
  );
  expect(toCsv(columns, [])).toBe('﻿Name,Amount,"Note, plain"\r\n');
});

test('every report has a plain label, a group and at least one format', () => {
  expect(REPORTS).toHaveLength(19);
  expect(new Set(REPORTS.map((r) => r.kind)).size).toBe(REPORTS.length);
  for (const r of REPORTS) {
    expect(r.label, r.kind).toMatch(/^[A-Z]/);
    expect(['GST', 'Registers', 'Ledgers', 'Business']).toContain(r.group);
    expect(['month', 'range', 'customer', 'none']).toContain(r.params);
    expect(r.formats.length, r.kind).toBeGreaterThan(0);
  }
  expect(REPORTS.find((r) => r.kind === 'gst_pack').label).toBe('All GST files for a month');
  expect(Object.isFrozen(REPORTS)).toBe(true);
});

test('GSTR-1 is Excel only', () => {
  expect(REPORTS.find((r) => r.kind === 'gstr1').formats).toEqual(['xlsx']);
  expect(REPORTS.find((r) => r.kind === 'gstr3b').formats).toEqual(['xlsx', 'csv']);
  expect(REPORTS.find((r) => r.kind === 'customer_statement').formats).toEqual(['pdf', 'xlsx']);
});

test('multi-sheet reports are not offered as CSV', () => {
  const multi = REPORTS.filter((r) => r.sheets === 'multi').map((r) => r.kind);
  expect(multi).toEqual(['gstr1', 'gst_pack', 'expense_register', 'on_time']);
  for (const r of REPORTS.filter((x) => x.sheets === 'multi')) expect(r.formats, r.kind).not.toContain('csv');
});

test('file names read like GSTR-1 October 2026.xlsx', () => {
  expect(reportFilename({ kind: 'gstr1', params: { month: '2026-10' }, format: 'xlsx' }, {})).toBe('GSTR-1 October 2026.xlsx');
  expect(reportFilename({ kind: 'gstr3b', params: { month: '2026-04' }, format: 'csv' }, {})).toBe('GSTR-3B April 2026.csv');
  expect(
    reportFilename({ kind: 'sales_register', params: { from: '2026-04-01', to: '2026-04-30' }, format: 'xlsx' }, {}),
  ).toBe('Sales register 2026-04-01 to 2026-04-30.xlsx');
  expect(reportFilename({ kind: 'stock_valuation', params: {}, format: 'xlsx' }, {})).toBe('Stock valuation.xlsx');
  expect(
    reportFilename(
      { kind: 'customer_statement', params: { customerId: 'a', from: '2026-04-01', to: '2026-10-31' }, format: 'pdf' },
      { customerName: 'Priya: "S" / Rao' },
    ),
  ).toBe('Statement Priya S Rao 2026-04-01 to 2026-10-31.pdf');
});

test('a month or one customer is light, a year is not', () => {
  expect(isLight({ kind: 'gstr1', params: { month: '2026-10' } })).toBe(true);
  expect(isLight({ kind: 'customer_statement', params: { customerId: 'a', from: '2026-04-01', to: '2027-03-31' } })).toBe(true);
  expect(isLight({ kind: 'sales_register', params: { from: '2026-10-01', to: '2026-10-31' } })).toBe(true);
  expect(isLight({ kind: 'sales_register', params: { from: '2026-10-01', to: '2026-11-01' } })).toBe(false);
  expect(isLight({ kind: 'sales_register', params: { from: '2026-04-01', to: '2027-03-31' } })).toBe(false);
});
