// Appointment reminders, run every 15 minutes: a day before (for appointments booked more than a
// day ahead) and two hours before (for those booked more than two hours ahead). The two-hour
// reminder leaves the client out while their channel is in quiet hours (it would arrive too late
// if held); the designer still gets it. Dedupe keys carry the start time, so re-runs send nothing
// twice and a moved appointment is reminded again.
import { reminderDue } from '@vs/shared';
import { clock } from '../../clock.js';
import { withTransaction } from '../../core/db.js';
import { getQuietHours, getRule } from '../../core/notify/catalog.js';
import { nextAllowedTime } from '../../core/notify/quietHours.js';
import { logger } from '../../logger.js';
import { listBranchIds } from '../branches/service.js';
import { Appointment } from './model.js';
import { emitAppointmentEvent } from './notifications.js';
import { reminderFilter } from './queries.js';

async function clientQuietNow(branchId, now) {
  const [rule, quietHours] = await Promise.all([getRule(branchId, 'appointment.reminder'), getQuietHours(branchId)]);
  return rule.channels.some((channel) => nextAllowedTime(now, quietHours[channel] ?? null) > now);
}

async function remindBranch(branchId, now) {
  const due = (await Appointment.find(reminderFilter(branchId, now)).lean())
    .map((a) => ({ a, kind: reminderDue({ start: a.start, scheduledAt: a.scheduledAt, now }) }))
    .filter(({ kind }) => kind);
  if (!due.length) return 0;
  const quiet = await clientQuietNow(branchId, now);
  let queued = 0;
  for (const { a, kind } of due) {
    queued += await withTransaction(async (session) => {
      // Cancelled or moved since the scan read it: nothing to remind.
      const still = await Appointment.exists({ _id: a._id, status: 'booked', start: a.start }).session(session);
      if (!still) return 0;
      return emitAppointmentEvent(
        'appointment.reminder',
        a,
        {
          refId: `${a._id}:${a.start.toISOString()}`,
          sequence: kind === 'day' ? 1 : 2,
          includeClient: kind === 'day' || !quiet,
          now,
        },
        session,
      );
    });
  }
  return queued;
}

/** Queues the reminders now due in every branch; returns how many messages were queued. */
export async function runAppointmentReminders() {
  const now = clock.now();
  let queued = 0;
  for (const branchId of await listBranchIds()) queued += await remindBranch(branchId, now);
  logger.info({ queued }, 'appointment reminders checked');
  return { queued };
}
