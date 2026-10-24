import { randomUUID } from 'node:crypto';
import express from 'express';
import { errorHandler, notFound } from './core/errors.js';
import { requestLogger } from './core/requestLogger.js';
import { logger as defaultLogger } from './logger.js';
import { requireAppHeader, securityMiddleware } from './core/security.js';
import { sessionMiddleware } from './core/auth/sessions.js';
import { loadUser } from './core/auth/middleware.js';
import { createStorage } from './core/files/storage.js';
import { devFilesRouter } from './core/files/devFilesRoutes.js';
import { filesRouter } from './core/files/routes.js';
import { jobsAdminRouter } from './core/jobs/routes.js';
import { adminOutboxRouter, notificationsRouter, webhooksRouter } from './core/notify/routes.js';
import { healthRouter } from './modules/health/routes.js';
import { authRouter } from './modules/auth/routes.js';
import { branchRouter } from './modules/branches/routes.js';
import { customersRouter } from './modules/customers/routes.js';
import { measurementsRouter } from './modules/measurements/routes.js';
import { settingsRouter } from './modules/settings/routes.js';
import { passwordResetRouter, usersRouter } from './modules/users/routes.js';

/** Builds the Express app. `mount(app)` adds routers before the 404 handler. */
export function createApp({ config, storage = createStorage(config), mount, logger = defaultLogger } = {}) {
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
  app.use(requestLogger(logger));
  app.use(securityMiddleware(config));
  // rawBody keeps the exact bytes so webhook adapters can verify provider signatures.
  app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  app.use('/v1/health', healthRouter);
  // Stands in for S3 in development: browsers PUT/GET raw files with signed URLs,
  // so it sits before sessions and the JSON-only app-header check.
  if (config.storage.adapter === 'local') app.use('/v1/dev-files', devFilesRouter(storage));
  // Provider callbacks: no session or app header; each adapter authenticates its provider.
  app.use('/v1/webhooks', webhooksRouter());

  app.use(sessionMiddleware(config));
  app.use(loadUser);
  app.use(requireAppHeader);

  app.use('/v1/auth/password-reset', passwordResetRouter(config));
  app.use('/v1/auth', authRouter(config));
  app.use('/v1/settings', settingsRouter());
  app.use('/v1/branch', branchRouter());
  app.use('/v1/users', usersRouter(config));
  app.use('/v1/customers/:id/measurements', measurementsRouter());
  app.use('/v1/customers', customersRouter());
  app.use('/v1/files', filesRouter(storage));
  app.use('/v1/notifications', notificationsRouter());
  app.use('/v1/admin/outbox', adminOutboxRouter());
  app.use('/v1/admin/jobs', jobsAdminRouter());

  mount?.(app);

  app.use((req, res, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}
