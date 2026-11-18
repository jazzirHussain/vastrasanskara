// Starts an in-memory MongoDB, the API (:4100) and the worker against it, seeds the branch and
// serves a production build of the web app (:4173) that calls the API cross-origin, as in production.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { PASSWORD, USERS, seed } from './seed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = 'http://localhost:4100';
const WEB = 'http://localhost:4173';
const step = (what) => console.log(`[e2e setup] ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, { env, cwd = ROOT, wait = false, name }) {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  let out = '';
  const keep = (d) => {
    out = (out + d).slice(-4000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.output = () => `--- ${name}\n${out}`;
  if (!wait) return child;
  return new Promise((resolve, reject) =>
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${name} failed (${code})\n${out}`)))),
  );
}

async function waitFor(url, children) {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}\n${children.map((c) => c.output()).join('\n')}`);
}

export default async function globalSetup() {
  step("starting MongoDB");
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri('vastrasanskara');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vs-e2e-'));
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    MONGO_URI: uri,
    DNS_SERVERS: '',
    PORT: '4100',
    API_ORIGIN: API,
    APP_ORIGIN: WEB,
    SESSION_SECRET: randomBytes(32).toString('hex'),
    STORAGE_ADAPTER: 'local',
    STORAGE_LOCAL_DIR: path.join(tmp, 'storage'),
    MAIL_ADAPTER: 'file',
    MAIL_FILE_DIR: path.join(tmp, 'mail'),
  };
  const children = [];
  globalThis.__vsE2E = { replSet, children };

  step("bootstrapping the branch");
  await run('node', ['apps/api/src/cli/bootstrap.js'], {
    name: 'bootstrap',
    wait: true,
    env: {
      ...env,
      BOOTSTRAP_BRANCH_NAME: 'Vastrasanskara',
      BOOTSTRAP_LEGAL_NAME: 'Vastrasanskara Designs LLP',
      BOOTSTRAP_GSTIN: '29ABCDE1234F1Z5',
      BOOTSTRAP_STATE_CODE: '29',
      BOOTSTRAP_PHONE: '9845012345',
      BOOTSTRAP_ADDRESS_LINE1: '12, 4th Cross, Indiranagar',
      BOOTSTRAP_CITY: 'Bengaluru',
      BOOTSTRAP_PINCODE: '560038',
      BOOTSTRAP_ADMIN_NAME: USERS.admin.name,
      BOOTSTRAP_ADMIN_EMAIL: USERS.admin.email,
      BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
    },
  });
  step("starting the API and worker");
  children.push(run('node', ['apps/api/src/server.js'], { name: 'api', env }));
  children.push(run('node', ['apps/api/src/worker.js'], { name: 'worker', env }));
  step("building the web app");
  await run('npm', ['run', 'build', '-w', '@vs/web'], { name: 'web build', wait: true, env: { ...process.env, VITE_API_URL: API } });
  children.push(run('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { name: 'web', cwd: path.join(ROOT, 'apps/web'), env: process.env }));
  step("waiting for the API and web app");
  await waitFor(`${API}/v1/health`, children);
  await waitFor(WEB, children);

  step("seeding");
  // Seed as the admin through the API; users straight into the database.
  let cookie = '';
  const api = async (method, url, body) => {
    const r = await fetch(`${API}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vs-app', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const json = r.status === 204 ? null : await r.json();
    if (!r.ok) throw new Error(`${method} ${url} ${r.status} ${JSON.stringify(json)}`);
    return json;
  };
  await api('POST', '/v1/auth/login', { email: USERS.admin.email, password: PASSWORD });
  const { hashPassword } = await import('../api/src/core/auth/passwords.js');
  const connection = await mongoose.createConnection(uri).asPromise();
  try {
    const branch = await connection.collection('branches').findOne();
    const passwordHash = await hashPassword(PASSWORD);
    const insertUser = ({ name, email, roles }) =>
      connection.collection('users').insertOne({
        branchId: branch._id,
        name,
        email,
        roles,
        passwordHash,
        active: true,
        failedLoginCount: 0,
        lockedUntil: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    await seed({ api, insertUser });
  } finally {
    await connection.close();
  }
}
