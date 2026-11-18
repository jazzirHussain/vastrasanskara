import { defineJob } from './registry.js';
import { recordHeartbeat } from './service.js';

// The worker's liveness signal, read by /v1/health.
defineJob('heartbeat', { schedule: '1 minute', quiet: true, handler: ({ config } = {}) => recordHeartbeat({ release: config?.release }) });
