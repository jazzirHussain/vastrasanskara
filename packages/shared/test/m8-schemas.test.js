import { test, expect, vi, afterEach } from 'vitest';
import { dashboardQuery, metricRowsQuery } from '../src/schemas/dashboard.js';
import { reportRequestSchema, reportListQuery } from '../src/schemas/reports.js';

const id = (n) => String(n).padStart(24, 'a');
const fails = (schema, value) => !schema.safeParse(value).success;

afterEach(() => vi.useRealTimers());
const at = (iso) => vi.useFakeTimers({ now: new Date(iso) });

test('the dashboard query defaults to this month', () => {
  expect(dashboardQuery.parse({})).toEqual({ preset: 'month' });
  expect(dashboardQuery.parse({ designerId: id(1), priority: 'rush', customerType: 'business', fresh: '1' })).toEqual({
    preset: 'month',
    designerId: id(1),
    priority: 'rush',
    customerType: 'business',
    fresh: '1',
  });
  expect(fails(dashboardQuery, { customerType: 'alien' })).toBe(true);
  expect(fails(dashboardQuery, { fresh: '0' })).toBe(true);
});

test('custom needs from and to; other presets refuse them', () => {
  expect(fails(dashboardQuery, { preset: 'custom' })).toBe(true);
  expect(fails(dashboardQuery, { preset: 'custom', from: '2026-11-01' })).toBe(true);
  expect(fails(dashboardQuery, { preset: 'custom', from: '2026-11-05', to: '2026-11-01' })).toBe(true);
  expect(dashboardQuery.parse({ preset: 'custom', from: '2026-11-01', to: '2026-11-05' }).to).toBe('2026-11-05');
  expect(fails(dashboardQuery, { preset: 'week', from: '2026-11-01', to: '2026-11-05' })).toBe(true);
  expect(fails(dashboardQuery, { from: '2026-11-01' })).toBe(true);
});

test('unknown keys are refused', () => {
  expect(fails(dashboardQuery, { nope: 1 })).toBe(true);
  expect(fails(metricRowsQuery, { nope: 1 })).toBe(true);
  expect(fails(reportRequestSchema, { kind: 'gstr1', format: 'xlsx', params: { month: '2020-10' }, extra: 1 })).toBe(true);
  expect(fails(reportRequestSchema, { kind: 'gstr1', format: 'xlsx', params: { month: '2020-10', x: 1 } })).toBe(true);
});

test('metric rows take a cursor and a limit of 1 to 100', () => {
  expect(metricRowsQuery.parse({ limit: '50' }).limit).toBe(50);
  expect(fails(metricRowsQuery, { limit: '0' })).toBe(true);
  expect(fails(metricRowsQuery, { limit: '101' })).toBe(true);
  expect(fails(metricRowsQuery, { cursor: 'x'.repeat(501) })).toBe(true);
  expect(metricRowsQuery.parse({ cursor: 'abc' }).cursor).toBe('abc');
});

test('a report month cannot be in the future', () => {
  at('2026-11-13T05:00:00Z');
  const req = (month) => ({ kind: 'gstr1', format: 'xlsx', params: { month } });
  expect(reportRequestSchema.safeParse(req('2026-10')).success).toBe(true);
  expect(reportRequestSchema.safeParse(req('2026-11')).success).toBe(true);
  expect(fails(reportRequestSchema, req('2026-12'))).toBe(true);
  expect(fails(reportRequestSchema, req('2027-01'))).toBe(true);
  expect(fails(reportRequestSchema, req('2026-13'))).toBe(true);
  expect(fails(reportRequestSchema, { kind: 'gstr1', format: 'xlsx', params: {} })).toBe(true);
});

test('a range is at most one year', () => {
  const req = (from, to) => ({ kind: 'sales_register', format: 'xlsx', params: { from, to } });
  expect(reportRequestSchema.safeParse(req('2026-04-01', '2027-03-31')).success).toBe(true);
  expect(reportRequestSchema.safeParse(req('2027-01-01', '2027-01-01')).success).toBe(true);
  expect(fails(reportRequestSchema, req('2026-01-01', '2027-01-03'))).toBe(true);
  expect(fails(reportRequestSchema, req('2026-04-02', '2026-04-01'))).toBe(true);
  expect(fails(reportRequestSchema, { kind: 'sales_register', format: 'xlsx', params: { from: '2026-04-01' } })).toBe(true);
  expect(fails(reportRequestSchema, { kind: 'sales_register', format: 'xlsx', params: { month: '2026-04' } })).toBe(true);
});

test('a statement needs a customer', () => {
  const params = { from: '2026-04-01', to: '2026-10-31' };
  expect(fails(reportRequestSchema, { kind: 'customer_statement', format: 'pdf', params })).toBe(true);
  expect(reportRequestSchema.safeParse({ kind: 'customer_statement', format: 'pdf', params: { ...params, customerId: id(1) } }).success).toBe(true);
  expect(fails(reportRequestSchema, { kind: 'customer_statement', format: 'pdf', params: { ...params, customerId: 'x' } })).toBe(true);
});

test('formats must be ones the report offers, and none-kind reports take no params', () => {
  const month = { month: '2020-10' };
  expect(fails(reportRequestSchema, { kind: 'gstr1', format: 'csv', params: month })).toBe(true);
  expect(reportRequestSchema.safeParse({ kind: 'gstr3b', format: 'csv', params: month }).success).toBe(true);
  expect(fails(reportRequestSchema, { kind: 'bogus', format: 'xlsx', params: {} })).toBe(true);
  expect(reportRequestSchema.safeParse({ kind: 'stock_valuation', format: 'xlsx', params: {} }).success).toBe(true);
  expect(fails(reportRequestSchema, { kind: 'stock_valuation', format: 'xlsx', params: month })).toBe(true);
});

test('the report list takes a cursor and limit', () => {
  expect(reportListQuery.parse({ limit: '20' }).limit).toBe(20);
  expect(fails(reportListQuery, { limit: '0' })).toBe(true);
  expect(fails(reportListQuery, { nope: 1 })).toBe(true);
});
