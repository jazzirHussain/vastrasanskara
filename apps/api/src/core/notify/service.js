import mongoose from 'mongoose';
import { clock } from '../../clock.js';
import { conflict, notFound } from '../errors.js';
import { Notification, Outbox } from './models.js';

const findableId = (id) => {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  return id;
};

// ---- In-app notifications (the bell) ----

/** The user's newest 50 notifications (optionally unread only) and their unread count. */
export async function listNotifications(userId, { unreadOnly = false } = {}) {
  const filter = { userId, ...(unreadOnly && { read: false }) };
  const [items, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1, _id: -1 }).limit(50).lean(),
    Notification.countDocuments({ userId, read: false }),
  ]);
  return { items, unreadCount };
}

export async function markNotificationRead(userId, notificationId) {
  const result = await Notification.updateOne(
    { _id: findableId(notificationId), userId },
    { $set: { read: true } },
  );
  if (result.matchedCount === 0) throw notFound();
}

export async function markAllNotificationsRead(userId) {
  await Notification.updateMany({ userId, read: false }, { $set: { read: true } });
}

// ---- Provider delivery statuses (webhooks) ----

// Statuses only move a message forward: a late "sent" never undoes "delivered".
const ALLOWED_FROM = {
  sent: ['sending'],
  delivered: ['sending', 'sent'],
  failed: ['sending', 'sent'],
};

/** Applies statuses parsed from a provider webhook to the matching outbox entries. */
export async function applyDeliveryStatuses(events) {
  for (const { providerMessageId, status, at, error } of events) {
    const from = ALLOWED_FROM[status];
    if (!providerMessageId || !from) continue;
    const set = { status };
    if (status === 'delivered') set.deliveredAt = at ? new Date(at) : clock.now();
    if (status === 'failed') set.lastError = error ?? 'Reported failed by provider';
    await Outbox.updateOne({ providerMessageId, status: { $in: from } }, { $set: set });
  }
}

// ---- Outbox admin ----

/** The branch's newest 100 outbox entries, optionally of one status. */
export function listOutbox(branchId, { status } = {}) {
  return Outbox.find({ branchId: String(branchId), ...(status && { status }) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(100)
    .lean();
}

/** Puts a failed entry of the branch back in the queue to send now. */
export async function retryOutboxEntry(branchId, entryId) {
  const entry = await Outbox.findOne({ _id: findableId(entryId), branchId: String(branchId) }).lean();
  if (!entry) throw notFound();
  const result = await Outbox.updateOne(
    { _id: entry._id, status: 'failed' },
    { $set: { status: 'pending', attempts: 0, scheduledFor: clock.now(), lockedAt: null } },
  );
  if (result.matchedCount === 0) throw conflict('NOT_RETRYABLE', 'Only failed messages can be retried');
}
