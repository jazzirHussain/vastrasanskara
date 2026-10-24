import { randomUUID } from 'node:crypto';
import express from 'express';
import { errorHandler, notFound } from './core/errors.js';
import { healthRouter } from './modules/health/routes.js';

/** Builds the Express app. `mount(app)` adds routers before the 404 handler. */
export function createApp({ config, storage, mount } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.locals.config = config;
  app.locals.storage = storage;

  app.use((req, res, next) => {
    req.id = randomUUID();
    res.set('X-Request-Id', req.id);
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.use('/v1/health', healthRouter);

  mount?.(app);

  app.use((req, res, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}
