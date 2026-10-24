import { Router } from 'express';
import { isDbUp } from '../../core/db.js';
import { getWorkerStatus } from '../../core/jobs/service.js';

export const healthRouter = Router();

// 200 only when the database answers and the worker's heartbeat is fresh.
healthRouter.get('/', async (req, res) => {
  const dbUp = await isDbUp();
  const worker = dbUp ? await getWorkerStatus() : 'stale';
  const healthy = dbUp && worker === 'ok';
  res.status(healthy ? 200 : 503).json({ db: dbUp ? 'ok' : 'down', worker });
});
