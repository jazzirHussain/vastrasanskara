// The deploy scripts, nginx config, pm2 process file and workflows: checked as text, and the
// .env writer run for real under bash with a fake `aws` (skipped where bash is unavailable).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const file = (p) => path.join(ROOT, p);
const read = (p) => readFileSync(file(p), 'utf8');
const posix = (p) => p.replace(/\\/g, '/');
// For PATH, where a drive letter's colon would split the entry (Git Bash: C:/x → /c/x).
const bashPath = (p) => posix(p).replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

const DEPLOY = 'deploy/scripts/remote-deploy.sh';
const ROLLBACK = 'deploy/scripts/rollback.sh';
const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';

/** Sources remote-deploy.sh in a scratch dir with a fake `aws` that prints `params`, then runs `script`. */
function inScratch(params, script) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-deploy-'));
  const bin = path.join(dir, 'bin');
  const work = path.join(dir, 'app');
  for (const d of [bin, work]) spawnSync('mkdir', ['-p', d]);
  writeFileSync(path.join(dir, 'params.txt'), params.map(([name, value]) => `${name}\t${value}`).join('\n') + '\n');
  writeFileSync(path.join(bin, 'aws'), `#!/usr/bin/env bash\ncat '${posix(path.join(dir, 'params.txt'))}'\n`, { mode: 0o755 });
  const run = spawnSync(
    'bash',
    ['-c', `export PATH="${bashPath(bin)}:$PATH"; cd '${posix(work)}' && source '${posix(file(DEPLOY))}' && ${script}`],
    { encoding: 'utf8' },
  );
  const env = existsSync(path.join(work, '.env')) ? readFileSync(path.join(work, '.env'), 'utf8') : null;
  return { ...run, env, files: readdirSync(work) };
}

const MONGO = ['/vastrasanskara/prod/MONGO_URI', 'mongodb+srv://u:p@cluster.example.net/vastrasanskara'];

describe.skipIf(!hasBash)('deploy scripts under bash', () => {
  test('deploy scripts parse', () => {
    for (const script of [DEPLOY, ROLLBACK]) {
      const run = spawnSync('bash', ['-n', posix(file(script))], { encoding: 'utf8' });
      expect(run.status, `${script}: ${run.stderr}`).toBe(0);
    }
  });

  test('env values are single-quoted and a quote is refused', () => {
    const ok = inScratch([MONGO, ['/vastrasanskara/prod/SESSION_SECRET', 'a"b$c d']], 'write_env /vastrasanskara/prod ap-south-1 abc123');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.env).toContain(`MONGO_URI='${MONGO[1]}'\n`);
    expect(ok.env).toContain(`SESSION_SECRET='a"b$c d'\n`);

    const bad = inScratch([MONGO, ['/vastrasanskara/prod/SMTP_PASS', "it's"]], 'write_env /vastrasanskara/prod ap-south-1 abc123');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('SMTP_PASS');
    expect(bad.env).toBeNull();
    expect(bad.files.filter((f) => f.startsWith('.env'))).toEqual([]);
  });

  test('env is not written without the database address', () => {
    const run = inScratch([['/vastrasanskara/prod/SESSION_SECRET', 'x']], 'write_env /vastrasanskara/prod ap-south-1 abc123');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('MONGO_URI');
    expect(run.env).toBeNull();
    expect(run.files.filter((f) => f.startsWith('.env'))).toEqual([]);
  });

  test('the release id is written to env', () => {
    const run = inScratch([MONGO], 'write_env /vastrasanskara/prod ap-south-1 abc123');
    expect(run.status, run.stderr).toBe(0);
    expect(run.env).toContain("RELEASE_SHA='abc123'\n");
  });

  test('rollback refuses when no previous release is recorded', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-rollback-'));
    const run = spawnSync('bash', [posix(file(ROLLBACK)), 'api.example.com'], {
      encoding: 'utf8',
      env: { ...process.env, APP_DIR: posix(dir) },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('No previous release recorded');
  });
});

describe('deploy files', () => {
  test('the deploy migrates and waits for the new release', () => {
    const text = read(DEPLOY);
    const at = (s) => text.indexOf(s);
    expect(at('.release-previous')).toBeGreaterThan(-1);
    expect(at('.release-previous')).toBeLessThan(at('git reset --hard'));
    expect(at('cli/migrate.js')).toBeGreaterThan(-1);
    expect(at('cli/migrate.js')).toBeLessThan(at('pm2 startOrReload'));
    expect(at('pm2 install pm2-logrotate')).toBeGreaterThan(-1);
    expect(at('cli/wait-ready.js')).toBeGreaterThan(at('pm2 startOrReload'));
    expect(at('/v1/health')).toBeGreaterThan(at('cli/wait-ready.js'));
    expect(text.trimEnd().split('\n').at(-1)).toBe('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; exit $?; fi');
  });

  test('nginx uses the http2 listen form and hides its version', () => {
    const conf = read('deploy/nginx/api.conf');
    expect(conf).toContain('listen 443 ssl http2;');
    expect(conf).toContain('listen [::]:443 ssl http2;');
    expect(conf).not.toMatch(/^\s*http2 on;/m);
    expect(conf).toMatch(/^\s*server_tokens off;/m);
  });

  test('the deploy workflow polls SSM instead of waiting 100 seconds', () => {
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy).not.toContain('aws ssm wait');
    expect(deploy).toContain('get-command-invocation');
    expect(deploy).toMatch(/needs: \[?ci\]?/);
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('shellcheck deploy/scripts/*.sh');
    expect(ci).toMatch(/^ {2}e2e:/m);
    expect(ci).toContain('npx playwright install --with-deps chromium');
    expect(ci).toContain('npm run e2e');
  });

  test('shell scripts keep LF line endings', () => {
    const attributes = read('.gitattributes');
    for (const rule of ['*.sh text eol=lf', '*.conf text eol=lf', '*.cjs text eol=lf']) expect(attributes).toContain(rule);
    for (const f of [DEPLOY, ROLLBACK, 'deploy/nginx/api.conf', 'deploy/ecosystem.config.cjs']) expect(read(f), f).not.toContain('\r');
  });

  test('the process file loads', () => {
    const require = createRequire(import.meta.url);
    const { apps } = require(file('deploy/ecosystem.config.cjs'));
    expect(apps.map((a) => a.name)).toEqual(['vs-api', 'vs-worker']);
    const api = apps.find((a) => a.name === 'vs-api');
    expect(api.kill_timeout).toBe(10_000);
    expect(apps.every((a) => a.merge_logs === true)).toBe(true);
  });
});
