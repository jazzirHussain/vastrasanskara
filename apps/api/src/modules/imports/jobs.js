import { defineJob } from '../../core/jobs/registry.js';
import { runPendingImports } from './service.js';

// Every minute: check and add the files too large to handle at once, and continue interrupted ones.
defineJob('imports-run', { schedule: '1 minute', quiet: true, handler: ({ storage }) => runPendingImports({ storage }) });
