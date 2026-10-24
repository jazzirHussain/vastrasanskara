import mongoose from 'mongoose';

export async function connectDb(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  return mongoose.connection;
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
