// After a deploy reloads the processes, waits until the new worker reports with this release
// and the API answers its health check; exits 1 otherwise so the deploy fails loudly:
//   node apps/api/src/cli/wait-ready.js <release-sha>
import { isMain } from './isMain.js';

const FRESH_MS = 3 * 60 * 1000;

/**
 * Polls until `readHeartbeat()` shows `release` with a heartbeat under 3 minutes old and
 * `fetchHealth()` returns 200. Clock functions are injectable for tests.
 */
export async function waitReady({
  release,
  timeoutMs = 120_000,
  intervalMs = 3000,
  readHeartbeat,
  fetchHealth,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = now().getTime() + timeoutMs;
  let workerReady = false;
  for (;;) {
    const heartbeat = await readHeartbeat().catch(() => null);
    workerReady = Boolean(heartbeat && heartbeat.release === release && now().getTime() - new Date(heartbeat.at).getTime() < FRESH_MS);
    if (workerReady) {
      const status = await fetchHealth().catch(() => 0);
      if (status === 200) return { ok: true, message: `Release ${release} is running` };
    }
    if (now().getTime() >= deadline) break;
    await sleep(intervalMs);
  }
  return workerReady
    ? { ok: false, message: 'The API health check is failing' }
    : { ok: false, message: `The new worker did not report within ${Math.round(timeoutMs / 1000)} s` };
}

if (isMain(import.meta.url)) {
  const release = process.argv[2];
  if (!release) {
    console.error('Usage: node apps/api/src/cli/wait-ready.js <release-sha>');
    process.exit(2);
  }
  const { loadConfig } = await import('../config.js');
  const { connectDb, disconnectDb } = await import('../core/db.js');
  const { readHeartbeat } = await import('../core/jobs/service.js');
  const config = loadConfig();
  await connectDb(config.mongoUri, { dnsServers: config.dnsServers, autoIndex: false });
  const fetchHealth = async () => (await fetch(`http://127.0.0.1:${config.port}/v1/health`)).status;
  const result = await waitReady({ release, readHeartbeat, fetchHealth });
  await disconnectDb();
  console[result.ok ? 'log' : 'error'](result.message);
  process.exit(result.ok ? 0 : 1);
}
