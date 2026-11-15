// A small in-process cache for dashboard figures: one minute per key, at most 500 keys (oldest
// evicted). Concurrent callers share one promise; a rejection is never kept.
import { clock } from '../../clock.js';

const MAX_ENTRIES = 500;
const entries = new Map();

/** fn()'s promise, reused for `ttlMs` unless `fresh`. */
export function cached(key, fn, { ttlMs = 60_000, fresh = false } = {}) {
  const now = clock.now().getTime();
  const hit = entries.get(key);
  if (!fresh && hit && now - hit.at < ttlMs) return hit.promise;
  const promise = Promise.resolve().then(fn);
  entries.delete(key);
  entries.set(key, { at: now, promise });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  promise.catch(() => {
    if (entries.get(key)?.promise === promise) entries.delete(key);
  });
  return promise;
}

/** Forgets every cached figure (tests). */
export function clearDashboardCache() {
  entries.clear();
}
