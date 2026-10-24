import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { validate } from '../validate.js';
import { createDownloadUrl, createUploadUrl } from './service.js';

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
    res.json(await createUploadUrl(storage, req.user, req.body));
  });

  router.get('/url', validate({ query: urlQuery }), async (req, res) => {
    res.json({ url: await createDownloadUrl(storage, req.user, req.validatedQuery.key) });
  });

  return router;
}
