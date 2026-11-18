// Numbered, forward-only, additive data migrations: { id: '001-…', up(db) } in order.
// Each `up` must be safe to run twice (it is recorded only after it succeeds).
import receivablesIndex from './001-billing-receivables-index.js';

export const MIGRATIONS = [receivablesIndex];
