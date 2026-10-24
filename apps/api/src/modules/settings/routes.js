import { Router } from 'express';
import { settingsPatchSchema } from '@vs/shared/schemas/settings.js';
import { actorFrom, requireAuth, requirePermission } from '../../core/auth/middleware.js';
import { validate } from '../../core/validate.js';
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
