import { beforeAll, afterEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDb, disconnectDb } from '../../src/core/db.js';

/** Gives the test file a fresh single-member replica set (transactions need one). */
export function useTestDb() {
  let replSet;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await connectDb(replSet.getUri());
  });

  afterEach(async () => {
    const collections = await mongoose.connection.db.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  });

  afterAll(async () => {
    await disconnectDb();
    await replSet?.stop();
  });
}
