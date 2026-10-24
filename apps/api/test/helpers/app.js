import request from 'supertest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { Branch } from '../../src/modules/branches/model.js';
import { User } from '../../src/modules/users/model.js';
import { hashPassword } from '../../src/modules/auth/service.js';

/** App with test config (appOrigin https://app.test); `overrides.config` merges into it. */
export function buildTestApp({ config, ...overrides } = {}) {
  return createApp({
    config: { ...loadConfig({ NODE_ENV: 'test' }), appOrigin: 'https://app.test', ...config },
    ...overrides,
  });
}

const WRITE_METHODS = ['post', 'put', 'patch', 'delete'];

/** supertest wrapper whose write methods send the X-Requested-With app header. */
export function api(agentOrApp) {
  // An Express app has listen(); a supertest agent does not.
  const target = typeof agentOrApp.listen === 'function' ? request(agentOrApp) : agentOrApp;
  const wrapper = { get: (url) => target.get(url) };
  for (const method of WRITE_METHODS) {
    wrapper[method] = (url) => target[method](url).set('X-Requested-With', 'vs-app');
  }
  return wrapper;
}

export function createTestBranch(fields = {}) {
  return Branch.create({ name: 'Vastrasanskara', legalName: 'Vastrasanskara', stateCode: '29', ...fields });
}

let userCounter = 0;
const passwordHashes = new Map();

/** Creates a user in the first existing branch (or a new one). Default password 'correct-horse-1'. */
export async function createTestUser({ roles, email, password = 'correct-horse-1', active = true, name } = {}) {
  const branch = (await Branch.findOne()) ?? (await createTestBranch());
  if (!passwordHashes.has(password)) passwordHashes.set(password, await hashPassword(password));
  userCounter += 1;
  return User.create({
    branchId: branch._id,
    name: name ?? `Test User ${userCounter}`,
    email: email ?? `user-${userCounter}@example.com`,
    passwordHash: passwordHashes.get(password),
    roles,
    active,
  });
}

/** Creates a user with the given roles and logs in; agent is wrapped with api(). */
export async function loginAs(app, { roles, ...userFields }) {
  const user = await createTestUser({ roles, ...userFields });
  const agent = request.agent(app);
  const r = await api(agent).post('/v1/auth/login').send({ email: user.email, password: 'correct-horse-1' });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { agent: api(agent), user };
}
