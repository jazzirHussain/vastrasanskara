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

// Secrets that ship in the repo (dev default and .env.example); never acceptable in production.
const KNOWN_SECRETS = new Set(['dev-only-session-secret-not-for-production', 'change-me-dev-only-secret-at-least-32-chars']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parentDomain(origin) {
  try {
    return new URL(origin).hostname.split('.').slice(1).join('.');
  } catch {
    return null;
  }
}

function mongoHosts(uri) {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri);
  return match ? match[1].split(',').map((h) => h.replace(/:\d+$/, '').toLowerCase()) : [];
}

// Every reason a production config is unsafe, in plain words (Decision 16).
function productionProblems(env) {
  const problems = [];
  if ((env.STORAGE_ADAPTER ?? 's3') !== 's3') problems.push('STORAGE_ADAPTER must be s3 (files on this server would be lost)');
  if ((env.MAIL_ADAPTER ?? 'ses') !== 'ses') problems.push('MAIL_ADAPTER must be ses (file mail is never delivered)');
  const origins = ['APP_ORIGIN', 'API_ORIGIN'];
  for (const key of origins) {
    if (!env[key].startsWith('https://')) problems.push(`${key} must start with https://`);
  }
  if (origins.every((key) => env[key].startsWith('https://'))) {
    const [app, api] = origins.map((key) => parentDomain(env[key]));
    if (!app || app !== api || !app.includes('.')) {
      problems.push('APP_ORIGIN and API_ORIGIN must be subdomains of the same domain (like app.example.in and api.example.in)');
    }
  }
  if (env.SESSION_SECRET.length < 32 || KNOWN_SECRETS.has(env.SESSION_SECRET)) {
    problems.push('SESSION_SECRET must be a new random value of at least 32 characters');
  }
  if (mongoHosts(env.MONGO_URI).some((h) => LOCAL_HOSTS.has(h))) problems.push('MONGO_URI must point at the hosted database, not this machine');
  return problems;
}

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
    const problems = productionProblems(env);
    if (problems.length) throw new Error(`Production settings are not safe:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }

  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid PORT "${env.PORT}"`);

  return {
    env: nodeEnv,
    port,
    // The deployed git commit; the worker's heartbeat carries it so a deploy can wait for it.
    release: env.RELEASE_SHA || 'dev',
    mongoUri: env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/vastrasanskara',
    // Applied by server.js/worker.js after loading .env; null keeps the logger's default.
    logLevel: env.LOG_LEVEL
      ? oneOf('LOG_LEVEL', env.LOG_LEVEL, ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      : null,
    // Optional DNS servers for mongodb+srv lookups, for machines whose resolver Node cannot use.
    dnsServers: (env.DNS_SERVERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    appOrigin: env.APP_ORIGIN ?? 'http://localhost:5173',
    apiOrigin: env.API_ORIGIN ?? 'http://localhost:4000',
    sessionSecret: env.SESSION_SECRET ?? 'dev-only-session-secret-not-for-production',
    cookie: { name: production ? '__Host-sid' : 'sid', secure: production },
    aws: {
      region: env.AWS_REGION ?? 'ap-south-1',
      filesBucket: env.FILES_BUCKET ?? 'vs-files-dev',
      backupsBucket: env.BACKUPS_BUCKET ?? 'vs-backups-dev',
      // Billing PDFs get compliance retention; the files bucket must be created with Object Lock.
      objectLock: env.FILES_OBJECT_LOCK === 'true',
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
    // API requests per minute: per signed-in user, and per IP when signed out.
    rateLimits: nodeEnv === 'test' ? { user: 100000, anonymous: 100000 } : { user: 300, anonymous: 600 },
  };
}
