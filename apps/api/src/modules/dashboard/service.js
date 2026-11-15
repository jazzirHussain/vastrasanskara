// The admin dashboard (Home): every tile the user may see, each figure cached for a minute per
// scope, periodic figures compared with the period before. A tile whose figure fails shows as
// unavailable; the others still load.
import { DASHBOARD_TILES, METRICS, changeOf } from '@vs/shared/dashboard.js';
import { istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { logger } from '../../logger.js';
import { cached } from './cache.js';
import { buildContext } from './filters.js';
import { stripMoney } from './json.js';
import { metricsFor } from './metrics/index.js';
import './metrics/attention.js';
import './metrics/keyNumbers.js';
import './metrics/production.js';

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
      if (!METRICS[def.id].periodic) return figure;
      const before = await def.figure(ctx.atRange(ctx.previous));
      const now = primary(figure);
      return { ...figure, change: now === null ? null : changeOf(now, primary(before)) };
    },
    { fresh: ctx.fresh },
  );
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
