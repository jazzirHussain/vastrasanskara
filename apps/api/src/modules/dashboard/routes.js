import { Router } from 'express';
import { dashboardQuery } from '@vs/shared';
import { requireAuth } from '../../core/auth/middleware.js';
import { validate } from '../../core/validate.js';
import { dashboardFor } from './service.js';

/** Home: any signed-in user; each tile is shown only with its permissions. */
export function dashboardRouter() {
  const router = Router();
  router.get('/', requireAuth, validate({ query: dashboardQuery }), async (req, res) => {
    res.json(await dashboardFor(req.user, req.validatedQuery));
  });
  return router;
}
