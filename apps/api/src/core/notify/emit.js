import { clock } from '../../clock.js';
import { CHANNEL_ADDRESS, getQuietHours, getRule } from './catalog.js';
import { Branch } from '../../modules/branches/model.js';
import { Outbox } from './models.js';
import { nextAllowedTime } from './quietHours.js';
import { resolveRecipients } from './recipients.js';

function skipReasonFor(recipient, channel, address) {
  if (recipient.kind === 'client' && recipient.consent?.[channel] !== true) return 'no_consent';
  if (!address) return 'no_address';
  return null;
}

async function uniqueRecipients(roles, args) {
  const byKey = new Map();
  for (const role of roles) {
    for (const r of await resolveRecipients(role, args)) byKey.set(`${r.kind}:${r.id}`, r);
  }
  return [...byKey.values()];
}

/**
 * Queues an event's messages in the outbox, one per recipient × channel. Pass the caller's
 * transaction session so messages exist only if the business change commits. Entries are
 * deduplicated by event:refId:sequence:channel:kind:id; returns how many were new.
 */
export async function emit(
  event,
  { branchId, refId, sequence = 1, data = {}, vars = {}, attachments = [] },
  { session } = {},
) {
  const rule = await getRule(branchId, event, session);
  if (!rule.enabled) return 0;

  const now = clock.now();
  const quietHours = await getQuietHours(branchId, session);
  const recipients = await uniqueRecipients(rule.recipients, { branchId, data, session });

  let created = 0;
  for (const recipient of recipients) {
    for (const channel of rule.channels) {
      const address = recipient.addresses?.[CHANNEL_ADDRESS[channel]] ?? null;
      const skipReason = skipReasonFor(recipient, channel, address);
      // Staff messages are never held; client messages wait out the channel's quiet hours.
      const scheduledFor =
        recipient.kind === 'client' ? nextAllowedTime(now, quietHours[channel] ?? null) : now;
      const dedupeKey = [event, refId, sequence, channel, recipient.kind, recipient.id].join(':');

      const result = await Outbox.updateOne(
        { dedupeKey },
        {
          $setOnInsert: {
            branchId: String(branchId),
            event,
            channel,
            recipient: {
              kind: recipient.kind,
              id: String(recipient.id),
              name: recipient.name ?? '',
              address,
              addresses: recipient.addresses ?? {},
            },
            vars,
            attachments,
            scheduledFor,
            status: skipReason ? 'skipped' : 'pending',
            skipReason,
            attempts: 0,
            isFallback: false,
            dedupeKey,
          },
        },
        { upsert: true, session },
      );
      created += result.upsertedCount;
    }
  }
  return created;
}

/** Emits a system event to every branch (e.g. backup or job failures, which have no branch). */
export async function emitToAllBranches(event, { refId, vars = {} }) {
  const branches = await Branch.find({}, { _id: 1 }).lean();
  for (const { _id: branchId } of branches) await emit(event, { branchId, refId, vars });
}
