import { createHash, randomBytes } from 'node:crypto';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { revokeUserSessions } from '../../core/auth/sessions.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { emit } from '../../core/notify/emit.js';
import { hashPassword } from '../../core/auth/passwords.js';
import { logger } from '../../logger.js';
import { PasswordReset, User } from './model.js';

const LINKS = {
  reset: { ttlMs: 30 * 60 * 1000, expiresIn: '30 minutes' },
  invite: { ttlMs: 3 * 24 * 60 * 60 * 1000, expiresIn: '3 days' },
};

const sha256 = (token) => createHash('sha256').update(token).digest('hex');
const tokenInvalid = () =>
  new AppError(400, 'RESET_TOKEN_INVALID', 'This link is invalid or has expired; request a new one');

/**
 * Creates a one-time password link for the user and queues the email, inside the caller's
 * transaction. Invites (new users) stay valid for 3 days, resets for 30 minutes.
 */
export async function issuePasswordLink(user, { purpose, appOrigin }, session) {
  const { ttlMs, expiresIn } = LINKS[purpose];
  const token = randomBytes(32).toString('base64url');
  const [link] = await PasswordReset.create(
    [{ userId: user._id, tokenHash: sha256(token), purpose, expiresAt: new Date(clock.now().getTime() + ttlMs) }],
    { session },
  );
  await emit(
    purpose === 'invite' ? 'auth.invite' : 'auth.password_reset',
    {
      branchId: user.branchId,
      refId: String(link._id),
      data: { userId: user._id },
      vars: { name: user.name, resetUrl: `${appOrigin}/reset-password?token=${token}`, expiresIn },
    },
    { session },
  );
}

/** Sends a reset link to an active user. Unknown emails do nothing (the route always says 204). */
export async function requestPasswordReset(email, { appOrigin }) {
  const user = await User.findOne({ email, active: true }).lean();
  if (!user) return;
  await withTransaction((session) => issuePasswordLink(user, { purpose: 'reset', appOrigin }, session));
}

/**
 * requestPasswordReset after the response has gone out, so neither the answer nor its timing
 * shows whether the email has an account. Failures are logged without the address.
 */
export function requestPasswordResetLater(email, options) {
  setImmediate(() => {
    requestPasswordReset(email, options).catch((err) => {
      logger.error({ err: { name: err.name, code: err.code } }, 'password reset request failed');
    });
  });
}

/**
 * Sets a new password from a link: the link is used up, every other open link of the user is
 * cancelled, lockout is cleared, and all the user's sessions are signed out.
 */
export async function confirmPasswordReset({ token, password }, actor) {
  const passwordHash = await hashPassword(password);
  const userId = await withTransaction(async (session) => {
    const now = clock.now();
    const link = await PasswordReset.findOneAndUpdate(
      { tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: now } },
      { $set: { usedAt: now } },
      { new: true, session },
    );
    if (!link) throw tokenInvalid();
    const user = await User.findOne({ _id: link.userId, active: true }).session(session).lean();
    if (!user) throw tokenInvalid();

    await User.updateOne(
      { _id: user._id },
      { $set: { passwordHash, failedLoginCount: 0, lockedUntil: null } },
      { session },
    );
    await PasswordReset.updateMany({ userId: user._id, usedAt: null }, { $set: { usedAt: now } }, { session });
    await recordAudit(
      {
        branchId: user.branchId,
        entityType: 'user',
        entityId: user._id,
        action: 'password_reset',
        changes: [],
        actor: { ...actor, userId: String(user._id) },
      },
      session,
    );
    return user._id;
  });
  await revokeUserSessions(userId);
}
