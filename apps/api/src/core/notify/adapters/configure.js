import { createFileEmailAdapter } from './emailFile.js';
import { createSesEmailAdapter } from './emailSes.js';
import { createInAppAdapter } from './inApp.js';
import { registerAdapter } from './registry.js';

/** Registers the shipped adapters from config; called at startup by server.js and worker.js. */
export function registerConfiguredAdapters(config, storage) {
  registerAdapter(createInAppAdapter());
  registerAdapter(
    config.mail.adapter === 'ses'
      ? createSesEmailAdapter({ region: config.aws.region, from: config.mail.from, storage })
      : createFileEmailAdapter({ dir: config.mail.fileDir, from: config.mail.from }),
  );
}
