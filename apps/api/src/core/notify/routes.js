import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { notFound } from '../errors.js';
import { validate } from '../validate.js';
import { getAdapterByProvider } from './adapters/registry.js';
import { OUTBOX_STATUSES } from './models.js';
import {
  applyDeliveryStatuses,
  listNotifications,
  listOutbox,
  markAllNotificationsRead,
  markNotificationRead,
  retryOutboxEntry,
} from './service.js';

const toNotificationJson = (n) => ({
  id: String(n._id),
  event: n.event,
  message: n.message,
  link: n.link,
  read: n.read,
  createdAt: n.createdAt,
});

const toOutboxJson = ({ _id, __v: _v, ...rest }) => ({ id: String(_id), ...rest });

/** The signed-in user's in-app notifications (the bell). */
export function notificationsRouter() {
  const router = Router();
  router.use(requireAuth);

  const listQuery = z.strictObject({ unread: z.enum(['true', 'false']).optional() });

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const { items, unreadCount } = await listNotifications(req.user.id, {
      unreadOnly: req.validatedQuery.unread === 'true',
    });
    res.json({ items: items.map(toNotificationJson), unreadCount });
  });

  router.post('/read-all', async (req, res) => {
    await markAllNotificationsRead(req.user.id);
    res.status(204).end();
  });

  router.post('/:id/read', async (req, res) => {
    await markNotificationRead(req.user.id, req.params.id);
    res.status(204).end();
  });

  return router;
}

/**
 * Provider delivery callbacks. Mounted before sessions and the app-header check; each
 * adapter's parseWebhook authenticates its provider (req.rawBody holds the exact bytes).
 */
export function webhooksRouter() {
  const router = Router();

  router.post('/:provider', async (req, res) => {
    const adapter = getAdapterByProvider(req.params.provider);
    if (!adapter?.parseWebhook) throw notFound();
    const events = (await adapter.parseWebhook(req)) ?? [];
    await applyDeliveryStatuses(events);
    res.status(200).json({ received: events.length });
  });

  return router;
}

/** Failed-message admin for the signed-in admin's branch. */
export function adminOutboxRouter() {
  const router = Router();
  router.use(requirePermission('system.monitor'));

  const listQuery = z.strictObject({ status: z.enum(OUTBOX_STATUSES).optional() });

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const items = await listOutbox(req.user.branchId, req.validatedQuery);
    res.json({ items: items.map(toOutboxJson) });
  });

  router.post('/:id/retry', async (req, res) => {
    await retryOutboxEntry(req.user.branchId, req.params.id);
    res.status(204).end();
  });

  return router;
}
