// The metric registry. A def is { id, figure(ctx) → figure, rows(ctx, { cursor, limit, key }) → { items, nextCursor } }.
// Figures carry `count` (a number of things) or `amount` (paise), never `value`.
import { METRICS, requiredPermissions } from '@vs/shared/dashboard.js';
import { validationError } from '../../../core/errors.js';

const defs = new Map();

export function registerMetric(def) {
  if (!METRICS[def.id]) throw new RangeError(`Unknown metric: ${def.id}`);
  if (typeof def.figure !== 'function' || typeof def.rows !== 'function') throw new TypeError(`Metric ${def.id} needs figure and rows`);
  defs.set(def.id, def);
  return def;
}

/** The registered def of a metric (or undefined). */
export const metricDef = (id) => defs.get(id);

/** Every registered metric the user may see (its permission, and money.view for money figures). */
export function metricsFor(user) {
  return [...defs.values()].filter((d) => requiredPermissions(d.id).every((p) => user.permissions.has(p)));
}

const MAX_LIMIT = 100;
const encode = (offset) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
function decode(cursor) {
  try {
    const { o } = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (Number.isSafeInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw validationError([{ path: 'cursor', message: 'Invalid cursor' }]);
}

/** One page of an in-memory list (rows of figures computed from one read). */
export function pageArray(items, { cursor, limit } = {}) {
  const size = Math.min(Math.max(1, Number(limit) || 25), MAX_LIMIT);
  const start = cursor ? decode(cursor) : 0;
  const page = items.slice(start, start + size);
  return { items: page, nextCursor: start + size < items.length ? encode(start + size) : null };
}
