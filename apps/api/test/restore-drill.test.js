import { test, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { createTestUser } from './helpers/app.js';
import { recordAudit } from '../src/core/audit/service.js';
import { withTransaction } from '../src/core/db.js';
import { restoreArchive, runDrill } from '../src/cli/restore-drill.js';

useTestDb();

const NOW = new Date('2026-11-18T06:30:00Z'); // 12:00 IST
const scratchName = () => `${mongoose.connection.name}_restore_check`;

/** A branch, two users and three audit entries in the test database. */
async function seed() {
  const user = await createTestUser({ roles: ['admin'] });
  await createTestUser({ roles: ['operations'] });
  for (let i = 0; i < 3; i++) {
    await withTransaction((session) =>
      recordAudit({ branchId: user.branchId, entityType: 'settings', entityId: user.branchId, action: 'update', changes: [{ path: 'n', before: i, after: i + 1 }] }, session),
    );
  }
  return user;
}

/** Stand-ins for S3 and mongorestore: "restoring" copies every collection into the scratch database. */
function fakes({ keys = ['mongodump/2026/11/18/0600.archive.gz'], tamper } = {}) {
  const calls = { downloaded: [], dropped: 0 };
  const scratch = mongoose.connection.useDb(scratchName(), { useCache: false });
  return {
    calls,
    scratch,
    deps: {
      listBackups: async () => keys,
      download: async (key) => {
        calls.downloaded.push(key);
        return '/tmp/backup.archive.gz';
      },
      restore: async () => {
        for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
          const docs = await mongoose.connection.db.collection(name).find().toArray();
          if (docs.length) await scratch.db.collection(name).insertMany(docs);
        }
        if (tamper) await tamper(scratch);
      },
      connect: async () => scratch,
      dropDatabase: async () => {
        calls.dropped += 1;
        await scratch.dropDatabase();
      },
      now: NOW,
      out: () => {},
    },
  };
}

test('a restored backup passes the drill', async () => {
  await seed();
  const { deps, calls, scratch } = fakes();
  const lines = [];
  const report = await runDrill({ ...deps, out: (line) => lines.push(line) });
  expect(report.ok).toBe(true);
  expect(report.problems).toEqual([]);
  expect(report.backup).toBe('mongodump/2026/11/18/0600.archive.gz');
  expect(report.ageHours).toBe(6);
  const count = (name) => report.collections.find((c) => c.name === name)?.count;
  expect(count('users')).toBe(await mongoose.connection.db.collection('users').countDocuments());
  expect(count('auditLog')).toBe(3);
  expect(report.branches).toEqual([expect.objectContaining({ auditEntries: 3, chainOk: true, firstBreak: null })]);
  expect(report.newestRecordAt).toBeInstanceOf(Date);
  expect(lines.join('\n')).toContain('Backup is 6 h old');
  expect(lines.join('\n')).toContain('The backup restores and its records check out');
  expect(calls.dropped).toBe(1);
  expect(await scratch.db.listCollections().toArray()).toEqual([]);
});

test('a tampered audit entry fails the drill', async () => {
  await seed();
  const { deps } = fakes({ tamper: (scratch) => scratch.db.collection('auditLog').updateOne({ seq: 2 }, { $set: { action: 'delete' } }) });
  const lines = [];
  const report = await runDrill({ ...deps, out: (line) => lines.push(line) });
  expect(report.ok).toBe(false);
  expect(report.branches[0]).toMatchObject({ chainOk: false, firstBreak: { seq: 2, reason: 'hash_mismatch' } });
  expect(report.problems).toEqual([expect.stringMatching(/^Audit chain broken at entry 2 of branch /)]);
  expect(lines.join('\n')).toContain('Audit chain broken at entry 2');
});

test('an empty backup and an old one are problems', async () => {
  const { deps } = fakes({ keys: ['mongodump/2026/11/16/0600.archive.gz'] });
  const report = await runDrill(deps);
  expect(report.ok).toBe(false);
  expect(report.problems).toEqual(expect.arrayContaining(['No users in the backup', 'The newest backup is 54 h old; backups should run every 6 hours']));
  expect((await runDrill({ ...deps, listBackups: async () => [] })).problems).toEqual(['No backups found']);
});

test('the newest backup is chosen', async () => {
  await seed();
  const { deps, calls } = fakes({
    keys: ['mongodump/2026/11/17/1800.archive.gz', 'mongodump/2026/11/18/0600.archive.gz', 'mongodump/2026/11/18/0000.archive.gz'],
  });
  await runDrill(deps);
  expect(calls.downloaded).toEqual(['mongodump/2026/11/18/0600.archive.gz']);
});

test('the scratch database is kept with --keep', async () => {
  await seed();
  const { deps, calls } = fakes();
  await runDrill({ ...deps, keep: true });
  expect(calls.dropped).toBe(0);
});

test('the database password never appears in the drill output or command line', async () => {
  const uri = 'mongodb+srv://ops:s3cret-pass@cluster.example.net/vastrasanskara?retryWrites=true';
  const seen = [];
  const spawnFn = (cmd, args) => {
    const configPath = args.find((a) => a.startsWith('--config=')).slice('--config='.length);
    seen.push({ cmd, args, config: readFileSync(configPath, 'utf8') });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stderr.end('2026-11-18 restoring...');
      child.emit('close', 0);
    });
    return child;
  };
  const output = await restoreArchive(uri, { archive: '/tmp/b.archive.gz', spawnFn });
  expect(seen).toHaveLength(1);
  expect(seen[0].cmd).toBe('mongorestore');
  expect(seen[0].args).toEqual(expect.arrayContaining([
    '--archive=/tmp/b.archive.gz', '--gzip', '--drop', "--nsFrom=vastrasanskara.*", "--nsTo=vastrasanskara_restore_check.*",
  ]));
  expect(seen[0].args.join(' ')).not.toContain('s3cret-pass');
  expect(seen[0].config).toContain('s3cret-pass');
  expect(String(output)).not.toContain('s3cret-pass');
});

test('the drill only ever writes to the scratch database', async () => {
  const seen = [];
  const spawnFn = (cmd, args) => {
    seen.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  await restoreArchive('mongodb+srv://ops:pw@cluster.example.net/vastrasanskara', { archive: '/tmp/b.archive.gz', spawnFn });
  // Collections from any other database in the archive are skipped, never restored in place.
  expect(seen[0]).toContain('--nsInclude=vastrasanskara.*');

  // Without a database name in the address, the drill cannot know what to keep away from.
  await expect(restoreArchive('mongodb+srv://ops:pw@cluster.example.net/?retryWrites=true', { archive: '/tmp/b.archive.gz', spawnFn }))
    .rejects.toThrow('MONGO_URI must name the database (…mongodb.net/vastrasanskara?…)');
  expect(seen).toHaveLength(1);
});
