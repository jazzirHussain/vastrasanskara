import mongoose from 'mongoose';
import { clock } from '../clock.js';
import { logger } from '../logger.js';
import { AppError, notAuthenticated } from './errors.js';

const COLLECTION = 'idempotencyKeys';
const TTL_SECONDS = 24 * 60 * 60;
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

let ttlIndex;
function keys() {
  const collection = mongoose.connection.collection(COLLECTION);
  ttlIndex ??= collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS }).catch((err) => {
    ttlIndex = undefined;
    throw err;
  });
  return { collection, ready: ttlIndex };
}

const isDuplicateKey = (err) => err?.code === 11000;

function replay(res, record) {
  res.status(record.status);
  if (record.contentType) res.set('Content-Type', record.contentType);
  res.set('Idempotent-Replayed', 'true');
  return record.body === null ? res.end() : res.send(record.body);
}

/**
 * Makes a state-changing route safe to retry. The client sends an Idempotency-Key header;
 * the first request runs the handler and its response is stored for 24 h, a duplicate
 * while it runs gets 409, and a duplicate afterwards gets the stored response replayed.
 * Error responses (status >= 400) delete the key so the client can retry.
 */
export function idempotent() {
  return async (req, res, next) => {
    if (!req.user) throw notAuthenticated();
    const key = req.get('Idempotency-Key');
    if (!key || !KEY_PATTERN.test(key)) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header is required');
    }

    const { collection, ready } = keys();
    await ready;
    const id = `${req.user.id}:${key}`;
    const path = req.baseUrl + req.path;

    // Claim the key. If it exists, decide from its state; retry if it vanished meanwhile.
    for (let attempt = 0; ; attempt++) {
      try {
        await collection.insertOne({
          _id: id, method: req.method, path, state: 'in_progress', createdAt: clock.now(),
        });
        break;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
      const existing = await collection.findOne({ _id: id });
      if (!existing) {
        if (attempt < 2) continue;
        throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'This request is already being processed');
      }
      if (existing.method !== req.method || existing.path !== path) {
        throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different request');
      }
      if (existing.state === 'in_progress') {
        throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'This request is already being processed');
      }
      return replay(res, existing);
    }

    // Every response ends in res.end; store or release the key before the response is sent.
    const originalEnd = res.end.bind(res);
    res.end = (chunk, encoding, callback) => {
      if (typeof chunk === 'function') [chunk, encoding, callback] = [undefined, undefined, chunk];
      if (typeof encoding === 'function') [encoding, callback] = [undefined, encoding];
      const status = res.statusCode;
      const finalize =
        status >= 400
          ? collection.deleteOne({ _id: id })
          : collection.updateOne(
              { _id: id },
              {
                $set: {
                  state: 'done',
                  status,
                  contentType: res.get('Content-Type') ?? null,
                  body: chunk === undefined || chunk === null ? null : Buffer.from(chunk, encoding).toString(),
                },
              },
            );
      finalize
        .catch((err) => logger.error({ err, requestId: req.id }, 'idempotency finalize failed'))
        .finally(() => originalEnd(chunk, encoding, callback));
      return res;
    };
    return next();
  };
}
