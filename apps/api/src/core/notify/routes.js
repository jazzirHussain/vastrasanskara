import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { clock } from '../../clock.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { conflict, notFound } from '../errors.js';
import { validate } from '../validate.js';
import { getAdapterByProvider } from './adapters/registry.js';
import { Notification, OUTBOX_STATUSES, Outbox } from './models.js';

const findableId = (id) => {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  return id;
};

/** The signed-in user's in-app notifications (the bell). */
export function notificationsRouter() {
  const router = Router();
  router.use(requireAuth);

  const listQuery = z.strictObject({ unread: z.enum(['true', 'false']).optional() });

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const userId = req.user.id;
    const filter = { userId, ...(req.validatedQuery.unread === 'true' && { read: false }) };
    const [docs, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1, _id: -1 }).limit(50).lean(),
      Notification.countDocuments({ userId, read: false }),
    ]);
    const items = docs.map((n) => ({
      id: String(n._id),
      event: n.event,
      message: n.message,
      link: n.link,
      read: n.read,
      createdAt: n.createdAt,
    }));
    res.json({ items, unreadCount });
  });

  router.post('/read-all', async (req, res) => {
    await Notification.updateMany({ userId: req.user.id, read: false }, { $set: { read: true } });
    res.status(204).end();
  });

  router.post('/:id/read', async (req, res) => {
    const result = await Notification.updateOne(
      { _id: findableId(req.params.id), userId: req.user.id },
      { $set: { read: true } },
    );
    if (result.matchedCount === 0) throw notFound();
    res.status(204).end();
  });

  return router;
}

// Webhook statuses only move a message forward: a late "sent" never undoes "delivered".
const ALLOWED_FROM = {
  sent: ['sending'],
  delivered: ['sending', 'sent'],
  failed: ['sending', 'sent'],
};

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

    for (const { providerMessageId, status, at, error } of events) {
      const from = ALLOWED_FROM[status];
      if (!providerMessageId || !from) continue;
      const when = at ? new Date(at) : clock.now();
      const set = { status };
      if (status === 'delivered') set.deliveredAt = when;
      if (status === 'failed') set.lastError = error ?? 'Reported failed by provider';
      await Outbox.updateOne({ providerMessageId, status: { $in: from } }, { $set: set });
    }
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
    const { status } = req.validatedQuery;
    const docs = await Outbox.find({ branchId: req.user.branchId, ...(status && { status }) })
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .lean();
    const items = docs.map(({ _id, __v: _v, ...rest }) => ({ id: String(_id), ...rest }));
    res.json({ items });
  });

  router.post('/:id/retry', async (req, res) => {
    const entry = await Outbox.findOne({ _id: findableId(req.params.id), branchId: req.user.branchId }).lean();
    if (!entry) throw notFound();
    const result = await Outbox.updateOne(
      { _id: entry._id, status: 'failed' },
      { $set: { status: 'pending', attempts: 0, scheduledFor: clock.now(), lockedAt: null } },
    );
    if (result.matchedCount === 0) throw conflict('NOT_RETRYABLE', 'Only failed messages can be retried');
    res.status(204).end();
  });

  return router;
}
