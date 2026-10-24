import { test, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

test('test env gets dev defaults and a non-secure sid cookie', () => {
  const c = loadConfig({ NODE_ENV: 'test' });
  expect(c.env).toBe('test');
  expect(c.cookie).toEqual({ name: 'sid', secure: false });
  expect(c.quotaBytes).toBe(536870912);
});
test('production throws listing every missing key', () => {
  expect(() => loadConfig({ NODE_ENV: 'production', MONGO_URI: 'mongodb://x' })).toThrow(/SESSION_SECRET.*APP_ORIGIN|APP_ORIGIN.*SESSION_SECRET/s);
});
test('production uses the __Host- cookie', () => {
  const c = loadConfig({
    NODE_ENV: 'production', PORT: '4000', MONGO_URI: 'mongodb://x', APP_ORIGIN: 'https://app.example.com',
    API_ORIGIN: 'https://api.example.com', SESSION_SECRET: 'x'.repeat(32), AWS_REGION: 'ap-south-1',
    FILES_BUCKET: 'f', BACKUPS_BUCKET: 'b', MAIL_FROM: 'a@example.com',
  });
  expect(c.cookie).toEqual({ name: '__Host-sid', secure: true });
  expect(c.mail.adapter).toBe('ses');
  expect(c.storage.adapter).toBe('s3');
});
test('rejects an unknown NODE_ENV', () => {
  expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
});
