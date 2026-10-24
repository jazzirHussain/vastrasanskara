import { defineJob } from '../../core/jobs/registry.js';
import { runDailyProductionChecks } from './daily.js';

// Every 15 minutes (IST); each branch is checked once its daily job time has come, and the
// messages are deduplicated per day, so re-runs and restarts send nothing twice.
defineJob('production-daily', { schedule: '*/15 * * * *', handler: () => runDailyProductionChecks() });
