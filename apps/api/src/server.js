import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { connectDb, disconnectDb } from './core/db.js';
import { ensureSessionIndexes } from './core/auth/sessions.js';
import { createStorage } from './core/files/storage.js';
import { registerConfiguredAdapters } from './core/notify/adapters/configure.js';
import { logger } from './logger.js';

const config = loadConfig();
if (config.logLevel) logger.level = config.logLevel;
await connectDb(config.mongoUri, { dnsServers: config.dnsServers });
await ensureSessionIndexes();
const storage = createStorage(config);
registerConfiguredAdapters(config, storage);
const app = createApp({ config, storage });

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
