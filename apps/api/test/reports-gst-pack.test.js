import { test, expect, vi, afterEach } from 'vitest';
import { atIstTime } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { clock } from '../src/clock.js';
import { Branch } from '../src/modules/branches/model.js';
import { Outbox } from '../src/core/notify/models.js';
import { deliverDue } from '../src/core/notify/deliver.js';
import { registerAdapter, resetAdapters } from '../src/core/notify/adapters/registry.js';
import { ReportRun } from '../src/modules/reports/model.js';
import { queueMonthlyPacks } from '../src/modules/reports/gstPack.js';
import { runPendingReports } from '../src/modules/reports/service.js';
import * as gst from '../src/modules/reports/builders/gst.js';
import { getBuilder, registerBuilder } from '../src/modules/reports/builders/index.js';

useTestDb();
const app = buildTestApp();
const storage = app.locals.storage;

afterEach(() => {
  vi.restoreAllMocks();
  resetAdapters();
});

const at = (ymd, hhmm) => vi.spyOn(clock, 'now').mockReturnValue(new Date(atIstTime(ymd, hhmm)));

async function setup() {
  const admin = await loginAs(app, { roles: ['admin'] });
  await Branch.updateOne({}, { gstin: '29ABCDE1234F1Z5', stateCode: '29' });
  return { admin, branchId: String(admin.user.branchId) };
}
const packs = () => ReportRun.find({ kind: 'gst_pack' }).sort({ createdAt: 1 }).lean();

test('on the 2nd at 9 the previous month\'s pack is prepared and emailed with two files', async () => {
  const { admin } = await setup();
  at('2026-11-02', '09:00');
  expect(await queueMonthlyPacks()).toEqual({ queued: 1 });
  await runPendingReports({ storage });
  const [run] = await packs();
  expect(run).toMatchObject({ source: 'schedule', status: 'done', params: { month: '2026-10' }, requestedBy: null });
  expect(run.file.filename).toBe('GST files October 2026.xlsx');
  expect(run.extraFiles.map((f) => f.filename)).toEqual(['GST summary and registers October 2026.xlsx']);

  const rows = await Outbox.find({ event: 'reports.gst_pack' }).lean();
  expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'in_app']);
  const email = rows.find((r) => r.channel === 'email');
  expect(email.attachments.map((a) => a.key)).toEqual([run.file.key, run.extraFiles[0].key]);
  expect(email.vars).toMatchObject({ month: 'October 2026', monthShort: 'Oct 2026', link: '/accounts' });
  expect(email.dedupeKey).toMatch(/^reports.gst_pack:gst_pack:2026-10:1:email:user:/);
  expect(email.recipient).toMatchObject({ kind: 'user', id: String(admin.user._id) });

  const send = vi.fn(async () => ({ providerMessageId: 'm1', status: 'sent' }));
  registerAdapter({ channel: 'email', provider: 'fake', capabilities: { attachments: true, templatesOnly: false }, send });
  await deliverDue({ now: new Date(email.scheduledFor.getTime() + 60_000), storage });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].attachments).toHaveLength(2);
});

test('before 9 on the 2nd nothing is queued', async () => {
  await setup();
  at('2026-11-02', '08:45');
  expect(await queueMonthlyPacks()).toEqual({ queued: 0 });
  at('2026-11-01', '23:59');
  expect(await queueMonthlyPacks()).toEqual({ queued: 0 });
  expect(await packs()).toEqual([]);
  // Later in the month it still catches up, once.
  at('2026-11-05', '10:00');
  expect(await queueMonthlyPacks()).toEqual({ queued: 1 });
});

test('running the job again sends nothing twice', async () => {
  await setup();
  at('2026-11-02', '09:15');
  await queueMonthlyPacks();
  await runPendingReports({ storage });
  at('2026-11-02', '09:30');
  expect(await queueMonthlyPacks()).toEqual({ queued: 0 });
  await runPendingReports({ storage });
  expect(await packs()).toHaveLength(1);
  expect(await Outbox.countDocuments({ event: 'reports.gst_pack', channel: 'email' })).toBe(1);
});

test('a pack that fails tells the owner', async () => {
  await setup();
  const real = getBuilder('gst_pack');
  registerBuilder('gst_pack', async () => {
    throw new Error('boom');
  });
  try {
    at('2026-11-02', '09:00');
    await queueMonthlyPacks();
    await runPendingReports({ storage });
  } finally {
    registerBuilder('gst_pack', real);
  }
  const [run] = await packs();
  expect(run).toMatchObject({ status: 'failed', error: { code: 'REPORT_FAILED' } });
  const failed = await Outbox.find({ event: 'reports.gst_pack_failed' }).lean();
  expect(failed.map((r) => r.channel).sort()).toEqual(['email', 'in_app']);
  expect(failed[0].vars).toMatchObject({ month: 'October 2026', link: '/reports' });
  expect(await Outbox.countDocuments({ event: 'reports.gst_pack' })).toBe(0);
});

test('the 1 April pack covers March of the previous financial year', async () => {
  await setup();
  at('2027-04-02', '09:00');
  await queueMonthlyPacks();
  const [run] = await packs();
  expect(run.params.month).toBe('2027-03');
});

test('a pack made by hand does not stop the scheduled one, and is not emailed', async () => {
  const { admin } = await setup();
  at('2026-11-02', '08:00');
  const r = await admin.agent.post('/v1/reports').set('Idempotency-Key', 'hand-pack').send({ kind: 'gst_pack', format: 'xlsx', params: { month: '2026-10' } });
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  await runPendingReports({ storage });
  for (let i = 0; i < 50 && (await ReportRun.findById(r.body.report.id).lean()).status !== 'done'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  expect(await Outbox.countDocuments({ event: 'reports.gst_pack' })).toBe(0);
  at('2026-11-02', '09:00');
  expect(await queueMonthlyPacks()).toEqual({ queued: 1 });
  await runPendingReports({ storage });
  expect((await packs()).map((p) => p.source)).toEqual(['manual', 'schedule']);
  expect(await Outbox.countDocuments({ event: 'reports.gst_pack', channel: 'email' })).toBe(1);
  expect(typeof gst.gstMonthDocs).toBe('function');
});
