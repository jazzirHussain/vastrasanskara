// Dashboard rules shared by the API and the web: date presets and their comparison periods,
// change figures, the on-time rule, the money keys, and the catalog of dashboard metrics.
// Pure; business dates are 'YYYY-MM-DD' strings handled by calendar arithmetic only.
import { daysBetween } from './billing.js';
import { addDaysYmd } from './fy.js';

export const PRESETS = Object.freeze(['today', 'week', 'month', 'fy', 'custom']);
export const MAX_LIVE_RANGE_DAYS = 400;

const pad = (n, width = 2) => String(n).padStart(width, '0');
const utcOf = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The same calendar day `n` months earlier, capped at that month's last day. */
function monthsBack(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const index = y * 12 + (m - 1) - n;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${pad(year, 4)}-${pad(month)}-${pad(Math.min(d, daysInMonth(year, month)))}`;
}

/** The date range a preset covers on `today`. A custom range is returned as given. */
export function presetRange(preset, today, { from, to } = {}) {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'week': {
      const sinceMonday = (new Date(utcOf(today)).getUTCDay() + 6) % 7;
      return { from: addDaysYmd(today, -sinceMonday), to: today };
    }
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'fy': {
      const year = Number(today.slice(0, 4));
      const startYear = Number(today.slice(5, 7)) >= 4 ? year : year - 1;
      return { from: `${startYear}-04-01`, to: today };
    }
    case 'custom':
      return { from, to };
    default:
      throw new RangeError(`Unknown preset: ${preset}`);
  }
}

/** The same span one period back, so a change compares like with like. */
export function comparisonRange({ preset, from, to }) {
  switch (preset) {
    case 'today':
      return { from: addDaysYmd(from, -1), to: addDaysYmd(to, -1) };
    case 'week':
      return { from: addDaysYmd(from, -7), to: addDaysYmd(to, -7) };
    case 'month':
      return { from: monthsBack(from, 1), to: monthsBack(to, 1) };
    case 'fy':
      return { from: monthsBack(from, 12), to: monthsBack(to, 12) };
    case 'custom': {
      const length = daysBetween(from, to) + 1;
      const end = addDaysYmd(from, -1);
      return { from: addDaysYmd(end, -(length - 1)), to: end };
    }
    default:
      throw new RangeError(`Unknown preset: ${preset}`);
  }
}

/** Change against a previous figure, or null when there is nothing to compare with. */
export function changeOf(current, previous) {
  if (previous === null || previous === undefined) return null;
  const diff = current - previous;
  return { previous, diff, direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'same' };
}

/** On time: ready by the garment's original due date, else by the order's original pickup date. */
export function isOnTime({ readyDate, originalDueDate, originalPickupDate }) {
  return readyDate <= (originalDueDate ?? originalPickupDate);
}

/** On-time share of rows that each carry a boolean `onTime`. `rate` is in basis points of 10000. */
export function onTimeRate(rows) {
  const ready = rows.length;
  const onTime = rows.filter((r) => r.onTime).length;
  return { ready, onTime, rate: ready === 0 ? null : Math.round((onTime * 10000) / ready) };
}

/** Keys that carry money. Without money.view a response holds none of them, at any depth. */
export const MONEY_KEYS = Object.freeze([
  'amount', 'total', 'balance', 'billed', 'credited', 'collected', 'refunded', 'outstanding', 'overdueAmount',
  'advancesHeld', 'revenue', 'cost', 'profit', 'margin', 'value', 'reservedValue', 'taxable', 'sales', 'expense',
  'expenses', 'material', 'price', 'budget',
]);

export const DASHBOARD_TILES = Object.freeze([
  'attention', 'key_numbers', 'production', 'pickups', 'money', 'calendar', 'stock', 'enquiries', 'workload', 'expenses', 'profit',
]);

const ALL = ['designer', 'priority', 'customerType'];
const metric = (tile, label, permission, { money = false, periodic = false, filters = [] } = {}) =>
  Object.freeze({ tile, label, permission, money, periodic, filters: Object.freeze(filters) });

const ORDERS = 'orders.read.own';

/** Every dashboard figure: its tile, plain label, permission, and which filters narrow it. */
export const METRICS = Object.freeze({
  // Needs attention today
  late_garments: metric('attention', 'Late garments', ORDERS, { filters: ALL }),
  pickups_at_risk: metric('attention', 'Pickups in 3 days, not nearly ready', ORDERS, { filters: ALL }),
  fittings_today: metric('attention', 'Fittings today', 'appointments.own', { filters: ['designer'] }),
  overdue_bills: metric('attention', 'Overdue bills', 'money.view', { money: true, filters: ['customerType'] }),
  qc_failed: metric('attention', 'Failed quality checks', ORDERS, { filters: ALL }),
  low_stock: metric('attention', 'Low stock', 'stock.view'),
  vendor_overdue: metric('attention', 'Vendors running late', ORDERS, { filters: ALL }),
  follow_ups_due: metric('attention', 'Follow-up calls due', 'enquiries.write'),
  on_hold_orders: metric('attention', 'Orders on hold', ORDERS, { filters: ALL }),
  // Key numbers
  active_orders: metric('key_numbers', 'Active orders', ORDERS, { filters: ALL }),
  orders_placed: metric('key_numbers', 'Orders placed', ORDERS, { periodic: true, filters: ALL }),
  billed: metric('key_numbers', 'Billed', 'money.view', { money: true, periodic: true, filters: ['customerType'] }),
  collected: metric('key_numbers', 'Collected', 'money.view', { money: true, periodic: true, filters: ['customerType'] }),
  outstanding: metric('key_numbers', 'Owed to you', 'money.view', { money: true, filters: ['customerType'] }),
  overdue_amount: metric('key_numbers', 'Overdue', 'money.view', { money: true, filters: ['customerType'] }),
  advances_held: metric('key_numbers', 'Advances held', 'money.view', { money: true, filters: ['customerType'] }),
  on_time: metric('key_numbers', 'On time', ORDERS, { periodic: true, filters: ALL }),
  // Other tiles
  stage_garments: metric('production', 'Garments by stage', ORDERS, { filters: ALL }),
  upcoming_pickups: metric('pickups', 'Upcoming pickups', ORDERS, { filters: ALL }),
  month_money: metric('money', 'Billed and collected by month', 'money.view', { money: true, periodic: true, filters: ['customerType'] }),
  receivables_ageing: metric('money', 'Who owes what', 'money.view', { money: true, filters: ['customerType'] }),
  appointments_today: metric('calendar', 'Today’s calendar', 'appointments.own', { filters: ['designer'] }),
  stock_low: metric('stock', 'Items running low', 'stock.view'),
  stock_reserved: metric('stock', 'Stock set aside for orders', 'stock.view', { money: true }),
  stock_item_profit: metric('stock', 'Profit by stock item', 'stock.view', { money: true, periodic: true }),
  enquiry_sources: metric('enquiries', 'Enquiries by source', 'enquiries.write', { periodic: true }),
  workload_designers: metric('workload', 'Work with each designer', ORDERS, { filters: ['priority', 'customerType'] }),
  workload_vendors: metric('workload', 'Work with each vendor', ORDERS, { filters: ALL }),
  expense_categories: metric('expenses', 'Spending by category', 'expenses.view', { money: true, periodic: true }),
  profit: metric('profit', 'Profit', 'costing.view', { money: true, periodic: true }),
  order_profits: metric('profit', 'Profit by order', 'costing.view', { money: true, periodic: true, filters: ALL }),
});

/** The permissions a user needs to see a metric: its own, plus money.view for money figures. */
export function requiredPermissions(id) {
  const m = METRICS[id];
  if (!m) throw new RangeError(`Unknown metric: ${id}`);
  return m.money && m.permission !== 'money.view' ? [m.permission, 'money.view'] : [m.permission];
}
