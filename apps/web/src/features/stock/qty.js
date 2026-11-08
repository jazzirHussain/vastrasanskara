import { toMilli } from '@vs/shared/gst.js';
import { formatINR, rupeesToPaise } from '@vs/shared/money.js';
import { formatQty } from '@vs/shared/stock.js';

/** A typed quantity ("2.5") as milli-units of the unit (2500); null when it is not a quantity with up to 3 decimals. */
export function qtyInput(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try {
    return toMilli(t);
  } catch {
    return null;
  }
}

/** Typed rupees ("0.70") as paise (70); null when blank or not an amount. */
export function paiseInput(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try {
    return rupeesToPaise(t);
  } catch {
    return null;
  }
}

/** Milli-units for people: 12500 m → "12.5 m". */
export const showQty = (milli, unit) => formatQty(milli, unit);

/** A milli-unit quantity as text for an input ("12.5"). */
export const qtyText = (milli) => formatQty(milli).replace(/,/g, '');

/**
 * An average cost (milli-paise per unit) for people: "₹500.00 per metre"; under a rupee it keeps
 * four decimals ("₹0.6944 per piece") so a button's fraction of a rupee shows.
 */
export function showUnitCost(avgCost, unit) {
  const text = avgCost < 100_000 ? `₹${(avgCost / 100_000).toFixed(4)}` : formatINR(Math.round(avgCost / 1000));
  return `${text} per ${unit}`;
}
