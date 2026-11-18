import { Router } from 'express';
import { z } from 'zod';
import { permissionsFor } from '@vs/shared/permissions.js';
import { email } from '@vs/shared/schemas/common.js';
import { clock } from '../../clock.js';
import { validate } from '../../core/validate.js';
import { actorFrom, requireAuth } from '../../core/auth/middleware.js';
import { authRateLimiter } from '../../core/auth/rateLimit.js';
import { authenticate } from './service.js';

// Login checks the password only; length rules apply when a password is set (Task 17).
const loginBody = z.strictObject({ email, password: z.string().min(1).max(200) });

function toMe(user) {
  return {
    id: String(user._id ?? user.id),
    name: user.name,
    email: user.email,
    roles: user.roles,
    permissions: [...permissionsFor(user.roles)].sort(),
    branchId: String(user.branchId),
  };
}

const callback = (fn) => new Promise((resolve, reject) => fn((err) => (err ? reject(err) : resolve())));

export function authRouter(config) {
  const router = Router();

  const loginLimiter = authRateLimiter(config, 'Too many login attempts; try again later');

  router.post('/login', loginLimiter, validate({ body: loginBody }), async (req, res) => {
    const user = await authenticate(req.body, actorFrom(req));
    // New session id on login prevents session fixation.
    await callback((cb) => req.session.regenerate(cb));
    req.session.userId = String(user._id);
    req.session.createdAt = clock.now().getTime();
    res.json({ user: toMe(user) });
  });

  router.post('/logout', async (req, res) => {
    if (req.session) await callback((cb) => req.session.destroy(cb));
    // Same flags as the session cookie, so browsers (and the __Host- prefix rules) accept the removal.
    res.clearCookie(config.cookie.name, { path: '/', httpOnly: true, secure: config.cookie.secure, sameSite: 'strict' });
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json(toMe(req.user));
  });

  return router;
}
