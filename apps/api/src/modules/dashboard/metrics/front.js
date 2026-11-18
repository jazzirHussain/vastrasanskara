// Front office tiles: today's calendar by designer and enquiries by source with conversion.
import { appointmentsForDay } from '../../appointments/service.js';
import { enquiryConversionBySource, listEnquiries } from '../../enquiries/service.js';
import { pageArray, registerMetric } from './index.js';

// The same read (and memo key) as "Fittings today".
const dayOf = (ctx) => ctx.memo('day', () => appointmentsForDay(ctx.branchId, ctx.user, { date: ctx.today, designerId: ctx.designerId }));

registerMetric({
  id: 'appointments_today',
  async figure(ctx) {
    const day = await dayOf(ctx);
    const breakdown = day.designers.map((d) => ({ key: d.id, label: d.name ?? '', count: d.appointments.length }));
    return { count: breakdown.reduce((n, d) => n + d.count, 0), breakdown };
  },
  async rows(ctx, { key, ...page } = {}) {
    const day = await dayOf(ctx);
    const cards = day.designers
      .filter((d) => !key || d.id === key)
      .flatMap((d) => d.appointments)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    return pageArray(
      cards.map((a) => ({
        id: a.id,
        title: a.customer?.name ?? a.enquiry?.name ?? '',
        subtitle: `${a.time} · ${a.type} · ${a.designer?.name ?? ''}`,
        date: a.date,
        badge: a.status,
        link: `/appointments?date=${a.date}`,
      })),
      page,
    );
  },
});

export const SOURCE_LABELS = {
  instagram: 'Instagram',
  referral: 'Referral',
  walk_in: 'Walk-in',
  website: 'Website',
  film_industry: 'Film industry',
  other: 'Other',
};

registerMetric({
  id: 'enquiry_sources',
  async figure(ctx) {
    const rows = await enquiryConversionBySource(ctx.branchId, ctx.range);
    const count = rows.reduce((n, r) => n + r.total, 0);
    const converted = rows.reduce((n, r) => n + r.converted, 0);
    return {
      count,
      converted,
      conversionRate: count ? Math.round((converted * 10000) / count) : null,
      breakdown: rows
        .map((r) => ({ key: r.source, label: SOURCE_LABELS[r.source] ?? r.source, count: r.total, converted: r.converted }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    };
  },
  async rows(ctx, { key, cursor, limit } = {}) {
    const page = await listEnquiries(ctx.branchId, { view: 'all', source: key, ...ctx.range, cursor, limit }, { today: ctx.today });
    return {
      items: page.items.map((e) => ({
        id: String(e._id),
        title: e.name,
        subtitle: SOURCE_LABELS[e.source] ?? e.source,
        date: e.enquiryDate,
        badge: e.status,
        link: `/enquiries/${e._id}`,
      })),
      nextCursor: page.nextCursor,
    };
  },
});
