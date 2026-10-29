import { test, expect, vi, afterEach } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { clock } from '../src/clock.js';
import { withTransaction } from '../src/core/db.js';
import { AuditLog } from '../src/core/audit/model.js';
import { assertPeriodOpen, isPeriodLocked, lockPeriod } from '../src/modules/periods/service.js';

useTestDb();
const app = buildTestApp();

// "Now" is 15 Nov 2026 (IST): October is finished, November is running.
const NOW = new Date('2026-11-15T06:00:00Z');
const LAST = '2026-10';
afterEach(() => vi.restoreAllMocks());
const freeze = () => vi.spyOn(clock, 'now').mockReturnValue(NOW);

const admin = () => loginAs(app, { roles: ['admin'] });

test('an admin locks a finished month and unlocks it with a reason', async () => {
  freeze();
  const { agent, user } = await admin();
  const locked = await agent.post(`/v1/period-locks/${LAST}/lock`).send({ note: 'GSTR-1 filed' });
  expect(locked.status).toBe(200);
  expect(locked.body).toMatchObject({ month: LAST, locked: true, note: 'GSTR-1 filed', canLock: false, lockedBy: { id: String(user._id), name: user.name } });
  expect(await isPeriodLocked(user.branchId, LAST)).toBe(true);

  const unlocked = await agent.post(`/v1/period-locks/${LAST}/unlock`).send({ reason: 'Late credit note' });
  expect(unlocked.status).toBe(200);
  expect(unlocked.body).toMatchObject({ month: LAST, locked: false, lockedBy: null, canLock: true });
  expect(unlocked.body.history.map((h) => h.action)).toEqual(['lock', 'unlock']);
  expect(unlocked.body.history[1]).toMatchObject({ reason: 'Late credit note', by: { id: String(user._id) } });

  const entries = await AuditLog.find({ entityType: 'period_lock' }).sort({ seq: 1 }).lean();
  expect(entries.map((e) => e.action)).toEqual(['lock', 'unlock']);
});

test('the running month cannot be locked', async () => {
  freeze();
  const { agent } = await admin();
  const r = await agent.post('/v1/period-locks/2026-11/lock').send({});
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('PERIOD_NOT_ENDED');
});

test('locking twice is refused, and unlocking an open month too', async () => {
  freeze();
  const { agent } = await admin();
  expect((await agent.post(`/v1/period-locks/${LAST}/unlock`).send({ reason: 'Oops' })).body.error.code).toBe('NOT_LOCKED');
  await agent.post(`/v1/period-locks/${LAST}/lock`).send({});
  const again = await agent.post(`/v1/period-locks/${LAST}/lock`).send({});
  expect(again.status).toBe(422);
  expect(again.body.error.code).toBe('ALREADY_LOCKED');
});

test('operations and designers cannot lock', async () => {
  freeze();
  for (const role of ['operations', 'designer']) {
    const { agent } = await loginAs(app, { roles: [role] });
    expect((await agent.post(`/v1/period-locks/${LAST}/lock`).send({})).status).toBe(403);
    expect((await agent.post(`/v1/period-locks/${LAST}/unlock`).send({ reason: 'x' })).status).toBe(403);
    expect((await agent.get('/v1/period-locks')).status).toBe(403);
  }
});

test('a locked month refuses writes dated in it', async () => {
  freeze();
  const { user } = await admin();
  await lockPeriod(user.branchId, LAST, { note: '' }, { userId: user._id });
  const err = await withTransaction((s) => assertPeriodOpen(user.branchId, `${LAST}-15`, s)).catch((e) => e);
  expect(err).toMatchObject({ status: 422, code: 'PERIOD_LOCKED', message: 'This month is locked for filing', details: { month: LAST } });
});

test('an open month allows writes', async () => {
  freeze();
  const { user } = await admin();
  await expect(withTransaction((s) => assertPeriodOpen(user.branchId, `${LAST}-15`, s))).resolves.not.toThrow();
  await expect(withTransaction((s) => assertPeriodOpen(user.branchId, '2026-11-15', s))).resolves.not.toThrow();
  await expect(assertPeriodOpen(user.branchId, '2026-11-15')).rejects.toThrow(/transaction/);
});

test('a lock taken during a write makes the write retry and refuse', async () => {
  freeze();
  const { user } = await admin();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  let runs = 0;
  const write = withTransaction(async (s) => {
    runs += 1;
    // The write reads something first, which fixes its snapshot before the lock commits.
    await isPeriodLocked(user.branchId, '2026-09', s);
    started();
    await gate;
    await assertPeriodOpen(user.branchId, `${LAST}-15`, s);
  }).catch((e) => e);
  await running;
  await lockPeriod(user.branchId, LAST, { note: '' }, { userId: user._id });
  release();
  expect(await write).toMatchObject({ status: 422, code: 'PERIOD_LOCKED' });
  expect(runs).toBe(2);
});

test('a lock waits for a write that already checked the month', async () => {
  freeze();
  const { user } = await admin();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const write = withTransaction(async (s) => {
    await assertPeriodOpen(user.branchId, `${LAST}-15`, s);
    started();
    await gate;
    return 'written';
  });
  await running;
  const lock = lockPeriod(user.branchId, LAST, { note: '' }, { userId: user._id });
  release();
  // The write was first, so it stands; the lock then goes through and later writes are refused.
  expect(await write).toBe('written');
  await lock;
  const later = await withTransaction((s) => assertPeriodOpen(user.branchId, `${LAST}-20`, s)).catch((e) => e);
  expect(later.code).toBe('PERIOD_LOCKED');
});

test('months are listed for a financial year', async () => {
  freeze();
  const { agent } = await admin();
  await agent.post(`/v1/period-locks/${LAST}/lock`).send({ note: 'Filed' });
  const r = await agent.get('/v1/period-locks').query({ fy: '2026-27' });
  expect(r.status).toBe(200);
  expect(r.body.fy).toBe('2026-27');
  expect(r.body.months.map((m) => m.month)).toEqual([
    '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
  ]);
  const byMonth = Object.fromEntries(r.body.months.map((m) => [m.month, m]));
  expect(byMonth['2026-10']).toMatchObject({ locked: true, canLock: false, note: 'Filed' });
  expect(byMonth['2026-09']).toMatchObject({ locked: false, canLock: true, lockedBy: null, history: [] });
  expect(byMonth['2026-11'].canLock).toBe(false);
  expect((await agent.get('/v1/period-locks')).body.fy).toBe('2026-27');
  expect((await agent.get('/v1/period-locks').query({ fy: '2026-30' })).status).toBe(400);
});
