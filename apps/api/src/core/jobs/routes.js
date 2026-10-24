import { Router } from 'express';
import { requirePermission } from '../auth/middleware.js';
import { listJobFailures } from './service.js';

const toFailureJson = (f) => ({ id: String(f._id), job: f.job, error: f.error, attempt: f.attempt, at: f.at });

/** Background job monitoring for admins. */
export function jobsAdminRouter() {
  const router = Router();
  router.use(requirePermission('system.monitor'));

  router.get('/failures', async (req, res) => {
    res.json({ items: (await listJobFailures()).map(toFailureJson) });
  });

  return router;
}
