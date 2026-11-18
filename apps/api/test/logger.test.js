import { test, expect } from 'vitest';
import { loggerOptions } from '../src/logger.js';
import { captureLogger } from './helpers/logs.js';

test('development logs are colour-coded and readable; production stays JSON; tests are silent', () => {
  const dev = loggerOptions({ NODE_ENV: 'development' });
  expect(dev.level).toBe('info');
  expect(dev.transport).toMatchObject({ target: 'pino-pretty', options: { colorize: true } });
  expect(loggerOptions({}).transport?.target).toBe('pino-pretty'); // NODE_ENV unset = development
  expect(loggerOptions({ NODE_ENV: 'production' }).transport).toBeUndefined();
  expect(loggerOptions({ NODE_ENV: 'development', LOG_FORMAT: 'json' }).transport).toBeUndefined();
  expect(loggerOptions({ NODE_ENV: 'test' }).level).toBe('silent');
  expect(loggerOptions({ NODE_ENV: 'development', LOG_LEVEL: 'debug' }).level).toBe('debug');
});

test('personal data is redacted, including one level down (e.g. err.keyValue.email)', () => {
  const { logger, lines } = captureLogger();
  logger.error({ user: { email: 'a@b.c', phone: '+919876543210' }, err: { keyValue: { email: 'x@y.z' } }, password: 'p' }, 'boom');
  const text = JSON.stringify(lines[0]);
  for (const secret of ['a@b.c', '+919876543210', 'x@y.z', '"p"']) expect(text).not.toContain(secret);
  expect(text).toContain('[Redacted]');
});

test('deeply nested personal fields are hidden', () => {
  const { logger, lines } = captureLogger();
  logger.error(
    {
      job: { data: { customer: { email: 'deep@x.y', phone: '+919811111111' } } },
      gstin: '29ABCDE1234F1Z5',
      token: 'reset-token-abc',
      rawBody: 'raw-bytes-here',
      req: { body: { name: 'Body Name' } },
    },
    'boom',
  );
  const text = JSON.stringify(lines[0]);
  for (const secret of ['deep@x.y', '+919811111111', '29ABCDE1234F1Z5', 'reset-token-abc', 'raw-bytes-here', 'Body Name']) {
    expect(text).not.toContain(secret);
  }
});
