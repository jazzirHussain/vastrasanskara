import { Router } from 'express';
import { branchPatchSchema, settingsPatchSchema } from '@vs/shared/schemas/settings.js';
import { actorFrom, requireAuth, requirePermission } from '../../core/auth/middleware.js';
import { validate } from '../../core/validate.js';
import { getBranch, toBranchJson, updateBranch } from '../branches/service.js';
import { getSettings, updateSettings } from './service.js';

export function settingsRouter() {
  const router = Router();

  router.get('/', requireAuth, async (req, res) => {
    res.json(await getSettings(req.user.branchId));
  });

  router.put('/', requirePermission('settings.edit'), validate({ body: settingsPatchSchema }), async (req, res) => {
    res.json(await updateSettings(req.user.branchId, req.body, actorFrom(req)));
  });

  return router;
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
