import { http, HttpResponse } from 'msw';
import { server } from './server.js';

const stages = (overrides = {}) =>
  ['materials_ready', 'pattern_making', 'handwork', 'quality_check'].map((key, i) => ({
    key, label: ['Materials ready', 'Pattern making', 'Handwork', 'Quality check'][i], inHouse: 0, withVendor: 0, late: 0, count: 0, ...overrides[key],
  }));

/** GET /v1/dashboard as an admin sees it; `tiles` entries replace whole tiles. */
export function dashboardFixture({ tiles = {}, ...rest } = {}) {
  return {
    asOf: new Date().toISOString(),
    range: { from: '2026-11-01', to: '2026-11-15' },
    previous: { from: '2026-10-01', to: '2026-10-15' },
    filters: { preset: 'month' },
    tiles: {
      attention: {
        metrics: {
          late_garments: { count: 3, truncated: false },
          pickups_at_risk: { count: 0, truncated: false },
          vendor_overdue: { count: 1, truncated: false },
          qc_failed: { count: 0, truncated: false },
          fittings_today: { count: 2 },
          overdue_bills: { count: 2, amount: 4800000 },
          low_stock: { count: 0, truncated: false },
          follow_ups_due: { count: 1, overdue: 0 },
          on_hold_orders: { count: 0 },
        },
        notFilteredBy: [],
      },
      key_numbers: {
        metrics: {
          active_orders: { count: 12 },
          orders_placed: { count: 7, rush: 1, change: { previous: 4, diff: 3, direction: 'up' } },
          billed: { amount: 5240000, count: 9, credited: 120000, change: { previous: 4000000, diff: 1240000, direction: 'up' } },
          collected: { amount: 3000000, count: 6, refunded: 0, change: { previous: 3000000, diff: 0, direction: 'same' } },
          outstanding: { amount: 2240000, count: 5 },
          overdue_amount: { amount: 4800000, count: 2 },
          advances_held: { amount: 500000, count: 2 },
          on_time: { count: 10, onTime: 8, rate: 8000, truncated: false, change: null },
        },
        notFilteredBy: [],
      },
      production: {
        metrics: { stage_garments: { count: 6, truncated: false, breakdown: stages({ handwork: { inHouse: 3, withVendor: 1, count: 4 }, quality_check: { inHouse: 2, count: 2 } }) } },
        notFilteredBy: [],
      },
      pickups: {
        metrics: {
          upcoming_pickups: {
            count: 1,
            truncated: false,
            next: [{ orderId: 'o1', orderNo: 'VS/ORD/2627/0007', customerName: 'Asha Rao', pickupDate: '2026-11-17', garments: 2, ready: 1, payment: { status: 'part_paid', balance: 50000 } }],
          },
        },
        notFilteredBy: [],
      },
      money: {
        metrics: {
          month_money: {
            amount: 9000000,
            breakdown: [
              { key: '2026-10', label: 'Oct 2026', billed: 4000000, collected: 3500000 },
              { key: '2026-11', label: 'Nov 2026', billed: 5000000, collected: 3000000 },
            ],
          },
          receivables_ageing: {
            amount: 2240000,
            count: 5,
            breakdown: [
              { key: 'not_due', label: 'Not due yet', amount: 1000000 },
              { key: 'd0_30', label: '1–30 days late', amount: 1240000 },
              { key: 'd31_60', label: '31–60 days late', amount: 0 },
              { key: 'd61_90', label: '61–90 days late', amount: 0 },
              { key: 'd90_plus', label: 'Over 90 days late', amount: 0 },
            ],
            top: [{ id: 'c1', name: 'Asha Rao', balance: 1240000, oldestDays: 12 }],
          },
        },
        notFilteredBy: [],
      },
      calendar: {
        metrics: { appointments_today: { count: 2, breakdown: [{ key: 'des1', label: 'Meera', count: 2 }, { key: 'des2', label: 'Nila', count: 0 }] } },
        notFilteredBy: [],
      },
      ...tiles,
    },
    ...rest,
  };
}

/** What a designer gets: their own order and production tiles, no money anywhere. */
export function designerDashboard() {
  const admin = dashboardFixture();
  const { overdue_bills: _o, low_stock: _l, follow_ups_due: _f, ...attention } = admin.tiles.attention.metrics;
  return {
    ...admin,
    tiles: {
      attention: { metrics: attention, notFilteredBy: [] },
      key_numbers: {
        metrics: { active_orders: { count: 4 }, orders_placed: { count: 2, rush: 0, change: null }, on_time: { count: 3, onTime: 3, rate: 10000, truncated: false, change: null } },
        notFilteredBy: [],
      },
      production: admin.tiles.production,
      pickups: { metrics: { upcoming_pickups: { count: 1, truncated: false, next: [{ ...admin.tiles.pickups.metrics.upcoming_pickups.next[0], payment: undefined }] } }, notFilteredBy: [] },
      calendar: { metrics: { appointments_today: { count: 1, breakdown: [{ key: 'des1', label: 'Meera', count: 1 }] } }, notFilteredBy: [] },
    },
  };
}

/** Serves `body` (or body(params)) for GET /v1/dashboard and records each query. */
export function dashboardIs(body = dashboardFixture()) {
  const queries = [];
  server.use(
    http.get('/v1/dashboard', ({ request }) => {
      const params = Object.fromEntries(new URL(request.url).searchParams);
      queries.push(params);
      return HttpResponse.json(typeof body === 'function' ? body(params) : body);
    }),
  );
  return queries;
}
