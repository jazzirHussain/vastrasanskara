import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { connectDb, disconnectDb } from './core/db.js';
import { logger } from './logger.js';

const config = loadConfig();
await connectDb(config.mongoUri);
const app = createApp({ config });

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'api listening');
});

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await disconnectDb();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
