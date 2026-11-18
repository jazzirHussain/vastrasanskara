import { test, expect } from 'vitest';
import { waitReady } from '../src/cli/wait-ready.js';

function fakeClock() {
  let t = Date.UTC(2026, 10, 18, 6, 0, 0);
  return { now: () => new Date(t), sleep: async (ms) => { t += ms; } };
}

test('ready when the new worker reports and health is ok', async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await waitReady({
    release: 'new',
    readHeartbeat: async () => ({ at: clock.now(), release: ++calls < 3 ? 'old' : 'new' }),
    fetchHealth: async () => 200,
    ...clock,
  });
  expect(result).toEqual({ ok: true, message: 'Release new is running' });
});

test('waiting for a release fails when the new worker never reports', async () => {
  const clock = fakeClock();
  const result = await waitReady({
    release: 'new', readHeartbeat: async () => ({ at: clock.now(), release: 'old' }), fetchHealth: async () => 200, ...clock,
  });
  expect(result).toEqual({ ok: false, message: 'The new worker did not report within 120 s' });
});

test('an old heartbeat from the new release does not count', async () => {
  const clock = fakeClock();
  const stale = new Date(clock.now().getTime() - 4 * 60 * 1000);
  const result = await waitReady({ release: 'new', readHeartbeat: async () => ({ at: stale, release: 'new' }), fetchHealth: async () => 200, ...clock });
  expect(result.ok).toBe(false);
});

test('a failing health check fails the wait', async () => {
  const clock = fakeClock();
  const result = await waitReady({
    release: 'new', readHeartbeat: async () => ({ at: clock.now(), release: 'new' }), fetchHealth: async () => 503, ...clock,
  });
  expect(result).toEqual({ ok: false, message: 'The API health check is failing' });
});
