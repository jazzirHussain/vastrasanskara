import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import {
  createUserSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  updateUserSchema,
} from '@vs/shared/schemas/users.js';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { AppError, notFound } from '../../core/errors.js';
import { validate } from '../../core/validate.js';
import { confirmPasswordReset, requestPasswordReset } from './passwordReset.js';
import { createUser, listUsers, toUserJson, updateUser } from './service.js';

export function usersRouter(config) {
  const router = Router();
  router.use(requirePermission('users.manage'));

  router.get('/', async (req, res) => {
    res.json({ items: (await listUsers(req.user.branchId)).map(toUserJson) });
  });

  router.post('/', validate({ body: createUserSchema }), async (req, res) => {
    const user = await createUser(req.user.branchId, req.body, actorFrom(req), config);
    res.status(201).json(toUserJson(user));
  });

  router.patch('/:id', validate({ body: updateUserSchema }), async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw notFound();
    res.json(toUserJson(await updateUser(req.user.branchId, req.params.id, req.body, actorFrom(req))));
  });

  return router;
}

/** Public: request a reset link and set a new password with it. */
export function passwordResetRouter(config) {
  const router = Router();
  // Same per-IP budget as login, so the request endpoint cannot be used to flood inboxes.
  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: config.loginRateLimit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (req, res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many attempts; try again later')),
    }),
  );

  router.post('/request', validate({ body: passwordResetRequestSchema }), async (req, res) => {
    await requestPasswordReset(req.body.email, config);
    res.status(204).end();
  });

  router.post('/confirm', validate({ body: passwordResetConfirmSchema }), async (req, res) => {
    await confirmPasswordReset(req.body, actorFrom(req));
    res.status(204).end();
  });

  return router;
}
