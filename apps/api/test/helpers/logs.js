import { Writable } from 'node:stream';
import { createLogger } from '../../src/logger.js';

/** A real JSON logger whose output is collected in `lines` (parsed objects) for assertions. */
export function captureLogger(level = 'debug') {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      done();
    },
  });
  const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: level, LOG_FORMAT: 'json' }, stream);
  return { logger, lines };
}
