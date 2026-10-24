import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENVS = ['development', 'test', 'production'];
const REQUIRED_IN_PRODUCTION = [
  'MONGO_URI',
  'APP_ORIGIN',
  'API_ORIGIN',
  'SESSION_SECRET',
  'AWS_REGION',
  'FILES_BUCKET',
  'BACKUPS_BUCKET',
  'MAIL_FROM',
];

function oneOf(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`Invalid ${name} "${value}"; expected one of: ${allowed.join(', ')}`);
  }
  return value;
}

/**
 * Builds the app config from environment variables. When reading the real process.env
 * outside tests, the repo-root .env is loaded first; an explicitly passed env is used as-is.
 */
export function loadConfig(env = process.env) {
  if (env === process.env && env.NODE_ENV !== 'test') {
    dotenv.config({ path: path.join(REPO_ROOT, '.env'), processEnv: env, quiet: true });
  }
  const nodeEnv = oneOf('NODE_ENV', env.NODE_ENV ?? 'development', ENVS);
  const production = nodeEnv === 'production';

  if (production) {
    const missing = REQUIRED_IN_PRODUCTION.filter((key) => !env[key]);
    if (missing.length) throw new Error(`Missing required config: ${missing.join(', ')}`);
    if (env.SESSION_SECRET.length < 32) {
      throw new Error('SESSION_SECRET must be at least 32 characters');
    }
  }

  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid PORT "${env.PORT}"`);

  return {
    env: nodeEnv,
    port,
    mongoUri: env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/vastrasanskara',
    appOrigin: env.APP_ORIGIN ?? 'http://localhost:5173',
    apiOrigin: env.API_ORIGIN ?? 'http://localhost:4000',
    sessionSecret: env.SESSION_SECRET ?? 'dev-only-session-secret-not-for-production',
    cookie: { name: production ? '__Host-sid' : 'sid', secure: production },
    aws: {
      region: env.AWS_REGION ?? 'ap-south-1',
      filesBucket: env.FILES_BUCKET ?? 'vs-files-dev',
      backupsBucket: env.BACKUPS_BUCKET ?? 'vs-backups-dev',
    },
    mail: {
      adapter: oneOf('MAIL_ADAPTER', env.MAIL_ADAPTER ?? (production ? 'ses' : 'file'), [
        'ses',
        'file',
      ]),
      from: env.MAIL_FROM ?? 'Vastrasanskara <no-reply@localhost>',
      fileDir: path.resolve(REPO_ROOT, env.MAIL_FILE_DIR ?? '.dev-files/mail'),
    },
    storage: {
      adapter: oneOf('STORAGE_ADAPTER', env.STORAGE_ADAPTER ?? (production ? 's3' : 'local'), [
        's3',
        'local',
      ]),
      localDir: path.resolve(REPO_ROOT, env.STORAGE_LOCAL_DIR ?? '.dev-files/storage'),
    },
    quotaBytes: 536870912,
    // Login attempts per IP per 15 minutes; generous in tests so suites can log in freely.
    loginRateLimit: nodeEnv === 'test' ? 1000 : 20,
  };
}
