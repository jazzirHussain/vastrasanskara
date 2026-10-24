import request from 'supertest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

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
