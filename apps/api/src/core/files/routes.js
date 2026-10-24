import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { requireAuth } from '../auth/middleware.js';
import { AppError, forbidden, notFound, validationError } from '../errors.js';
import { validate } from '../validate.js';
import { ALLOWED_TYPES, MAX_UPLOAD_BYTES, getFilePurpose } from './purposes.js';

// <branchId>/<purpose>/<yyyy>/<uuid>.<ext>
const KEY_PATTERN = /^([0-9a-f]{24})\/([a-z0-9_]+)\/\d{4}\/[0-9a-f-]{36}\.[a-z0-9]+$/;

const uploadBody = z.strictObject({
  purpose: z.string().min(1).max(50),
  contentType: z.string().min(1).max(100),
  size: z.int().positive(),
});
const urlQuery = z.strictObject({ key: z.string().min(1).max(300) });

export function filesRouter(storage) {
  const router = Router();
  router.use(requireAuth);

  router.post('/upload-url', validate({ body: uploadBody }), async (req, res) => {
    const { purpose: purposeName, contentType, size } = req.body;
    const purpose = getFilePurpose(purposeName);
    if (!purpose) throw validationError([{ path: 'purpose', message: 'Unknown file purpose' }]);
    if (!purpose.allowedTypes.includes(contentType) || !ALLOWED_TYPES[contentType]) {
      throw new AppError(400, 'FILE_TYPE_NOT_ALLOWED', 'This file type is not allowed');
    }
    if (size > MAX_UPLOAD_BYTES) throw new AppError(400, 'FILE_TOO_LARGE', 'Files must be 10 MB or smaller');
    if (!purpose.canWrite(req.user)) throw forbidden();

    const year = istDate(clock.now()).slice(0, 4);
    const key = `${req.user.branchId}/${purposeName}/${year}/${randomUUID()}.${ALLOWED_TYPES[contentType]}`;
    const { url, headers } = await storage.presignPut({ key, contentType, size });
    res.json({ key, url, headers });
  });

  router.get('/url', validate({ query: urlQuery }), async (req, res) => {
    const { key } = req.validatedQuery;
    const match = KEY_PATTERN.exec(key);
    // Another branch's file, an unknown purpose and a refused read all look like "not found".
    if (!match || match[1] !== req.user.branchId) throw notFound();
    const purpose = getFilePurpose(match[2]);
    if (!purpose || !(await purpose.canRead(req.user, key))) throw notFound();
    res.json({ url: await storage.presignGet(key, { expiresIn: 300 }) });
  });

  return router;
}
