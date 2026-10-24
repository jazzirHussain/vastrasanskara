import { permissionsFor } from '@vs/shared/permissions.js';
import { clock } from '../../clock.js';
import { User } from '../../modules/users/model.js';
import { AppError, forbidden, notAuthenticated } from '../errors.js';
import { ABSOLUTE_TIMEOUT_MS } from './sessions.js';

// Deletes the stored session and replaces req.session with an empty one, so a login in the
// same request still has a session to fill. An empty session is never saved.
const resetSession = (req) => new Promise((resolve) => req.session.regenerate(() => resolve()));

/**
 * Sets req.user from the session. An expired session (older than 7 days) or one whose user
 * is gone or inactive is destroyed and flagged; requireAuth then answers 401 SESSION_EXPIRED.
 * Routes that need no login (e.g. login itself) keep working.
 */
export async function loadUser(req, res, next) {
  const userId = req.session?.userId;
  if (!userId) return next();

  const expired = clock.now().getTime() - req.session.createdAt > ABSOLUTE_TIMEOUT_MS;
  const user = expired ? null : await User.findById(userId).lean();
  if (!user || !user.active) {
    await resetSession(req);
    req.sessionExpired = true;
    return next();
  }

  req.user = {
    id: String(user._id),
    branchId: String(user.branchId),
    name: user.name,
    email: user.email,
    roles: user.roles,
    permissions: permissionsFor(user.roles),
  };
  return next();
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.sessionExpired) return next(new AppError(401, 'SESSION_EXPIRED', 'Your session has expired; please sign in again'));
  return next(notAuthenticated());
}

/** Requires a signed-in user holding every listed permission. */
export function requirePermission(...permissions) {
  return (req, res, next) =>
    requireAuth(req, res, (err) => {
      if (err) return next(err);
      if (!permissions.every((p) => req.user.permissions.has(p))) return next(forbidden());
      return next();
    });
}

/** Requires a signed-in user holding at least one of the listed permissions. */
export function requireAnyPermission(...permissions) {
  return (req, res, next) =>
    requireAuth(req, res, (err) => {
      if (err) return next(err);
      if (!permissions.some((p) => req.user.permissions.has(p))) return next(forbidden());
      return next();
    });
}

export function actorFrom(req) {
  return { userId: req.user?.id ?? null, ip: req.ip ?? null, userAgent: req.get('User-Agent') ?? null };
}
