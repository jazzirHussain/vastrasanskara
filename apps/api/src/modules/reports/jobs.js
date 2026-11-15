import { defineJob } from '../../core/jobs/registry.js';
import { runPendingReports } from './service.js';

// Every minute: build the queued report files (year-long and other heavy kinds wait for this).
defineJob('reports-run', { schedule: '1 minute', quiet: true, handler: ({ storage }) => runPendingReports({ storage }) });
