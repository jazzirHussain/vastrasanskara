// Stock quantities (integer thousandths of the usage unit) and weighted-average valuation.
// All pure: the web previews exactly what the API stores.
import { mulDivRound } from './money.js';

export const MOVEMENT_TYPES = Object.freeze([
  'opening', 'purchase_in', 'reserve', 'release', 'consume', 'adjust', 'sale',
]);

export class StockError extends Error {
  constructor(message, free) {
    super(message);
    this.name = 'StockError';
    this.code = 'STOCK_INSUFFICIENT';
    this.free = free;
  }
}

const isInt = Number.isSafeInteger;

/** 2500 → '2.5 m'; up to 3 decimals, trailing zeros dropped, Indian digit grouping. */
export function formatQty(milli, unit) {
  if (!isInt(milli)) throw new RangeError(`Invalid quantity: ${milli}`);
  const abs = Math.abs(milli);
  const whole = String(Math.floor(abs / 1000));
  const fraction = String(abs % 1000).padStart(3, '0').replace(/0+$/, '');
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+$)/g, ',')},${lastThree}` : lastThree;
  return `${milli < 0 ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}${unit ? ` ${unit}` : ''}`;
}

/** Purchase-unit milli × factor (usage milli per purchase unit) → usage-unit milli. */
export function toUsage(purchaseMilli, factorMilli) {
  return mulDivRound(purchaseMilli, factorMilli, 1000);
}

function checkBalance(b) {
  for (const k of ['onHand', 'reserved', 'value']) {
    if (!isInt(b?.[k]) || b[k] < 0) throw new RangeError(`Invalid balance ${k}: ${b?.[k]}`);
  }
}

function result(input, next, valueChange) {
  const free = input.onHand - input.reserved;
  if (next.onHand < 0 || next.reserved < 0 || next.onHand - next.reserved < 0 || next.value < 0
    || (next.onHand === 0 && next.value !== 0)) {
    throw new StockError('Not enough free stock', free);
  }
  return { balance: next, valueChange };
}

/**
 * Applies one movement to { onHand, reserved, value } and returns the new balance and the signed
 * change in value. Direction by type:
 *   reserve / release             quantity > 0.
 *   consume / sale                quantity > 0 takes stock out (optionally `fromReserved` of it from
 *                                 the reservation); quantity < 0 puts stock back and needs `cost`.
 *   adjust                        quantity < 0 takes stock out at the average; quantity > 0 adds
 *                                 stock and needs `cost`.
 *   opening / purchase_in         quantity > 0 adds stock and needs `cost`; purchase_in with
 *                                 quantity < 0 undoes a delivery (removes `cost` of value).
 * Throws StockError (code STOCK_INSUFFICIENT, `free` of the input) if anything would go negative.
 */
export function applyMovement(balance, movement) {
  checkBalance(balance);
  const { type, quantity: q, cost, fromReserved = 0 } = movement;
  if (!MOVEMENT_TYPES.includes(type)) throw new RangeError(`Unknown movement type: ${type}`);
  if (!isInt(q) || q === 0) throw new RangeError(`Invalid quantity: ${q}`);
  if (!isInt(fromReserved) || fromReserved < 0) throw new RangeError(`Invalid fromReserved: ${fromReserved}`);
  const { onHand, reserved, value } = balance;

  if (type === 'reserve' || type === 'release') {
    if (q < 0) throw new RangeError(`Invalid quantity: ${q}`);
    return result(balance, { onHand, reserved: reserved + (type === 'reserve' ? q : -q), value }, 0);
  }

  const out = type === 'consume' || type === 'sale' ? q > 0 : type === 'adjust' && q < 0;
  if (out) {
    const n = Math.abs(q);
    const valueChange = n === onHand ? -value : -mulDivRound(value, n, onHand || 1);
    return result(balance, { onHand: onHand - n, reserved: reserved - fromReserved, value: value + valueChange }, valueChange);
  }

  if (fromReserved) throw new RangeError('fromReserved only goes with stock taken out');
  if (!isInt(cost) || cost < 0) throw new RangeError(`A cost is required to put stock in: ${cost}`);
  if (type === 'purchase_in' && q < 0) {
    return result(balance, { onHand: onHand + q, reserved, value: value - cost }, -cost);
  }
  if (type === 'opening' && q < 0) throw new RangeError(`Invalid quantity: ${q}`);
  return result(balance, { onHand: onHand + Math.abs(q), reserved, value: value + cost }, cost);
}

/** Average cost in milli-paise per usage unit (0 when empty). */
export function avgCostOf({ onHand, value }) {
  return onHand > 0 && value > 0 ? mulDivRound(value, 1_000_000, onHand) : 0;
}

/** Paise for qtyMilli of stock at an average in milli-paise per unit. */
export function costAtAverage(avgCost, qtyMilli) {
  return mulDivRound(avgCost, qtyMilli, 1_000_000);
}

/** Paise for qtyMilli units bought at paisePerUnit each. */
export function unitCostToValue(paisePerUnit, qtyMilli) {
  return mulDivRound(paisePerUnit, qtyMilli, 1000);
}

/** Running low: free stock below a reorder level that is set. */
export function isLow({ onHand, reserved, reorderLevel }) {
  return reorderLevel > 0 && onHand - reserved < reorderLevel;
}

/** Whole purchase units (in milli, so 2 packets = 2000) that bring free stock to twice the level; at least one. */
export function suggestedOrder({ onHand, reserved, reorderLevel, factor }) {
  const short = 2 * reorderLevel - (onHand - reserved);
  const units = short > 0 ? Math.ceil(short / factor) : 1;
  return Math.max(1, units) * 1000;
}

/** What putting `qty` back is worth: the garment's own average for the item, at most what it used. */
export function usedReturnCost({ usedQty, usedCost }, qty) {
  if (usedQty <= 0) return 0;
  return mulDivRound(usedCost, Math.min(qty, usedQty), usedQty);
}
