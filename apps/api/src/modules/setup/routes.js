import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { AppError } from '../../core/errors.js';
import { validate } from '../../core/validate.js';
import { confirmNumbers, goLiveChecklist, markLive, sendTestEmail } from './goLive.js';

const lastNumber = z.int().min(0).max(999999);
const numbersBody = z.strictObject({
  series: z.strictObject({
    invoice: lastNumber,
    credit_note: lastNumber,
    receipt_voucher: lastNumber,
    refund: lastNumber,
    receipt: lastNumber,
  }),
});

/** The go-live checklist (admin): /v1/go-live. */
export function setupRouter() {
  const router = Router();
  router.use(requirePermission('settings.edit'));

  // A test email costs a real send: 5 an hour per branch.
  const testEmailLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user.branchId),
    handler: (req, res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many test emails; try again in an hour')),
  });

  router.get('/', async (req, res) => {
    res.json(await goLiveChecklist(req.user.branchId));
  });
  router.post('/numbers', validate({ body: numbersBody }), async (req, res) => {
    res.json(await confirmNumbers(req.user.branchId, req.body, actorFrom(req)));
  });
  router.post('/test-email', testEmailLimit, async (req, res) => {
    res.json(await sendTestEmail(req.user.branchId, actorFrom(req)));
  });
  router.post('/live', async (req, res) => {
    res.json(await markLive(req.user.branchId, actorFrom(req)));
  });
  return router;
}
