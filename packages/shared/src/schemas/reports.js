import { z } from 'zod';
import { objectId, ymd } from './common.js';
import { istDate } from '../fy.js';
import { daysBetween } from '../billing.js';
import { REPORTS, reportByKind } from '../reports/catalog.js';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

const params = z.strictObject({
  month: month.optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  customerId: objectId.optional(),
});

const MAX_RANGE_DAYS = 366;

/** A request for one report file. Parameters and format must suit the kind. */
export const reportRequestSchema = z
  .strictObject({
    kind: z.enum(REPORTS.map((r) => r.kind)),
    format: z.enum(['xlsx', 'csv', 'pdf']),
    params,
  })
  .superRefine(({ kind, format, params: p }, ctx) => {
    const def = reportByKind(kind);
    const bad = (path, message) => ctx.addIssue({ code: 'custom', path: ['params', ...path], message });
    if (!def.formats.includes(format)) ctx.addIssue({ code: 'custom', path: ['format'], message: 'This report is not offered in that format' });

    const wants = { month: ['month'], range: ['from', 'to'], customer: ['customerId', 'from', 'to'], none: [] }[def.params];
    for (const key of wants) if (!p[key]) bad([key], key === 'customerId' ? 'Choose a customer' : 'This is needed');
    for (const key of Object.keys(p)) if (!wants.includes(key)) bad([key], 'This report does not take that');

    if (p.month && wants.includes('month') && p.month > istDate(new Date()).slice(0, 7)) bad(['month'], 'Choose a month that has started');
    if (p.from && p.to && wants.includes('from')) {
      if (p.from > p.to) bad(['to'], 'The end date comes before the start');
      else if (daysBetween(p.from, p.to) > MAX_RANGE_DAYS) bad(['to'], 'Choose a period of one year or less');
    }
  });

export const reportListQuery = z.strictObject({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
