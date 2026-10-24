import { Router } from 'express';
import { measurementSchema } from '@vs/shared/schemas/measurements.js';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { validate } from '../../core/validate.js';
import { getUserNames } from '../users/service.js';
import { latestMeasurements, listMeasurements, recordMeasurement } from './service.js';

function toMeasurementJson(m, names) {
  const takenBy = String(m.takenBy);
  return {
    id: String(m._id),
    customerId: String(m.customerId),
    garmentType: m.garmentType,
    values: m.values.map(({ name, value, unit }) => ({ name, value, unit })),
    notes: m.notes,
    takenBy: { id: takenBy, name: names.get(takenBy) ?? '' },
    takenAt: m.takenAt,
  };
}

/** Mounted at /v1/customers/:id/measurements. */
export function measurementsRouter() {
  const router = Router({ mergeParams: true });

  router.get('/', requirePermission('customers.read'), async (req, res) => {
    const items = await listMeasurements(req.user.branchId, req.params.id);
    const names = await getUserNames(items.map((m) => m.takenBy));
    res.json({ items: items.map((m) => toMeasurementJson(m, names)) });
  });

  router.get('/latest', requirePermission('customers.read'), async (req, res) => {
    const latest = Object.values(await latestMeasurements(req.user.branchId, req.params.id));
    const names = await getUserNames(latest.map((m) => m.takenBy));
    res.json(Object.fromEntries(latest.map((m) => [m.garmentType, toMeasurementJson(m, names)])));
  });

  router.post('/', requirePermission('measurements.write'), validate({ body: measurementSchema }), async (req, res) => {
    const measurement = await recordMeasurement(req.user.branchId, req.params.id, req.body, actorFrom(req));
    const names = await getUserNames([measurement.takenBy]);
    res.status(201).json(toMeasurementJson(measurement, names));
  });

  return router;
}
