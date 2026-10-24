import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

/**
 * A gzipped mongodump archive as a stream. The stream errors (instead of ending) when
 * mongodump exits non-zero, so a half-written dump is never stored as a backup.
 * The URI (with its password) goes in a private temporary config file, not on the
 * command line where other processes could read it.
 */
export function mongodumpStream(uri, { spawnFn = spawn } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-mongodump-'));
  const configPath = path.join(dir, 'config.yaml');
  writeFileSync(configPath, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600 });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  const out = new PassThrough();
  let child;
  try {
    child = spawnFn('mongodump', [`--config=${configPath}`, '--archive', '--gzip'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    cleanup();
    throw err;
  }

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.stdout.pipe(out, { end: false });
  child.on('error', (err) => {
    cleanup();
    out.destroy(err);
  });
  child.on('close', (code) => {
    cleanup();
    if (code === 0) out.end();
    else out.destroy(new Error(`mongodump exited with code ${code}: ${stderr.trim()}`));
  });
  return out;
}
