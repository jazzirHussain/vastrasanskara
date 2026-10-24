// First-time setup from the command line. Run once on a new database:
//   node apps/api/src/cli/bootstrap.js   (reads BOOTSTRAP_* variables, see README)
import { loadConfig } from '../config.js';
import { connectDb, disconnectDb } from '../core/db.js';
import { bootstrap } from '../modules/setup/service.js';

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
