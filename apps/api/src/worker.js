import { loadConfig } from './config.js';
import { assertDatabaseReady, connectDb, disconnectDb } from './core/db.js';
import { createStorage } from './core/files/storage.js';
import './jobs.js';
import { startWorker } from './core/jobs/worker.js';
import { recordHeartbeat } from './core/jobs/service.js';
import { registerConfiguredAdapters } from './core/notify/adapters/configure.js';
import { logger } from './logger.js';

const config = loadConfig();
if (config.logLevel) logger.level = config.logLevel;
await connectDb(config.mongoUri, { dnsServers: config.dnsServers, autoIndex: config.env !== 'production' });
try {
  await assertDatabaseReady();
} catch (err) {
  logger.fatal(err.message);
  process.exit(1);
}
const storage = createStorage(config);
registerConfiguredAdapters(config, storage);
const { stop } = await startWorker({ config, storage });
// Report at once, so a deploy waiting for this release does not wait for the first minute.
await recordHeartbeat({ release: config.release });

async function shutdown(signal) {
  logger.info({ signal }, 'worker shutting down');
  await stop();
  await disconnectDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
