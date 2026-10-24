// First-time setup: creates the branch, its settings and notification rules, and the first
// admin. Run once on a new database:
//   node apps/api/src/cli/bootstrap.js   (reads BOOTSTRAP_* variables, see README)
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { branchPatchSchema } from '@vs/shared/schemas/branch.js';
import { email, password } from '@vs/shared/schemas/common.js';
import { loadConfig } from '../config.js';
import { recordAudit } from '../core/audit/service.js';
import { connectDb, disconnectDb, withTransaction } from '../core/db.js';
import { listEvents } from '../core/notify/catalog.js';
import { NotificationRule } from '../core/notify/models.js';
import { hashPassword } from '../modules/auth/service.js';
import { Branch } from '../modules/branches/model.js';
import { assertStateMatchesGstin } from '../modules/branches/service.js';
import { getSettings } from '../modules/settings/service.js';
import { User } from '../modules/users/model.js';

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

function inputFromEnv(env) {
  const given = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
  return {
    branch: given({
      name: env.BOOTSTRAP_BRANCH_NAME,
      legalName: env.BOOTSTRAP_LEGAL_NAME,
      gstin: env.BOOTSTRAP_GSTIN,
      stateCode: env.BOOTSTRAP_STATE_CODE,
      phone: env.BOOTSTRAP_PHONE,
      email: env.BOOTSTRAP_EMAIL,
      address: given({
        line1: env.BOOTSTRAP_ADDRESS_LINE1,
        line2: env.BOOTSTRAP_ADDRESS_LINE2,
        city: env.BOOTSTRAP_CITY,
        pincode: env.BOOTSTRAP_PINCODE,
      }),
    }),
    admin: {
      name: env.BOOTSTRAP_ADMIN_NAME,
      email: env.BOOTSTRAP_ADMIN_EMAIL,
      password: env.BOOTSTRAP_ADMIN_PASSWORD,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  await connectDb(config.mongoUri);
  try {
    const { branchId, adminId } = await bootstrap(inputFromEnv(process.env));
    console.log(`Bootstrapped branch ${branchId} with admin ${adminId}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await disconnectDb();
  }
}
