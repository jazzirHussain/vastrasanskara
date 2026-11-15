// The money belt: a response for a user without money.view holds no money key at any depth.
import { MONEY_KEYS } from '@vs/shared/dashboard.js';

const MONEY = new Set(MONEY_KEYS);

/** A copy of `value` with every MONEY_KEYS key removed, at any depth. */
export function stripMoney(value) {
  if (Array.isArray(value)) return value.map(stripMoney);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !MONEY.has(k)).map(([k, v]) => [k, stripMoney(v)]));
  }
  return value;
}
