import { spawn } from 'node:child_process';

/** Stops the web server, worker and API started by global-setup.js, then the database. */
export default async function globalTeardown() {
  const state = globalThis.__vsE2E;
  if (!state) return;
  for (const child of state.children) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
  }
  await new Promise((r) => setTimeout(r, 1500));
  await state.replSet.stop();
}
