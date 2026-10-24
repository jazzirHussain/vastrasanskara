import { z } from 'zod';
import { branchPatchSchema } from '@vs/shared/schemas/branch.js';
import { email, password } from '@vs/shared/schemas/common.js';
import { recordAudit } from '../../core/audit/service.js';
import { hashPassword } from '../../core/auth/passwords.js';
import { withTransaction } from '../../core/db.js';
import { listEvents } from '../../core/notify/catalog.js';
import { NotificationRule } from '../../core/notify/models.js';
import { Branch } from '../branches/model.js';
import { assertStateMatchesGstin } from '../branches/service.js';
import { getSettings } from '../settings/service.js';
import { User } from '../users/model.js';

const branchInput = branchPatchSchema.required({ name: true, legalName: true, stateCode: true });
const adminInput = z.strictObject({ name: z.string().trim().min(1).max(100), email, password });

function parse(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${label}.${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid bootstrap input: ${problems.join('; ')}`);
  }
  return result.data;
}

/**
 * First-time setup on an empty database: creates the branch, its default settings and
 * notification rules, and the first admin, in one transaction. Refuses to run twice.
 */
export async function bootstrap({ branch, admin }) {
  const branchData = parse(branchInput, branch, 'branch');
  const adminData = parse(adminInput, admin, 'admin');
  try {
    assertStateMatchesGstin(branchData);
  } catch (err) {
    throw new Error(`Invalid bootstrap input: ${err.message} (GSTIN ${branchData.gstin})`);
  }
  const passwordHash = await hashPassword(adminData.password);

  return withTransaction(async (session) => {
    if (await Branch.exists({}).session(session)) throw new Error('Already bootstrapped');
    const [created] = await Branch.create([branchData], { session });
    const branchId = created._id;

    await getSettings(branchId, session);
    await NotificationRule.insertMany(
      listEvents().map(({ name, recipients, channels, fallback }) => ({
        branchId,
        event: name,
        recipients,
        channels,
        fallback,
        enabled: true,
      })),
      { session },
    );
    const [user] = await User.create(
      [{ branchId, name: adminData.name, email: adminData.email, passwordHash, roles: ['admin'] }],
      { session },
    );
    await recordAudit(
      { branchId, entityType: 'branch', entityId: branchId, action: 'bootstrap', changes: [], actor: {} },
      session,
    );
    return { branchId: String(branchId), adminId: String(user._id) };
  });
}
