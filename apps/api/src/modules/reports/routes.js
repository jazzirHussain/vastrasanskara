import { Router } from 'express';
import { z } from 'zod';
import { REPORTS, reportListQuery, reportRequestSchema } from '@vs/shared';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { idempotent } from '../../core/idempotency.js';
import { validate } from '../../core/validate.js';
import { logger } from '../../logger.js';
import { getUserNames } from '../users/service.js';
import { toRunJson } from './json.js';
import { downloadLink, getRun, listRuns, requestReport } from './service.js';

const EXPORT = 'reports.export';
const downloadQuery = z.strictObject({ file: z.coerce.number().int().min(0).max(9).optional() });

const jsonOf = async (run) => toRunJson(run, { names: await getUserNames([run.requestedBy].filter(Boolean)) });

// 202: the run is recorded; if reading it back fails, answer what is known.
async function respondCommitted(req, res, run) {
  let report;
  try {
    report = await jsonOf(run);
  } catch (err) {
    logger.warn({ err, runId: String(run._id), requestId: req.id }, 'report requested; reading it back failed');
    report = { id: String(run._id), status: run.status };
  }
  res.status(202).json({ report });
}

/** Report files: admin only (reports.export). */
export function reportsRouter(storage) {
  const router = Router();

  router.get('/catalog', requirePermission(EXPORT), (req, res) => {
    res.json({ reports: REPORTS });
  });

  router.post('/', requirePermission(EXPORT), validate({ body: reportRequestSchema }), idempotent(), async (req, res) => {
    const run = await requestReport(req.user.branchId, req.body, actorFrom(req), { storage });
    await respondCommitted(req, res, run);
  });

  router.get('/', requirePermission(EXPORT), validate({ query: reportListQuery }), async (req, res) => {
    const { items, nextCursor } = await listRuns(req.user.branchId, req.validatedQuery);
    const names = await getUserNames(items.map((r) => r.requestedBy).filter(Boolean));
    res.json({ items: items.map((r) => toRunJson(r, { names })), nextCursor });
  });

  router.get('/:id', requirePermission(EXPORT), async (req, res) => {
    res.json({ report: await jsonOf(await getRun(req.user.branchId, req.params.id)) });
  });

  router.get('/:id/download', requirePermission(EXPORT), validate({ query: downloadQuery }), async (req, res) => {
    const { url, filename } = await downloadLink(req.user.branchId, req.params.id, actorFrom(req), { storage, file: req.validatedQuery.file });
    res.json({ url, filename });
  });

  return router;
}
