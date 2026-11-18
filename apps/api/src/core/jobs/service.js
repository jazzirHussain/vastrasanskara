import mongoose from 'mongoose';
import { clock } from '../../clock.js';
import { JobFailure } from './model.js';

const HEARTBEAT_ID = 'worker-heartbeat';
const STALE_AFTER_MS = 3 * 60 * 1000;
const system = () => mongoose.connection.collection('system');

// When this worker process started; a deploy waits for a heartbeat from its own release.
const STARTED_AT = new Date();

export async function recordHeartbeat({ release = 'dev' } = {}) {
  await system().updateOne(
    { _id: HEARTBEAT_ID },
    { $set: { at: clock.now(), release, startedAt: STARTED_AT } },
    { upsert: true },
  );
}

/** The last heartbeat: { at, release, startedAt }, or null before the first one. */
export async function readHeartbeat() {
  const heartbeat = await system().findOne({ _id: HEARTBEAT_ID });
  return heartbeat ? { at: heartbeat.at, release: heartbeat.release ?? null, startedAt: heartbeat.startedAt ?? null } : null;
}

/** 'ok' when the worker's heartbeat is under 3 minutes old, else 'stale'. */
export async function getWorkerStatus() {
  const heartbeat = await system().findOne({ _id: HEARTBEAT_ID });
  if (!heartbeat) return 'stale';
  return clock.now().getTime() - heartbeat.at.getTime() <= STALE_AFTER_MS ? 'ok' : 'stale';
}

export function recordJobFailure({ job, error, attempt }) {
  return JobFailure.create({ job, error, attempt, at: clock.now() });
}

export function listJobFailures() {
  return JobFailure.find().sort({ at: -1, _id: -1 }).limit(100).lean();
}
