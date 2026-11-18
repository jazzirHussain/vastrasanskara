import pino from 'pino';

// Never log phone numbers, emails, passwords, cookies, GSTINs, tokens, measurement values or
// request bodies, up to three levels down (e.g. a job's data.customer.email).
const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.body',
  ...['password', 'email', 'phone', 'measurements', 'gstin', 'token', 'rawBody'].flatMap((field) => [
    field,
    `*.${field}`,
    `*.*.${field}`,
    `*.*.*.${field}`,
  ]),
];

/**
 * Development: colour-coded single-line output via pino-pretty. Production (and LOG_FORMAT=json):
 * one JSON object per line for CloudWatch. Tests: silent unless LOG_LEVEL is set.
 */
export function loggerOptions(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const options = {
    level: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    redact: REDACT,
  };
  if (nodeEnv !== 'production' && nodeEnv !== 'test' && env.LOG_FORMAT !== 'json') {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: true,
        translateTime: 'SYS:HH:MM:ss.l',
        // Already in the request message ("GET /v1/x 200 3ms"); kept in JSON output.
        ignore: 'pid,hostname,method,path,status,ms',
      },
    };
  }
  return options;
}

/** `destination` (a stream) is used only for JSON output, e.g. to capture logs in tests. */
export function createLogger(env = process.env, destination) {
  const options = loggerOptions(env);
  return destination && !options.transport ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
