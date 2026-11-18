// Builds indexes and applies data migrations. Run by every deploy before the new release starts:
//   node apps/api/src/cli/migrate.js
import { loadConfig } from '../config.js';
import { assertDatabaseReady, connectDb, disconnectDb } from '../core/db.js';
import { runMigrations } from '../core/migrations.js';
import { MODELS } from '../models.js';
import { MIGRATIONS } from '../migrations/index.js';
import { logger } from '../logger.js';

const config = loadConfig();
await connectDb(config.mongoUri, { dnsServers: config.dnsServers, autoIndex: false });
try {
  await assertDatabaseReady();
  const { indexes, applied } = await runMigrations({ models: MODELS, migrations: MIGRATIONS, log: logger });
  console.log(`Indexes ready for ${indexes.length} collections; applied: ${applied.length ? applied.join(', ') : 'nothing new'}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
