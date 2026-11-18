import dns from 'node:dns';
import mongoose from 'mongoose';

/**
 * Connects Mongoose. `dnsServers` (optional) replaces Node's DNS servers first — needed where
 * Node cannot use the system resolver (e.g. Windows with an IPv6 link-local DNS server), which
 * breaks the SRV lookup of mongodb+srv:// URIs.
 */
export async function connectDb(uri, { dnsServers = [], autoIndex = true } = {}) {
  if (dnsServers.length) dns.setServers(dnsServers);
  // Production builds indexes in `cli/migrate.js` during a deploy, never on start-up.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex });
  return mongoose.connection;
}

/**
 * Refuses a database the app cannot run on: MongoDB below 7.0 (partial `$in` indexes) or one
 * without transactions (not a replica set or sharded cluster). `admin` is for tests.
 */
export async function assertDatabaseReady(admin = mongoose.connection.db.admin()) {
  const { version } = await admin.buildInfo();
  if (Number(String(version).split('.')[0]) < 7) {
    throw new Error(`The database must be MongoDB 7.0 or later (found ${version})`);
  }
  const hello = await admin.command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    throw new Error('The database does not support transactions (it is not a replica set)');
  }
  return { version };
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

/** True when connected and the server answers a ping. */
export async function isDbUp() {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    await mongoose.connection.db.admin().ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs fn(session) in a transaction. The driver retries the whole callback on
 * TransientTransactionError and the commit on UnknownTransactionCommitResult.
 * Always ends the session; returns fn's result.
 */
export async function withTransaction(fn) {
  const session = await mongoose.connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
