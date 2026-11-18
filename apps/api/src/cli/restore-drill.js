// Restore drill: restores the newest backup into a scratch database, checks its records and
// reports in plain words. Run before go-live and every 3 months (docs/ops/restore.md).
//
//   MONGO_URI=... BACKUPS_BUCKET=... node apps/api/src/cli/restore-drill.js [--keep]
//
// The URI (with its password) is read from the environment and handed to mongorestore in a
// private temporary config file: it never appears in arguments or output.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { checkRestoredDatabase } from '../core/backup/restoreCheck.js';
import { isMain } from './isMain.js';

const HOUR_MS = 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * HOUR_MS;
const STALE_HOURS = 7;
const KEY_PATTERN = /^mongodump\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})\.archive\.gz$/;

/** The database name in a MongoDB URI ('test' when none is given, as the driver does). */
export function databaseName(uri) {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri);
  return decodeURIComponent(match?.[1] || 'test');
}

/** When a backup was taken, from its key (mongodump/YYYY/MM/DD/HHmm.archive.gz, IST). */
function backupTime(key) {
  const m = KEY_PATTERN.exec(key);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - IST_OFFSET_MS) : null;
}

/**
 * Restores an archive into `<db>_restore_check` with mongorestore; the URI goes in a 0600
 * config file. Resolves to mongorestore's last output; rejects when it fails.
 */
export function restoreArchive(uri, { archive, spawnFn = spawn }) {
  const db = databaseName(uri);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-restore-'));
  const configPath = path.join(dir, 'config.yaml');
  writeFileSync(configPath, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600 });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return new Promise((resolve, reject) => {
    let output = '';
    let child;
    try {
      child = spawnFn(
        'mongorestore',
        [`--config=${configPath}`, `--archive=${archive}`, '--gzip', '--drop', `--nsFrom=${db}.*`, `--nsTo=${db}_restore_check.*`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }
    const keep = (chunk) => {
      output = (output + chunk).slice(-2000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      if (code === 0) resolve(output);
      else reject(new Error(`mongorestore exited with code ${code}: ${output.trim()}`));
    });
  });
}

function reportLines(report) {
  const lines = [`Backup: ${report.backup ?? 'none'}`];
  if (report.ageHours !== null) lines.push(`Backup is ${report.ageHours} h old`);
  for (const c of report.collections) lines.push(`  ${c.name}: ${c.count}`);
  for (const b of report.branches) {
    lines.push(`Branch ${b.branchId}: ${b.auditEntries} history entries, ${b.chainOk ? 'unchanged' : `broken at entry ${b.firstBreak.seq}`}`);
  }
  if (report.newestRecordAt) lines.push(`Newest history entry: ${report.newestRecordAt.toISOString()}`);
  if (report.ok) lines.push('The backup restores and its records check out');
  else lines.push('PROBLEMS:', ...report.problems.map((p) => `  - ${p}`));
  return lines;
}

/**
 * The drill, with its outside world passed in: `listBackups() → [key]`, `download(key) → archive`,
 * `restore(archive)` into the scratch database, `connect() → connection` to it, `dropDatabase()`.
 * The scratch database is dropped afterwards unless `keep`. Prints and answers the report.
 */
export async function runDrill({ listBackups, download, restore, connect, dropDatabase, now = new Date(), out = console.log, keep = false }) {
  const keys = (await listBackups()).filter((k) => KEY_PATTERN.test(k)).sort();
  const backup = keys.at(-1) ?? null;
  let report;
  if (!backup) {
    report = { ok: false, backup: null, ageHours: null, collections: [], branches: [], newestRecordAt: null, problems: ['No backups found'] };
  } else {
    const ageHours = Math.round((now.getTime() - backupTime(backup).getTime()) / HOUR_MS);
    let result;
    try {
      await restore(await download(backup));
      result = await checkRestoredDatabase(await connect());
    } finally {
      if (!keep) await dropDatabase();
    }
    const problems = [...result.problems];
    if (ageHours > STALE_HOURS) problems.push(`The newest backup is ${ageHours} h old; backups should run every 6 hours`);
    report = { ...result, ok: problems.length === 0, backup, ageHours, problems };
  }
  for (const line of reportLines(report)) out(line);
  return report;
}

if (isMain(import.meta.url)) {
  const { MONGO_URI: uri, BACKUPS_BUCKET: bucket, AWS_REGION: region = 'ap-south-1' } = process.env;
  if (!uri || !bucket) {
    console.error('Set MONGO_URI and BACKUPS_BUCKET in the environment, then run: node apps/api/src/cli/restore-drill.js [--keep]');
    process.exit(2);
  }
  const { GetObjectCommand, ListObjectsV2Command, S3Client } = await import('@aws-sdk/client-s3');
  const mongoose = (await import('mongoose')).default;
  const s3 = new S3Client({ region });
  const work = mkdtempSync(path.join(os.tmpdir(), 'vs-drill-'));
  let connection;
  let exitCode = 1;
  try {
    const report = await runDrill({
      keep: process.argv.includes('--keep'),
      async listBackups() {
        const keys = [];
        let ContinuationToken;
        do {
          const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'mongodump/', ContinuationToken }));
          keys.push(...(page.Contents ?? []).map((o) => o.Key));
          ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (ContinuationToken);
        return keys;
      },
      async download(key) {
        const file = path.join(work, 'backup.archive.gz');
        const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        await pipeline(Body, createWriteStream(file, { mode: 0o600 }));
        return file;
      },
      restore: (archive) => restoreArchive(uri, { archive }),
      async connect() {
        connection = await mongoose.createConnection(uri, { dbName: `${databaseName(uri)}_restore_check`, autoIndex: false }).asPromise();
        return connection;
      },
      async dropDatabase() {
        if (connection) await connection.dropDatabase();
      },
    });
    exitCode = report.ok ? 0 : 1;
  } catch (err) {
    // Error messages from the driver or mongorestore do not include the URI's password.
    console.error(`The drill could not finish: ${err.message}`);
  } finally {
    await connection?.close();
    rmSync(work, { recursive: true, force: true });
  }
  process.exit(exitCode);
}
