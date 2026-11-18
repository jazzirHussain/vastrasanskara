// First-time setup from the command line. Run once on a new database:
//   node apps/api/src/cli/bootstrap.js   (reads BOOTSTRAP_* variables, see README)
// Leave BOOTSTRAP_ADMIN_PASSWORD empty to type the password instead (it is then never stored
// in a file or the shell history).
import { createInterface } from 'node:readline';
import { isMain } from './isMain.js';

/** The admin password from standard input: a hidden prompt on a terminal, else the first line. */
export function readPassword({ stdin = process.stdin, stdout = process.stdout, isTTY = Boolean(process.stdin.isTTY) } = {}) {
  return new Promise((resolve) => {
    if (!isTTY) {
      const lines = createInterface({ input: stdin });
      let answered = false;
      const finish = (line) => {
        if (answered) return;
        answered = true;
        lines.close();
        resolve(String(line ?? '').replace(/\r$/, ''));
      };
      lines.once('line', finish);
      lines.once('close', () => finish(''));
      return;
    }
    stdout.write('Admin password (10+ characters): ');
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

export function inputFromEnv(env) {
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
      name: env.BOOTSTRAP_ADMIN_NAME || undefined,
      email: env.BOOTSTRAP_ADMIN_EMAIL || undefined,
      password: env.BOOTSTRAP_ADMIN_PASSWORD || undefined,
    },
  };
}

if (isMain(import.meta.url)) {
  const { loadConfig } = await import('../config.js');
  const { assertDatabaseReady, connectDb, disconnectDb } = await import('../core/db.js');
  const { bootstrap } = await import('../modules/setup/service.js');
  const config = loadConfig();
  const input = inputFromEnv(process.env);
  if (!input.admin.password) input.admin.password = await readPassword();
  await connectDb(config.mongoUri, { dnsServers: config.dnsServers });
  try {
    await assertDatabaseReady();
    const { branchId, adminId } = await bootstrap(input);
    console.log(`Bootstrapped branch ${branchId} with admin ${adminId}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await disconnectDb();
  }
}
