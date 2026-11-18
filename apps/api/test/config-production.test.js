import { test, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const SAFE = {
  NODE_ENV: 'production', MONGO_URI: 'mongodb+srv://u:p@cluster0.abcde.mongodb.net/vs', APP_ORIGIN: 'https://app.vastrasanskara.in',
  API_ORIGIN: 'https://api.vastrasanskara.in', SESSION_SECRET: 's'.repeat(40), AWS_REGION: 'ap-south-1',
  FILES_BUCKET: 'f', BACKUPS_BUCKET: 'b', MAIL_FROM: 'a@vastrasanskara.in',
};
const problems = (env) => {
  try {
    loadConfig(env);
  } catch (err) {
    return err.message;
  }
  return null;
};

test('production refuses unsafe settings with one plain message', () => {
  const message = problems({
    ...SAFE, STORAGE_ADAPTER: 'local', MAIL_ADAPTER: 'file', APP_ORIGIN: 'http://app.vastrasanskara.in',
    SESSION_SECRET: 'change-me-dev-only-secret-at-least-32-chars', MONGO_URI: 'mongodb://localhost:27017/vs',
  });
  expect(message.split('\n')[0]).toBe('Production settings are not safe:');
  const lines = message.split('\n').slice(1);
  expect(lines).toHaveLength(5);
  expect(lines.every((l) => l.startsWith('- '))).toBe(true);
  expect(message).toMatch(/STORAGE_ADAPTER/);
  expect(message).toMatch(/MAIL_ADAPTER/);
  expect(message).toMatch(/APP_ORIGIN.*https/);
  expect(message).toMatch(/SESSION_SECRET/);
  expect(message).toMatch(/MONGO_URI/);
  expect(problems({ ...SAFE, MONGO_URI: 'mongodb://127.0.0.1/vs' })).toMatch(/MONGO_URI/);
  expect(problems({ ...SAFE, SESSION_SECRET: 'dev-only-session-secret-not-for-production' })).toMatch(/SESSION_SECRET/);
});

test('production origins must be sibling subdomains', () => {
  expect(problems({ ...SAFE, APP_ORIGIN: 'https://app.a.in', API_ORIGIN: 'https://api.b.in' })).toMatch(/same domain/);
  expect(problems({ ...SAFE, APP_ORIGIN: 'https://app.a.in', API_ORIGIN: 'https://api.a.in' })).toBeNull();
});

test('a safe production config loads with the release id', () => {
  const c = loadConfig({ ...SAFE, RELEASE_SHA: 'abc1234', FILES_OBJECT_LOCK: 'true' });
  expect(c.release).toBe('abc1234');
  expect(c.aws.objectLock).toBe(true);
  expect(c.rateLimits).toEqual({ user: 300, anonymous: 600 });
  const dev = loadConfig({ NODE_ENV: 'test' });
  expect(dev.release).toBe('dev');
  expect(dev.aws.objectLock).toBe(false);
  expect(dev.rateLimits.user).toBe(100000);
});
