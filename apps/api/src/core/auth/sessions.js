import mongoose from 'mongoose';
import session from 'express-session';
import MongoStore from 'connect-mongo';

export const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const SESSIONS = 'sessions';

// Resolves once Mongoose connects, so the app can be built before the database is up.
// (connection.asPromise() resolves immediately if connect() has not been called yet.)
function mongoClientPromise() {
  const connection = mongoose.connection;
  if (connection.readyState === 1) return Promise.resolve(connection.getClient());
  return new Promise((resolve) => connection.once('open', () => resolve(connection.getClient())));
}

/**
 * Server-side sessions in MongoDB. Session data is { userId, createdAt } (createdAt in ms);
 * the cookie slides with activity (idle timeout) and loadUser enforces the absolute limit.
 */
export function sessionMiddleware(config, clientPromise = mongoClientPromise()) {
  return session({
    name: config.cookie.name,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: MongoStore.create({
      clientPromise,
      collectionName: SESSIONS,
      stringify: false,
      ttl: IDLE_TIMEOUT_MS / 1000,
    }),
    cookie: {
      httpOnly: true,
      secure: config.cookie.secure,
      sameSite: 'strict',
      path: '/',
      maxAge: IDLE_TIMEOUT_MS,
    },
  });
}

/** Deletes every stored session of a user (deactivation, role change, password reset). */
export async function revokeUserSessions(userId) {
  const result = await mongoose.connection
    .collection(SESSIONS)
    .deleteMany({ 'session.userId': String(userId) });
  return result.deletedCount;
}
