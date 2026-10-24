import { canonicalJson, normalize } from './canonical.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function walk(before, after, prefix, out) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const b = before[key] ?? null;
    const a = after[key] ?? null;
    if (isPlainObject(b) && isPlainObject(a)) {
      walk(b, a, path, out);
    } else if (canonicalJson(b) !== canonicalJson(a)) {
      out.push({ path, before: b, after: a });
    }
  }
}

/**
 * Field-level changes between two objects as dotted paths, sorted by path.
 * Nested plain objects are recursed; arrays are compared as whole values;
 * a missing side is null.
 */
export function diff(before, after) {
  const b = normalize(before ?? {});
  const a = normalize(after ?? {});
  const out = [];
  walk(isPlainObject(b) ? b : {}, isPlainObject(a) ? a : {}, '', out);
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}
