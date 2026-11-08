import { Router } from 'express';
import {
  appointmentCancelSchema,
  appointmentDayQuery,
  appointmentListQuery,
  appointmentMarkSchema,
  appointmentMoveSchema,
  appointmentSchema,
} from '@vs/shared';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { idempotent } from '../../core/idempotency.js';
import { validate, versioned } from '../../core/validate.js';
import { logger } from '../../logger.js';
import {
  appointmentsForDay,
  appointmentsJson,
  bookAppointment,
  cancelAppointment,
  getAppointment,
  listAppointments,
  markAppointment,
  moveAppointment,
} from './service.js';

const WRITE = 'appointments.write';
const OWN = 'appointments.own';

const one = async (branchId, appointment) => (await appointmentsJson(branchId, [appointment]))[0];

/**
 * Answers 201 for a booking that has committed. If reading it back fails the reply is still a
 * success: an error would free the Idempotency-Key and a retry would book again.
 */
async function respondCommitted(req, res, appointment) {
  let body;
  try {
    body = { appointment: await one(req.user.branchId, appointment) };
  } catch (err) {
    logger.warn({ err, appointmentId: String(appointment._id), requestId: req.id }, 'appointment booked; reading it back failed');
    body = { appointment: { id: String(appointment._id), status: appointment.status, version: appointment.__v } };
  }
  res.status(201).json(body);
}

/**
 * Appointments. Front desk (appointments.write) books, moves and cancels and sees every designer;
 * designers (appointments.own) see and mark only their own.
 */
export function appointmentsRouter() {
  const router = Router();

  router.post('/', requirePermission(WRITE), validate({ body: appointmentSchema }), idempotent(), async (req, res) => {
    await respondCommitted(req, res, await bookAppointment(req.user.branchId, req.body, actorFrom(req)));
  });

  router.get('/day', requirePermission(OWN), validate({ query: appointmentDayQuery }), async (req, res) => {
    res.json(await appointmentsForDay(req.user.branchId, req.user, req.validatedQuery));
  });

  router.get('/', requirePermission(OWN), validate({ query: appointmentListQuery }), async (req, res) => {
    const { branchId } = req.user;
    const { items, nextCursor } = await listAppointments(branchId, req.user, req.validatedQuery);
    res.json({ items: await appointmentsJson(branchId, items), nextCursor });
  });

  router.get('/:id', requirePermission(OWN), async (req, res) => {
    const { branchId } = req.user;
    res.json({ appointment: await one(branchId, await getAppointment(branchId, req.user, req.params.id)) });
  });

  router.patch('/:id', requirePermission(WRITE), validate({ body: versioned(appointmentMoveSchema) }), async (req, res) => {
    const { branchId } = req.user;
    const { appointment } = await moveAppointment(branchId, req.params.id, req.body, actorFrom(req));
    res.json({ appointment: await one(branchId, appointment) });
  });

  router.post('/:id/cancel', requirePermission(WRITE), validate({ body: versioned(appointmentCancelSchema) }), async (req, res) => {
    const { branchId } = req.user;
    res.json({ appointment: await one(branchId, await cancelAppointment(branchId, req.params.id, req.body, actorFrom(req))) });
  });

  router.post('/:id/mark', requirePermission(OWN), validate({ body: versioned(appointmentMarkSchema) }), async (req, res) => {
    const { branchId } = req.user;
    const appointment = await markAppointment(branchId, req.user, req.params.id, req.body, actorFrom(req));
    res.json({ appointment: await one(branchId, appointment) });
  });

  return router;
}
