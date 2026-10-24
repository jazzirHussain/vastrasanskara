import { clock } from '../../clock.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { recordAudit } from '../../core/audit/service.js';
import { hashPassword, verifyPassword } from '../../core/auth/passwords.js';
import { User } from '../users/model.js';

export const MAX_FAILED_LOGINS = 10;
export const LOCKOUT_MS = 15 * 60 * 1000;

// Verified against when the email is unknown, so response time does not reveal which emails exist.
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword('not-a-real-password'));

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
const accountLocked = () =>
  new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts; try again in 15 minutes');

function auditLogin(user, action, reason, actor, session) {
  return recordAudit(
    {
      branchId: user.branchId,
      entityType: 'user',
      entityId: user._id,
      action,
      changes: reason ? [{ path: 'reason', before: null, after: reason }] : [],
      actor,
    },
    session,
  );
}

/**
 * Checks credentials with lockout: 10 consecutive failures lock the account for 15 minutes.
 * Every attempt on an existing account is audited. Returns the user on success.
 */
export async function authenticate({ email, password }, actor) {
  const user = await User.findOne({ email }).select('+passwordHash').lean();
  if (!user) {
    await verifyPassword(await getDummyHash(), password);
    throw invalidCredentials();
  }

  const now = clock.now();
  const failActor = { ...actor, userId: null };

  if (user.lockedUntil && user.lockedUntil > now) {
    await withTransaction((s) => auditLogin(user, 'login_failed', 'locked', failActor, s));
    throw accountLocked();
  }

  const passwordOk = await verifyPassword(user.passwordHash, password);

  if (!user.active) {
    await withTransaction((s) => auditLogin(user, 'login_failed', 'inactive', failActor, s));
    throw invalidCredentials();
  }

  if (!passwordOk) {
    await withTransaction(async (s) => {
      const updated = await User.findOneAndUpdate(
        { _id: user._id },
        { $inc: { failedLoginCount: 1 } },
        { new: true, session: s },
      );
      if (updated.failedLoginCount >= MAX_FAILED_LOGINS) {
        await User.updateOne(
          { _id: user._id },
          { $set: { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) } },
          { session: s },
        );
      }
      await auditLogin(user, 'login_failed', 'wrong_password', failActor, s);
    });
    throw invalidCredentials();
  }

  await withTransaction(async (s) => {
    await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0, lockedUntil: null } }, { session: s });
    await auditLogin(user, 'login', null, { ...actor, userId: String(user._id) }, s);
  });
  return user;
}
