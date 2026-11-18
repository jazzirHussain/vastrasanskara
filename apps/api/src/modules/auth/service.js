import { clock } from '../../clock.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { recordAudit } from '../../core/audit/service.js';
import { verifyPassword } from '../../core/auth/passwords.js';
import { User } from '../users/model.js';
import { LoginFailure } from './model.js';

export const MAX_FAILED_LOGINS = 10;
export const LOCKOUT_MS = 15 * 60 * 1000;
const FAILURE_MEMORY_MS = 24 * 60 * 60 * 1000;

// Verified against when the email is unknown, so response time does not reveal which emails exist.
// Fixed (same argon2 parameters as real hashes), so even the first unknown email costs no extra hashing.
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$zhpWXG9q575fIgF8AS+ytQ$Jksbc/ZRkjPQYhVSdR5v3XfjOg0g+Dcglm4xLKN3U7g';

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
 * An email with no account answers exactly as an account would: the same password check time,
 * the same count of failures and the same 15-minute lock after 10 of them.
 */
async function failUnknownEmail(email, password, now) {
  const record = await LoginFailure.findOne({ email }).lean();
  if (record?.lockedUntil && record.lockedUntil > now) throw accountLocked();
  await verifyPassword(DUMMY_HASH, password);
  const expiresAt = new Date(now.getTime() + FAILURE_MEMORY_MS);
  const updated = await LoginFailure.findOneAndUpdate(
    { email },
    { $inc: { failedLoginCount: 1 }, $set: { expiresAt } },
    { upsert: true, new: true },
  );
  if (updated.failedLoginCount >= MAX_FAILED_LOGINS) {
    await LoginFailure.updateOne({ email }, { $set: { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) } });
  }
  throw invalidCredentials();
}

/**
 * Checks credentials with lockout: 10 consecutive failures lock the account for 15 minutes.
 * Every attempt on an existing account is audited. Returns the user on success.
 */
export async function authenticate({ email, password }, actor) {
  const user = await User.findOne({ email }).select('+passwordHash').lean();
  const now = clock.now();
  if (!user) return failUnknownEmail(email.toLowerCase(), password, now);

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
