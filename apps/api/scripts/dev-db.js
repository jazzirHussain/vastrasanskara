// Local MongoDB for development: a one-member replica set whose data persists in .data/db.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dbPath = path.join(REPO_ROOT, '.data/db');
mkdirSync(dbPath, { recursive: true });

const replSet = await MongoMemoryReplSet.create({
  replSet: { name: 'rs0', count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [{ port: 27017, dbPath }],
});

console.log(`MongoDB ready: ${replSet.getUri('vastrasanskara')}`);
console.log(`Data directory: ${dbPath}`);
console.log('Press Ctrl+C to stop.');

async function shutdown() {
  await replSet.stop({ doCleanup: false });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
