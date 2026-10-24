import { randomUUID } from 'node:crypto';
import express from 'express';
import { errorHandler, notFound } from './core/errors.js';
import { requireAppHeader, securityMiddleware } from './core/security.js';
import { sessionMiddleware } from './core/auth/sessions.js';
import { loadUser } from './core/auth/middleware.js';
import { healthRouter } from './modules/health/routes.js';
import { authRouter } from './modules/auth/routes.js';

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
  app.use(securityMiddleware(config));
  app.use(express.json({ limit: '1mb' }));

  app.use('/v1/health', healthRouter);
  // Task 15 mounts /v1/webhooks here.

  app.use(sessionMiddleware(config));
  app.use(loadUser);
  app.use(requireAppHeader);

  app.use('/v1/auth', authRouter(config));

  mount?.(app);

  app.use((req, res, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}
