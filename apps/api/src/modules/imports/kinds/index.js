// Kind adapters: how the rows of one kind are looked up and added, always through the owning
// module's service. Each adapter registers itself; `runner.js` imports them all.
const adapters = new Map();

/**
 * `context(branchId, run) → ctx` (choices for parseRow, lookups), `check({ data, key, rowNo }, ctx)
 * → { status: 'ready'|'exists'|'error', label, errors? }`, `commit(rows, ctx, actor) →
 * { status: 'added'|'skipped', entityId }` (rows = the one row, or every row of a group),
 * and optionally `group(data) → groupKey` for kinds whose rows add one record together.
 */
export function registerImportKind(kind, adapter) {
  adapters.set(kind, { kind, ...adapter });
}

export function getKindAdapter(kind) {
  const adapter = adapters.get(kind);
  if (!adapter) throw new Error(`No import adapter for ${kind}`);
  return adapter;
}
