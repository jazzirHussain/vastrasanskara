import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { recordAudit } from '../../core/audit/service.js';
import { revokeUserSessions } from '../../core/auth/sessions.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, conflict, notFound } from '../../core/errors.js';
import { hashPassword } from '../../core/auth/passwords.js';
import { User } from './model.js';
import { issuePasswordLink } from './passwordReset.js';

const emailTaken = () => conflict('EMAIL_TAKEN', 'A user with this email already exists');

const auditFields = (user) => ({ name: user.name, email: user.email, roles: [...user.roles], active: user.active });
const isActiveAdmin = (u) => u.active && u.roles.includes('admin');

export async function listUsers(branchId) {
  return User.find({ branchId }).sort({ name: 1, _id: 1 }).lean();
}

/** Creates a user with no usable password and emails them an invite link. */
export async function createUser(branchId, { name, email, roles }, actor, { appOrigin }) {
  // Placeholder hash of random bytes: nobody can log in until the invite is used.
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
  try {
    return await withTransaction(async (session) => {
      if (await User.exists({ email }).session(session)) throw emailTaken();
      const [user] = await User.create(
        [{ branchId, name, email, roles, passwordHash, createdBy: actor.userId, updatedBy: actor.userId }],
        { session },
      );
      await recordAudit(
        { branchId, entityType: 'user', entityId: user._id, action: 'create', before: null, after: auditFields(user), actor },
        session,
      );
      await issuePasswordLink(user, { purpose: 'invite', appOrigin }, session);
      return user.toObject();
    });
  } catch (err) {
    if (err?.code === 11000) throw emailTaken();
    throw err;
  }
}

// Bumped by every change that could remove an admin, so two such changes running at once
// conflict and one retries (and recounts) instead of both leaving the branch without admins.
function touchAdminGuard(branchId, session) {
  return mongoose.connection
    .collection('counters')
    .updateOne({ _id: `admin-guard:${branchId}` }, { $inc: { value: 1 } }, { upsert: true, session });
}

/**
 * Updates name, roles or active. A user cannot deactivate themselves, and the branch always
 * keeps one active admin. Changing roles or active signs the user out everywhere.
 */
export async function updateUser(branchId, userId, patch, actor) {
  const { user, signOut } = await withTransaction(async (session) => {
    const user = await User.findOne({ _id: userId, branchId }).session(session);
    if (!user) throw notFound();
    if (patch.active === false && String(user._id) === String(actor.userId)) {
      throw businessRule('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account');
    }

    const before = auditFields(user);
    const after = { ...before, ...patch };
    if (isActiveAdmin(before) && !isActiveAdmin(after)) {
      await touchAdminGuard(branchId, session);
      const otherAdmins = await User.countDocuments({
        branchId,
        _id: { $ne: user._id },
        active: true,
        roles: 'admin',
      }).session(session);
      if (otherAdmins === 0) {
        throw businessRule('LAST_ADMIN', 'The branch needs at least one active admin');
      }
    }

    user.set(patch);
    user.updatedBy = actor.userId;
    await user.save({ session });
    await recordAudit(
      { branchId, entityType: 'user', entityId: user._id, action: 'update', before, after: auditFields(user), actor },
      session,
    );
    const signOut =
      before.active !== user.active || before.roles.join() !== [...user.roles].join();
    return { user: user.toObject(), signOut };
  });
  if (signOut) await revokeUserSessions(user._id);
  return user;
}
