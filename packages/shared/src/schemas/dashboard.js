import { z } from 'zod';
import { CUSTOMER_TYPES } from './customers.js';
import { objectId, ymd } from './common.js';
import { PRESETS } from '../dashboard.js';

const shape = {
  preset: z.enum(PRESETS).default('month'),
  from: ymd.optional(),
  to: ymd.optional(),
  designerId: objectId.optional(),
  priority: z.enum(['normal', 'rush']).optional(),
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  fresh: z.literal('1').optional(),
};

// A custom preset needs both dates, in order; any other preset takes none.
function checkRange(q, ctx) {
  if (q.preset === 'custom') {
    if (!q.from || !q.to) ctx.addIssue({ code: 'custom', path: ['from'], message: 'Choose a start and end date' });
    else if (q.from > q.to) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end date comes before the start' });
  } else if (q.from || q.to) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: 'Dates only apply to a custom range' });
  }
}

/** What the dashboard is asked for: a date preset (or a custom range) and three filters. */
export const dashboardQuery = z.strictObject(shape).superRefine(checkRange);

/** The records behind one dashboard number, a page at a time. */
export const metricRowsQuery = z
  .strictObject({
    ...shape,
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .superRefine(checkRange);
