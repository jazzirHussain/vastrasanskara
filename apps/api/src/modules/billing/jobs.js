import { defineJob } from '../../core/jobs/registry.js';
import { renderPendingPdfs } from './pdfs.js';

// Every minute: render the PDFs that issued documents are waiting for.
defineJob('billing-pdfs', { schedule: '1 minute', quiet: true, handler: ({ storage }) => renderPendingPdfs({ storage }) });
