import pino from 'pino';

// Never log phone numbers, emails, passwords, cookies or measurement values.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: [
    'req.headers.cookie',
    'req.headers.authorization',
    '*.password',
    '*.email',
    '*.phone',
    '*.measurements',
  ],
});
