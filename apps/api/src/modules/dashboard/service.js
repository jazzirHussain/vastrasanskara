// The admin dashboard (Home): every tile the user may see, each figure cached for a minute per
// scope, periodic figures compared with the period before. A tile whose figure fails shows as
// unavailable; the others still load.
import { DASHBOARD_TILES, METRICS, changeOf, comparisonRange } from '@vs/shared/dashboard.js';
import { istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { notFound } from '../../core/errors.js';
import { logger } from '../../logger.js';
import { cached } from './cache.js';
import { buildContext } from './filters.js';
import { stripMoney } from './json.js';
import { metricDef, metricsFor } from './metrics/index.js';
import './metrics/attention.js';
import './metrics/keyNumbers.js';
import './metrics/production.js';
import './metrics/money.js';
import './metrics/front.js';
import './metrics/stock.js';
import './metrics/expenses.js';
import './metrics/profit.js';
import { SNAPSHOT_FIELDS, snapshotNear } from './snapshots.js';

const FILTER_KEYS = [
  ['designer', 'designerId'],
  ['priority', 'priority'],
  ['customerType', 'customerType'],
];

/** The number a change is worked out on: a rate, else an amount, else a count. */
const primary = (figure) => (figure.rate !== undefined ? figure.rate : (figure.amount ?? figure.count ?? null));

function figureOf(def, ctx) {
  return cached(
    `${ctx.scopeKey}|${def.id}`,
    async () => {
      const figure = await def.figure(ctx);
      if (!METRICS[def.id].periodic) return withSnapshotChange(def.id, figure, ctx);
      const before = await def.figure(ctx.atRange(ctx.previous));
      const now = primary(figure);
      return { ...figure, change: now === null ? null : changeOf(now, primary(before)) };
    },
    { fresh: ctx.fresh },
  );
}

/** Unfiltered and whole-branch: only then is a point-in-time figure compared with a month ago (Decision 4). */
const wholeBranch = (ctx) => ctx.user.permissions.has('orders.read.all') && !ctx.designerId && !ctx.priority && !ctx.customerType;

/** A point-in-time figure with `change` against the snapshot nearest a month ago, when there is one. */
async function withSnapshotChange(id, figure, ctx) {
  const field = SNAPSHOT_FIELDS[id];
  if (!field || !wholeBranch(ctx)) return figure;
  const monthAgo = comparisonRange({ preset: 'month', from: ctx.today, to: ctx.today }).to;
  const snap = await ctx.memo('snapshot', () => snapshotNear(ctx.branchId, monthAgo));
  if (!snap || snap[field] === undefined) return figure;
  return { ...figure, change: changeOf(primary(figure), snap[field]) };
}

/** { asOf, range, previous, filters, tiles: { [tile]: { metrics, notFilteredBy } | { error: 'UNAVAILABLE' } } }. */
export async function dashboardFor(user, query) {
  const ctx = await buildContext(user, query, { today: istDate(clock.now()) });
  const results = await Promise.all(
    metricsFor(user).map(async (def) => {
      try {
        return { def, figure: await figureOf(def, ctx) };
      } catch (err) {
        logger.error({ err, metric: def.id, branchId: ctx.branchId }, 'dashboard figure failed');
        return { def, failed: true };
      }
    }),
  );
  const active = FILTER_KEYS.filter(([, q]) => query[q]).map(([name]) => name);
  const tiles = {};
  for (const tile of DASHBOARD_TILES) {
    const inTile = results.filter((r) => METRICS[r.def.id].tile === tile);
    if (!inTile.length) continue;
    if (inTile.some((r) => r.failed)) {
      tiles[tile] = { error: 'UNAVAILABLE' };
      continue;
    }
    tiles[tile] = {
      metrics: Object.fromEntries(inTile.map((r) => [r.def.id, r.figure])),
      notFilteredBy: active.filter((f) => inTile.some((r) => !METRICS[r.def.id].filters.includes(f))),
    };
  }
  const body = {
    asOf: clock.now().toISOString(),
    range: ctx.range,
    previous: ctx.previous,
    filters: Object.fromEntries(Object.entries({ preset: ctx.preset, designerId: ctx.designerId, priority: ctx.priority, customerType: ctx.customerType }).filter(([, v]) => v)),
    tiles,
  };
  return ctx.money ? body : stripMoney(body);
}

const COLUMNS = [
  { key: 'title', label: 'Record' },
  { key: 'subtitle', label: 'Details' },
  { key: 'date', label: 'Date' },
];

/**
 * The records behind one dashboard number, a page at a time, with the same filters as the figure:
 * { metric: { id, label, count?, amount? }, items, nextCursor, columns }. An unknown metric, or one
 * the user may not see, is not found (so its existence is not revealed).
 */
export async function metricRows(user, metricId, query) {
  const def = Object.hasOwn(METRICS, metricId) ? metricDef(metricId) : undefined;
  if (!def || !metricsFor(user).includes(def)) throw notFound();
  const ctx = await buildContext(user, query, { today: istDate(clock.now()) });
  const [figure, page] = await Promise.all([figureOf(def, ctx), def.rows(ctx, { cursor: query.cursor, limit: query.limit, key: query.key })]);
  const metric = { id: def.id, label: METRICS[def.id].label };
  // One bar's list is headed by that bar: its count or amount (a month bar's is what was billed) and its name.
  const bar = query.key ? (figure.breakdown ?? []).find((b) => String(b.key) === query.key) : null;
  const head = bar ? { count: bar.count, amount: bar.amount ?? bar.billed } : figure;
  if (head.count !== undefined) metric.count = head.count;
  if (head.amount !== undefined) metric.amount = head.amount;
  if (bar) metric.keyLabel = bar.label;
  const money = ctx.money && METRICS[def.id].money;
  const body = { metric, items: page.items, nextCursor: page.nextCursor, columns: money ? [...COLUMNS, { key: 'amount', label: 'Amount' }] : COLUMNS };
  return ctx.money ? body : stripMoney(body);
}
