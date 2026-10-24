import { Router } from 'express';
import { AppError, notFound } from '../errors.js';

// Reads at most `limit` bytes; returns null when the stream is longer.
async function readUpTo(stream, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Development only: plays the part of S3 for local storage, accepting PUT and GET on the
 * presigned /v1/dev-files/<key> links that createLocalStorage issues.
 */
export function devFilesRouter(storage) {
  const router = Router();
  const keyOf = (req) => [].concat(req.params.key).join('/');

  router.put('/*key', async (req, res) => {
    const key = keyOf(req);
    const { contentType, size } = storage.verifyPutLink({ key, ...req.query });
    if (req.get('Content-Type') !== contentType) {
      throw new AppError(403, 'FILE_LINK_INVALID', 'This file link is invalid or has expired');
    }
    const data = await readUpTo(req, size);
    if (!data || data.length !== size) {
      throw new AppError(400, 'FILE_SIZE_MISMATCH', 'Uploaded file size does not match');
    }
    await storage.putObject({ key, body: data, contentType });
    res.status(200).end();
  });

  router.get('/*key', async (req, res) => {
    const key = keyOf(req);
    storage.verifyGetLink({ key, ...req.query });
    const head = await storage.headObject(key);
    if (!head) throw notFound();
    res.set('Content-Type', head.contentType);
    (await storage.getObject(key)).pipe(res);
  });

  return router;
}
