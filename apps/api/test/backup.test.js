import { test, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { useTestDb } from './helpers/db.js';
import { createTestUser } from './helpers/app.js';
import { runBackup } from '../src/core/backup/backup.js';
import { checkStorage } from '../src/core/backup/storageCheck.js';
import { mongodumpStream } from '../src/core/backup/mongodump.js';
import { getJobDefinitions } from '../src/core/jobs/registry.js';
import '../src/core/backup/jobs.js';
import { createLocalStorage } from '../src/core/files/storage-local.js';
import { Outbox } from '../src/core/notify/models.js';
useTestDb();
const now = new Date('2026-10-22T04:00:00Z'); // 09:30 IST

test('streams dump to IST-dated key', async () => {
  const puts = [];
  const { key } = await runBackup({ now, dump: () => Readable.from(['abc']), storage: { putObject: async (o) => puts.push(o) } });
  expect(key).toBe('mongodump/2026/10/22/0930.archive.gz');
  expect(puts).toHaveLength(1);
});
test('failure alerts owner', async () => {
  await createTestUser({ roles: ['admin'] });
  await expect(runBackup({ now, dump: () => { throw new Error('no mongodump'); }, storage: {} })).rejects.toThrow();
  expect(await Outbox.countDocuments({ event: 'system.backup_failed' })).toBe(2);
});
test('storage warning at 70%', async () => {
  await createTestUser({ roles: ['admin'] });
  expect(await checkStorage({ usedBytes: 0.69 * 536870912, now })).toMatchObject({ warned: false });
  expect(await checkStorage({ usedBytes: 0.71 * 536870912, now })).toMatchObject({ warned: true });
  expect(await Outbox.countDocuments({ event: 'system.storage_warning' })).toBe(2);
});

// A stand-in for child_process.spawn: emits the given output, then exits with `code`.
function fakeSpawn(chunks, code) {
  const calls = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const configPath = args.find((a) => a.startsWith('--config='))?.slice('--config='.length);
    calls.push({ cmd, args, configAtStart: configPath && readFileSync(configPath, 'utf8') });
    setImmediate(() => {
      for (const c of chunks) child.stdout.write(c);
      child.stdout.end();
      if (code !== 0) child.stderr.end('Failed: connection lost');
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
  return { spawnFn, calls };
}

test('mongodump gets the URI from a private config file, never the command line', async () => {
  const uri = 'mongodb+srv://user:secret@cluster.example.net/db';
  const { spawnFn, calls } = fakeSpawn(['x'], 0);
  const chunks = [];
  for await (const c of mongodumpStream(uri, { spawnFn })) chunks.push(c);
  expect(Buffer.concat(chunks).toString()).toBe('x');
  expect(calls[0].cmd).toBe('mongodump');
  expect(calls[0].args).toEqual(expect.arrayContaining(['--archive', '--gzip']));
  expect(calls[0].args.join(' ')).not.toContain('secret');
  expect(calls[0].configAtStart).toContain(uri);
  const configPath = calls[0].args.find((a) => a.startsWith('--config=')).slice('--config='.length);
  expect(existsSync(configPath)).toBe(false);
});
test('a dump that fails part-way stores nothing and alerts', async () => {
  await createTestUser({ roles: ['admin'] });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-backups-'));
  const storage = createLocalStorage({ dir, apiOrigin: 'http://x', secret: 's' });
  const { spawnFn } = fakeSpawn(['partial-archive'], 1);
  await expect(runBackup({ now, dump: () => mongodumpStream('mongodb://x', { spawnFn }), storage })).rejects.toThrow(/mongodump exited with code 1/);
  expect(readdirSync(dir)).toEqual([]);
  expect(await Outbox.findOne({ event: 'system.backup_failed' }).lean()).toMatchObject({ vars: { error: expect.stringContaining('connection lost') } });
});
test('storage warning goes out once a day with readable numbers', async () => {
  await createTestUser({ roles: ['admin'] });
  await checkStorage({ usedBytes: 400 * 1048576, now });
  await checkStorage({ usedBytes: 410 * 1048576, now });
  const entries = await Outbox.find({ event: 'system.storage_warning' }).lean();
  expect(entries).toHaveLength(2);
  expect(entries[0].vars).toEqual({ usedMb: 400, quotaMb: 512, percent: 78 });
});
test('backup and storage-check jobs are registered on their schedules', () => {
  const jobs = getJobDefinitions();
  expect(jobs.get('backup').schedule).toBe('0 */6 * * *');
  expect(jobs.get('storage-check').schedule).toBe('0 9 * * 1');
});
