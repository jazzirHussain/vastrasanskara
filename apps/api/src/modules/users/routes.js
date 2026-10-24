import { Router } from 'express';
import mongoose from 'mongoose';
import {
  createUserSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  updateUserSchema,
} from '@vs/shared/schemas/users.js';
import { actorFrom, requireAnyPermission, requirePermission } from '../../core/auth/middleware.js';
import { authRateLimiter } from '../../core/auth/rateLimit.js';
import { notFound } from '../../core/errors.js';
import { validate } from '../../core/validate.js';
import { confirmPasswordReset, requestPasswordReset } from './passwordReset.js';
import { createUser, listDesigners, listUsers, updateUser } from './service.js';

function toUserJson(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    roles: [...user.roles],
    active: user.active,
    createdAt: user.createdAt,
  };
}

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
  router.use(authRateLimiter(config));

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

/** Designers to assign orders to (operations staff cannot list users). */
export function designersRouter() {
  const router = Router();
  router.get('/', requireAnyPermission('orders.write', 'orders.read.all'), async (req, res) => {
    res.json({ items: await listDesigners(req.user.branchId) });
  });
  return router;
}
