import { Router } from 'express';
import { z } from 'zod';
import { month, periodLockSchema, periodUnlockSchema } from '@vs/shared/schemas/billing.js';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { validate } from '../../core/validate.js';
import { getUserNames } from '../users/service.js';
import { getPeriod, listPeriods, lockPeriod, unlockPeriod } from './service.js';

const fyQuery = z.strictObject({
  fy: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .refine((v) => (Number(v.slice(0, 4)) + 1) % 100 === Number(v.slice(5)), 'Not a financial year')
    .optional(),
});
const monthParams = z.strictObject({ month });

const person = (names, id) => (id ? { id: String(id), name: names.get(String(id)) ?? '' } : null);

function toMonthJson(m, names) {
  return {
    month: m.month,
    locked: m.locked,
    lockedAt: m.lockedAt,
    lockedBy: person(names, m.lockedBy),
    note: m.note,
    canLock: m.canLock,
    history: m.history.map((h) => ({ action: h.action, note: h.note, reason: h.reason, by: person(names, h.by), at: h.at })),
  };
}

const namesOf = (months) => getUserNames(months.flatMap((m) => [m.lockedBy, ...m.history.map((h) => h.by)]));

export function periodsRouter() {
  const router = Router();
  router.use(requirePermission('periods.lock'));

  router.get('/', validate({ query: fyQuery }), async (req, res) => {
    const { fy, months } = await listPeriods(req.user.branchId, req.validatedQuery);
    const names = await namesOf(months);
    res.json({ fy, months: months.map((m) => toMonthJson(m, names)) });
  });

  router.post('/:month/lock', validate({ params: monthParams, body: periodLockSchema }), async (req, res) => {
    await lockPeriod(req.user.branchId, req.params.month, req.body, actorFrom(req));
    const m = await getPeriod(req.user.branchId, req.params.month);
    res.json(toMonthJson(m, await namesOf([m])));
  });

  router.post('/:month/unlock', validate({ params: monthParams, body: periodUnlockSchema }), async (req, res) => {
    await unlockPeriod(req.user.branchId, req.params.month, req.body, actorFrom(req));
    const m = await getPeriod(req.user.branchId, req.params.month);
    res.json(toMonthJson(m, await namesOf([m])));
  });

  return router;
}
