import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { logger } from './logger.js';

// Task 6 adds connectDb before listening.
const config = loadConfig();
const app = createApp({ config });

app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'api listening');
});
