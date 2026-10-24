import { loadConfig } from './config.js';
import { connectDb, disconnectDb } from './core/db.js';
import { createStorage } from './core/files/storage.js';
import './jobs.js';
import { startWorker } from './core/jobs/worker.js';
import { registerConfiguredAdapters } from './core/notify/adapters/configure.js';
import { logger } from './logger.js';

const config = loadConfig();
if (config.logLevel) logger.level = config.logLevel;
await connectDb(config.mongoUri, { dnsServers: config.dnsServers });
const storage = createStorage(config);
registerConfiguredAdapters(config, storage);
const { stop } = await startWorker({ config, storage });

async function shutdown(signal) {
  logger.info({ signal }, 'worker shutting down');
  await stop();
  await disconnectDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
