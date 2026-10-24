import { defineJob } from '../jobs/registry.js';
import { deliverDue } from './deliver.js';

// Sends due outbox messages every minute.
defineJob('deliver-outbox', { schedule: '1 minute', handler: ({ storage }) => deliverDue({ storage }) });
