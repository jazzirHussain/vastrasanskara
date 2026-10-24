import { defineJob } from '../jobs/registry.js';
import { deliverDue } from './deliver.js';

// Sends due outbox messages every minute.
// Quiet: each message sent or failed is logged by deliverDue itself.
defineJob('deliver-outbox', { schedule: '1 minute', quiet: true, handler: ({ storage }) => deliverDue({ storage }) });
