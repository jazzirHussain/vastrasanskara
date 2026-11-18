import { defineJob } from '../../core/jobs/registry.js';
import { queueMonthlyPacks } from './gstPack.js';
import { runPendingReports } from './service.js';
import './notifications.js';

// Every minute: build the queued report files (year-long and other heavy kinds wait for this).
defineJob('reports-run', { schedule: '1 minute', quiet: true, handler: ({ storage }) => runPendingReports({ storage }) });

// Every 15 minutes: from 09:00 IST on the 2nd, queue last month's GST pack (once per branch).
defineJob('reports-gst-pack', { schedule: '*/15 * * * *', handler: () => queueMonthlyPacks() });
