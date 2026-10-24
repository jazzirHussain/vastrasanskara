import mongoose from 'mongoose';
import { clock } from '../../clock.js';
import { logger } from '../../logger.js';
import { Branch } from '../../modules/branches/model.js';
import { getAdapter } from './adapters/registry.js';
import { CHANNEL_ADDRESS, getEventDefinition, getRule } from './catalog.js';
import { renderEmail } from './emailLayout.js';
import { NotificationTemplate, Outbox } from './models.js';
import { renderTemplate } from './render.js';

export const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [1, 5, 15, 60];
const STALE_LOCK_MS = 10 * 60 * 1000;
const DEFAULT_BRANCH = { name: 'Vastrasanskara', phone: null, email: null };

// A problem no retry can fix (missing template or variable): fail at once.
class RenderError extends Error {}

const validId = (id) => mongoose.isValidObjectId(id);

async function templateFor(entry) {
  if (validId(entry.branchId)) {
    const override = await NotificationTemplate.findOne({
      branchId: entry.branchId,
      event: entry.event,
      channel: entry.channel,
    }).lean();
    if (override) return override;
  }
  const template = getEventDefinition(entry.event).templates?.[entry.channel];
  if (!template) throw new RenderError(`No template for ${entry.event} on ${entry.channel}`);
  return template;
}

async function buildMessage(entry, storage) {
  const template = await templateFor(entry);
  const vars = entry.vars ?? {};
  let subject;
  let text;
  try {
    subject = template.subject ? renderTemplate(template.subject, vars) : undefined;
    text = renderTemplate(template.body, vars);
  } catch (err) {
    throw new RenderError(err.message);
  }

  const message = {
    to: entry.recipient.address,
    subject,
    text,
    attachments: [],
    event: entry.event,
    vars,
    branchId: entry.branchId,
  };
  if (entry.channel === 'email') {
    const branch = (validId(entry.branchId) && (await Branch.findById(entry.branchId).lean())) || DEFAULT_BRANCH;
    Object.assign(message, renderEmail({ branch, subject, body: text }));
  }
  const adapter = getAdapter(entry.channel);
  if (entry.attachments?.length && adapter?.capabilities.attachments) {
    if (!storage) throw new Error('Attachments need file storage');
    message.attachments = await Promise.all(
      entry.attachments.map(async ({ key, filename }) => ({ filename, content: await storage.getObject(key) })),
    );
  }
  return message;
}

// After the last failed attempt, queue the same message on the rule's fallback channel.
async function queueFallback(entry, now) {
  if (entry.isFallback) return;
  const rule = await getRule(entry.branchId, entry.event);
  if (!rule.fallback || rule.fallback === entry.channel) return;
  const address = entry.recipient.addresses?.[CHANNEL_ADDRESS[rule.fallback]] ?? null;
  const skipReason = !address ? 'no_address' : null;
  const dedupeKey = `${entry.dedupeKey}:fallback`;
  await Outbox.updateOne(
    { dedupeKey },
    {
      $setOnInsert: {
        branchId: entry.branchId,
        event: entry.event,
        channel: rule.fallback,
        recipient: { ...entry.recipient, address },
        vars: entry.vars,
        attachments: entry.attachments,
        scheduledFor: now,
        status: skipReason ? 'skipped' : 'pending',
        skipReason,
        attempts: 0,
        isFallback: true,
        dedupeKey,
      },
    },
    { upsert: true },
  );
}

// Clears the event's secret vars (e.g. a password link) once the entry is final.
function unsetSecrets(entry) {
  const names = getEventDefinition(entry.event).secretVars ?? [];
  return names.length ? { $unset: Object.fromEntries(names.map((n) => [`vars.${n}`, ''])) } : {};
}

function claimNext(now) {
  return Outbox.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', scheduledFor: { $lte: now } },
        { status: 'sending', lockedAt: { $lt: new Date(now.getTime() - STALE_LOCK_MS) } },
      ],
    },
    { $set: { status: 'sending', lockedAt: now } },
    { sort: { scheduledFor: 1 }, new: true },
  ).lean();
}

/**
 * Sends due outbox entries. Each entry is claimed atomically (pending → sending), so
 * concurrent runs never send the same entry twice; entries stuck in `sending` for 10 minutes
 * (a crashed worker) are reclaimed. Failures retry after 1, 5, 15 and 60 minutes, then fail
 * and fall back to the rule's fallback channel.
 */
export async function deliverDue({ now = clock.now(), limit = 50, storage } = {}) {
  const result = { sent: 0, retried: 0, failed: 0 };

  for (let i = 0; i < limit; i++) {
    const entry = await claimNext(now);
    if (!entry) break;
    const attempts = entry.attempts + 1;
    const mine = { _id: entry._id, status: 'sending', lockedAt: now };
    // Who and what, never the address (personal data).
    const about = {
      outboxId: String(entry._id),
      channel: entry.channel,
      event: entry.event,
      recipient: `${entry.recipient.kind}:${entry.recipient.id}`,
    };

    try {
      const adapter = getAdapter(entry.channel);
      const message = await buildMessage(entry, storage);
      if (!adapter) throw new Error(`No adapter for channel ${entry.channel}`);
      const { providerMessageId, status } = await adapter.send(message);
      await Outbox.updateOne(mine, {
        $set: {
          status: status === 'delivered' ? 'delivered' : 'sent',
          providerMessageId: providerMessageId ?? null,
          sentAt: now,
          deliveredAt: status === 'delivered' ? now : null,
          attempts,
          lastError: null,
          lockedAt: null,
        },
        ...unsetSecrets(entry),
      });
      result.sent += 1;
      const outcome = status === 'delivered' ? 'delivered' : 'sent';
      logger.info({ ...about, providerMessageId }, `${outcome} ${entry.channel} ${entry.event} → ${about.recipient}`);
    } catch (err) {
      const finalFailure = err instanceof RenderError || attempts >= MAX_ATTEMPTS;
      const retryAt = new Date(now.getTime() + BACKOFF_MINUTES[attempts - 1] * 60_000);
      await Outbox.updateOne(
        mine,
        finalFailure
          ? { $set: { status: 'failed', attempts, lastError: err.message, lockedAt: null }, ...unsetSecrets(entry) }
          : {
              $set: {
                status: 'pending',
                attempts,
                lastError: err.message,
                lockedAt: null,
                scheduledFor: retryAt,
              },
            },
      );
      if (!finalFailure) {
        result.retried += 1;
        logger.warn(
          { ...about, attempts, error: err.message, retryAt },
          `${entry.channel} ${entry.event} failed (attempt ${attempts}), retrying at ${retryAt.toISOString()}`,
        );
      } else {
        result.failed += 1;
        logger.error(
          { ...about, attempts, error: err.message },
          `${entry.channel} ${entry.event} failed permanently after ${attempts} attempt(s): ${err.message}`,
        );
        if (!(err instanceof RenderError)) await queueFallback(entry, now);
      }
    }
  }
  return result;
}
