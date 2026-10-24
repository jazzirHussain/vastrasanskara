import { Router } from 'express';
import { isDbUp } from '../../core/db.js';

export const healthRouter = Router();

healthRouter.get('/', async (req, res) => {
  const up = await isDbUp();
  res.status(up ? 200 : 503).json({ db: up ? 'ok' : 'down' });
});
