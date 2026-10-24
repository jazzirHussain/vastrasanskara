import { istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { logger } from '../../logger.js';
import { emitToAllBranches } from '../notify/emit.js';
import { getJobDefinition } from './registry.js';
import { recordJobFailure } from './service.js';

const RETRY_MINUTES = [1, 5, 15];

/**
 * Runs a job's handler. A failure never throws: it is recorded in jobFailures, the owners
 * are alerted (once per job per IST day), and a one-off job with retries left is scheduled
 * again. ctx: { agenda?, attempt = 1, ...whatever the handler needs (storage, config) }.
 */
export async function runJob(name, ctx = {}) {
  const definition = getJobDefinition(name);
  const attempt = ctx.attempt ?? 1;
  const started = Date.now();
  try {
    await definition.handler(ctx);
    const ms = Date.now() - started;
    logger[definition.quiet ? 'debug' : 'info']({ job: name, attempt, ms }, `job ${name} done in ${ms}ms`);
    return { ok: true };
  } catch (err) {
    const now = clock.now();
    logger.error({ err, job: name, attempt, ms: Date.now() - started }, `job ${name} failed: ${err.message}`);
    try {
      await recordJobFailure({ job: name, error: err.message, attempt });
      await emitToAllBranches('system.job_failed', {
        refId: `${name}:${istDate(now)}`,
        vars: { job: name, error: err.message },
      });
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
