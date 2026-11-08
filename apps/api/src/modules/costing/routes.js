import { Router } from 'express';
import { requirePermission } from '../../core/auth/middleware.js';
import { toOrderCostsJson } from './json.js';
import { garmentCosts } from './service.js';

/** Costs and profit: admin only (costing.view). */
export function costingRouter() {
  const router = Router();

  router.get('/orders/:id', requirePermission('costing.view'), async (req, res) => {
    res.json(toOrderCostsJson(await garmentCosts(req.user.branchId, req.params.id)));
  });

  return router;
}
