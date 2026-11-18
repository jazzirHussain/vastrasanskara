import { Router } from 'express';
import { dashboardQuery, metricRowsQuery } from '@vs/shared';
import { requireAuth } from '../../core/auth/middleware.js';
import { validate } from '../../core/validate.js';
import { dashboardFor, metricRows } from './service.js';

/** Home: any signed-in user; each tile is shown only with its permissions. */
export function dashboardRouter() {
  const router = Router();
  router.get('/', requireAuth, validate({ query: dashboardQuery }), async (req, res) => {
    res.json(await dashboardFor(req.user, req.validatedQuery));
  });
  // The records behind one number (same filters as the figure); unpermitted metrics are 404.
  router.get('/metrics/:metric/rows', requireAuth, validate({ query: metricRowsQuery }), async (req, res) => {
    res.json(await metricRows(req.user, req.params.metric, req.validatedQuery));
  });
  return router;
}
