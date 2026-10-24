// pm2 process file: `pm2 startOrReload deploy/ecosystem.config.cjs` from the repo root.
// Configuration comes from the repo-root .env (written from SSM by remote-deploy.sh), which
// the apps load themselves through loadConfig().
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

const common = {
  cwd: repoRoot,
  instances: 1,
  exec_mode: 'fork',
  max_memory_restart: '600M',
  env: { NODE_ENV: 'production' },
  time: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'vs-api',
      script: 'apps/api/src/server.js',
    },
    {
      ...common,
      name: 'vs-worker',
      script: 'apps/api/src/worker.js',
      // The worker waits up to 30 s for running jobs before exiting.
      kill_timeout: 35000,
    },
  ],
};
