import mongoose from 'mongoose';
import { createStorage } from '../files/storage.js';
import { defineJob } from '../jobs/registry.js';
import { runBackup } from './backup.js';
import { mongodumpStream } from './mongodump.js';
import { checkStorage } from './storageCheck.js';

// Every 6 hours (IST) and Mondays 09:00 IST. Registered through src/jobs.js.
defineJob('backup', {
  schedule: '0 */6 * * *',
  handler: ({ config }) =>
    runBackup({
      dump: () => mongodumpStream(config.mongoUri),
      storage: createStorage(config, 'backupsBucket'),
    }),
});

defineJob('storage-check', {
  schedule: '0 9 * * 1',
  handler: async ({ config }) => {
    const stats = await mongoose.connection.db.stats();
    await checkStorage({ usedBytes: stats.dataSize + stats.indexSize, quotaBytes: config.quotaBytes });
  },
});
