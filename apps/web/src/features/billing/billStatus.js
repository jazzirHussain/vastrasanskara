import { payStatus } from '@vs/shared/billing.js';

const LABELS = {
  draft: 'Draft',
  unpaid: 'Unpaid',
  part_paid: 'Part paid',
  paid: 'Paid',
  overdue: 'Overdue',
  cancelled: 'Cancelled',
};

/**
 * The badge for a bill: { status, label } — Draft, Unpaid, Part paid, Paid, Overdue or Cancelled.
 * Takes a full bill (totals + settlement), a list row (payStatus, overdue) or an order's bill
 * row (total, balance).
 */
export function billBadge(invoice) {
  const of = (status) => ({ status, label: LABELS[status] });
  if (invoice.status === 'draft') return of('draft');
  if (invoice.status === 'cancelled') return of('cancelled');
  if (invoice.overdue) return of('overdue');
  const known = invoice.payStatus ?? invoice.settlement?.payStatus;
  if (known) return of(known);
  const total = invoice.total ?? invoice.totals?.total ?? 0;
  const balance = invoice.balance ?? invoice.settlement?.balance ?? total;
  return of(payStatus({ total, balance }));
}

/** How a payment was made, in plain words. */
export const MODE_LABELS = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer' };
