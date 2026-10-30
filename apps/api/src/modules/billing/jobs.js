import { defineJob } from '../../core/jobs/registry.js';
import { runDailyBillingChecks } from './daily.js';
import { renderPendingPdfs } from './pdfs.js';

// Every minute: render the PDFs that issued documents are waiting for.
defineJob('billing-pdfs', { schedule: '1 minute', quiet: true, handler: ({ storage }) => renderPendingPdfs({ storage }) });

// Every 15 minutes (IST): overdue reminders after 10:00 and the collections summary at closing
// time; messages are deduplicated per day, so re-runs and restarts send nothing twice.
defineJob('billing-daily', { schedule: '*/15 * * * *', handler: () => runDailyBillingChecks() });
