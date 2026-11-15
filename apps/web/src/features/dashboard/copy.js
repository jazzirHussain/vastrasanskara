import { formatINR } from '@vs/shared/money.js';

const plural = (n, one, many) => (n === 1 ? one : many);

/** The plain sentence of an attention item, or null when there is nothing to say. */
export const ATTENTION = {
  late_garments: ({ count }) => `${count} ${plural(count, 'garment is', 'garments are')} late`,
  pickups_at_risk: ({ count }) => `${count} ${plural(count, 'pickup is', 'pickups are')} due in 3 days and not nearly ready`,
  fittings_today: ({ count }) => `${count} ${plural(count, 'fitting', 'fittings')} today`,
  overdue_bills: ({ count, amount }) => `${count} ${plural(count, 'bill is', 'bills are')} overdue${amount ? ` — ${formatINR(amount)}` : ''}`,
  qc_failed: ({ count }) => `${count} ${plural(count, 'garment', 'garments')} failed a quality check this week`,
  low_stock: ({ count }) => `${count} stock ${plural(count, 'item is', 'items are')} running low`,
  vendor_overdue: ({ count }) => `${count} ${plural(count, 'garment is late back from a vendor', 'garments are late back from vendors')}`,
  follow_ups_due: ({ count }) => `${count} follow-up ${plural(count, 'call is', 'calls are')} due`,
  on_hold_orders: ({ count }) => `${count} ${plural(count, 'order is', 'orders are')} on hold`,
};

/** What the change is compared with, by preset. */
export const COMPARED_WITH = { today: 'yesterday', week: 'last week', month: 'last month', fy: 'last year', custom: 'the period before' };

const FILTER_NAMES = { designer: 'designer', priority: 'priority', customerType: 'customer type' };

/** "Not filtered by customer type" (or null) for a tile's notFilteredBy list. */
export function notFilteredText(list = []) {
  if (!list.length) return null;
  const names = list.map((f) => FILTER_NAMES[f] ?? f);
  return `Not filtered by ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`}`;
}

export const UNAVAILABLE = 'Could not load this part. Tap Refresh to try again.';
