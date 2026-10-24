import { Router } from 'express';
import { z } from 'zod';
import { workerPatchSchema, workerSchema } from '@vs/shared/schemas/workshop.js';
import { actorFrom, requireAnyPermission, requirePermission } from '../../core/auth/middleware.js';
import { validate, versioned } from '../../core/validate.js';
import { createWorker, listWorkers, updateWorker } from './service.js';

export function toWorkerJson(w) {
  return { id: String(w._id), name: w.name, skill: w.skill, phone: w.phone ?? null, active: w.active, version: w.__v };
}

export const activeQuery = z.strictObject({
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

/** Designers read the list to record who worked on a stage; operations and admin keep it. */
export function workersRouter() {
  const router = Router();

  router.get(
    '/',
    requireAnyPermission('workshop.manage', 'production.update'),
    validate({ query: activeQuery }),
    async (req, res) => {
      res.json({ items: (await listWorkers(req.user.branchId, req.validatedQuery)).map(toWorkerJson) });
    },
  );

  router.post('/', requirePermission('workshop.manage'), validate({ body: workerSchema }), async (req, res) => {
    res.status(201).json(toWorkerJson(await createWorker(req.user.branchId, req.body, actorFrom(req))));
  });

  router.patch(
    '/:id',
    requirePermission('workshop.manage'),
    validate({ body: versioned(workerPatchSchema) }),
    async (req, res) => {
      res.json(toWorkerJson(await updateWorker(req.user.branchId, req.params.id, req.body, actorFrom(req))));
    },
  );

  return router;
}
