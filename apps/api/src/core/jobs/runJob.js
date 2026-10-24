import { istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { logger } from '../../logger.js';
import { Branch } from '../../modules/branches/model.js';
import { emit } from '../notify/emit.js';
import { getJobDefinition } from './registry.js';
import { recordJobFailure } from './service.js';

const RETRY_MINUTES = [1, 5, 15];

// One alert per job per IST day per branch (the outbox dedupes on refId).
async function alertOwners(job, message, now) {
  const branches = await Branch.find({}, { _id: 1 }).lean();
  for (const { _id: branchId } of branches) {
    await emit('system.job_failed', {
      branchId,
      refId: `${job}:${istDate(now)}`,
      vars: { job, error: message },
    });
  }
}

/**
 * Runs a job's handler. A failure never throws: it is recorded in jobFailures, the owners
 * are alerted, and a one-off job with retries left is scheduled again.
 * ctx: { agenda?, attempt = 1, ...whatever the handler needs (storage, config) }.
 */
export async function runJob(name, ctx = {}) {
  const definition = getJobDefinition(name);
  const attempt = ctx.attempt ?? 1;
  try {
    await definition.handler(ctx);
    return { ok: true };
  } catch (err) {
    const now = clock.now();
    logger.error({ err, job: name, attempt }, 'job failed');
    try {
      await recordJobFailure({ job: name, error: err.message, attempt });
      await alertOwners(name, err.message, now);
      if (ctx.agenda && attempt <= definition.retries) {
        const runAt = new Date(now.getTime() + RETRY_MINUTES[Math.min(attempt, RETRY_MINUTES.length) - 1] * 60_000);
        await ctx.agenda.schedule(runAt, name, { attempt: attempt + 1 });
      }
    } catch (reportErr) {
      logger.error({ err: reportErr, job: name }, 'could not record job failure');
    }
    return { ok: false };
  }
}
