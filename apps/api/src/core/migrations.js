import mongoose from 'mongoose';
import { clock } from '../clock.js';

const MIGRATIONS = 'migrations';

/**
 * Builds every model's indexes, then runs each numbered migration not yet recorded in
 * `migrations`, in order. A migration is recorded only after its `up` succeeds; a failure
 * stops the run (later migrations wait for the next deploy). `up(db)` must be idempotent.
 */
export async function runMigrations({ models, migrations, log }) {
  const db = mongoose.connection.db;
  const indexes = [];
  for (const model of models) {
    try {
      await model.createIndexes();
    } catch (err) {
      throw new Error(`Indexes for ${model.modelName} failed: ${err.message}`, { cause: err });
    }
    indexes.push(model.modelName);
  }
  log.info({ count: indexes.length }, 'indexes ready');

  const done = new Set((await db.collection(MIGRATIONS).find({}, { projection: { _id: 1 } }).toArray()).map((m) => m._id));
  const applied = [];
  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    try {
      await migration.up(db);
    } catch (err) {
      log.error({ migration: migration.id }, 'migration failed');
      throw new Error(`Migration ${migration.id} failed: ${err.message}`, { cause: err });
    }
    await db.collection(MIGRATIONS).insertOne({ _id: migration.id, at: clock.now() });
    applied.push(migration.id);
    log.info({ migration: migration.id }, 'migration applied');
  }
  return { indexes, applied };
}
