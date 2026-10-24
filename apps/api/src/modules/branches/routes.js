import { Router } from 'express';
import { branchPatchSchema } from '@vs/shared/schemas/branch.js';
import { actorFrom, requireAuth, requirePermission } from '../../core/auth/middleware.js';
import { validate } from '../../core/validate.js';
import { BRANCH_FIELDS, getBranch, updateBranch } from './service.js';

function toBranchJson(branch) {
  return { id: String(branch._id), ...Object.fromEntries(BRANCH_FIELDS.map((f) => [f, branch[f] ?? null])) };
}

export function branchRouter() {
  const router = Router();

  router.get('/', requireAuth, async (req, res) => {
    res.json(toBranchJson(await getBranch(req.user.branchId)));
  });

  router.put('/', requirePermission('settings.edit'), validate({ body: branchPatchSchema }), async (req, res) => {
    res.json(toBranchJson(await updateBranch(req.user.branchId, req.body, actorFrom(req))));
  });

  return router;
}
