# M1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable skeleton of the Vastrasanskara system — monorepo, shared helpers, API with auth/sessions/permissions, settings, hash-chained audit log, transactions, idempotency, file uploads, channel-agnostic notifications, worker with jobs and backups, a React shell with login and admin pages, and the production deployment.

**Architecture:** npm-workspaces monorepo: `packages/shared` (pure JS helpers + zod schemas used by both sides), `apps/api` (Express API + Agenda worker, two entry points, MongoDB via Mongoose), `apps/web` (React + Vite + Mantine). Modules talk through `service.js` functions that accept an optional MongoDB `session` so writes compose into one transaction.

**Tech Stack:** Node 22 LTS, JavaScript (ESM, no TypeScript), Express 5, Mongoose 8, zod 4, pino, helmet, cors, express-session + connect-mongo, argon2, express-rate-limit, Agenda 6 + @agendajs/mongo-backend (Agenda 5 bundles MongoDB driver 4, incompatible with Mongoose 8's driver 6), @aws-sdk/client-s3 + s3-request-presigner, @aws-sdk/client-sesv2 + nodemailer, React 18, Vite, Mantine 7, React Router 6, TanStack Query 5, Vitest 3, supertest, mongodb-memory-server, aws-sdk-client-mock, @testing-library/react, msw.

**Spec:** `docs/superpowers/specs/2026-10-22-vastrasanskara-system-design.md` (sections 2, 3.1, 5.7, 8, 10, 11, 12, 14.1)

## Global Constraints

- JavaScript only, ESM (`"type": "module"`) in every workspace; Node 22 LTS (`.nvmrc` = `22`).
- Money is integer paise everywhere; formatting/rounding only in `packages/shared/src/money.js`.
- Store times in UTC; compute business dates in Asia/Kolkata (fixed +05:30, no DST) using arithmetic, never the host's local timezone.
- Every business document carries `branchId`; every editable document uses Mongoose `optimisticConcurrency: true`; common fields `createdAt`, `createdBy`, `updatedAt`, `updatedBy`.
- REST + JSON under `/v1`. Error body is always `{ error: { code, message, details? } }`; 500 returns only `{ error: { code: 'INTERNAL', message: 'Something went wrong', requestId } }`.
- All request bodies/queries validated with strict zod objects (unknown keys rejected).
- Never log phone numbers, emails, passwords, cookies or measurement values (pino `redact`).
- Session cookie: name `__Host-sid` in production (`sid` in dev/test), `HttpOnly`, `Secure` (prod), `SameSite=Strict`, `Path=/`; idle timeout 12 h, absolute 7 days.
- CORS allows exactly `config.appOrigin` with credentials, `Access-Control-Max-Age: 7200`. State-changing requests require header `X-Requested-With: vs-app` and a JSON body.
- Login: 15-minute lockout after 10 consecutive failures; IP rate limit 20 attempts / 15 minutes.
- Uploads: JPEG, PNG, WebP, HEIC, PDF only, ≤ 10 MB (10 485 760 bytes); download URLs valid 300 s.
- Client quiet hours default 21:00–09:00 IST per channel; staff messages are never held.
- Outbox delivery: max 5 attempts, backoff 1, 5, 15, 60 minutes.
- Backups every 6 h; storage warning at 70% of 512 MB (536 870 912 bytes).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Login email typed with different case** (`Owner@Example.com`) — must log in to the account stored as `owner@example.com`. → Task 10 test `logs in with differently-cased email`.
2. **Server clock in a non-IST timezone** — financial year, period and quiet-hour calculations must not change. → Task 3 runs the shared suite again under `TZ=America/New_York` (`npm run test:tz`), wired into CI in Task 22.
3. **Double-tap on a slow phone** — two concurrent requests with the same idempotency key must execute the handler once. → Task 11 test `concurrent duplicate runs handler once`.
4. **Audit entries round-tripped through MongoDB** (Dates, ObjectIds, nested key order) must still verify. → Task 8 test `verifies after reload with dates and object ids`.
5. **Notification recipient with no email address / no consent** — must be marked `skipped`, not retried forever. → Task 14 tests `skips recipient without address` and `skips client without consent`.

---

## File Structure

Layout rule: each module keeps `model.js` (schemas), `service.js` (business logic) and `routes.js` (HTTP only, including response shapes) in its own folder; adapters and storage implementations never own models or routes.

```
package.json                      workspaces, root scripts
vitest.config.js                  test.projects for all workspaces
eslint.config.js, .prettierrc, .gitignore, .nvmrc, .env.example, README.md
packages/shared/
  src/money.js  src/fy.js  src/stages.js  src/permissions.js
  src/schemas/common.js  src/schemas/branch.js  src/schemas/settings.js  src/schemas/users.js
  src/index.js
  test/*.test.js
apps/api/
  src/server.js  src/worker.js  src/app.js  src/config.js  src/logger.js  src/clock.js
  src/core/errors.js  src/core/validate.js  src/core/db.js  src/core/counters.js
  src/core/audit/{model.js,canonical.js,diff.js,service.js}
  src/core/security.js  src/core/commonFields.js  src/core/auth/{sessions.js,middleware.js,passwords.js,rateLimit.js}
  src/core/idempotency.js
  src/core/files/{storage.js,storage-s3.js,storage-local.js,devFilesRoutes.js,purposes.js,service.js,routes.js}
  src/core/notify/{render.js,quietHours.js,emailLayout.js,catalog.js,recipients.js,models.js,emit.js,deliver.js,service.js,routes.js,adapters/{registry.js,configure.js,inApp.js,emailSes.js,emailFile.js}}
  src/core/jobs/{model.js,service.js,registry.js,runJob.js,worker.js,routes.js}
  src/core/backup/{backup.js,storageCheck.js,mongodump.js,jobs.js}
  src/modules/branches/{model.js,service.js,routes.js}
  src/modules/settings/{model.js,service.js,routes.js}
  src/modules/users/{model.js,service.js,passwordReset.js,routes.js}   (PasswordReset model lives in model.js)
  src/modules/auth/{service.js,routes.js}
  src/modules/health/routes.js
  src/modules/setup/service.js   (bootstrap logic)   src/cli/bootstrap.js   (thin CLI runner)
  scripts/dev-db.js
  test/helpers/{db.js,app.js}
  test/**/*.test.js
apps/web/
  index.html  vite.config.js
  src/main.jsx  src/App.jsx  src/theme.js
  src/lib/{api.js,errorMessages.js,queryClient.js}
  src/auth/{AuthProvider.jsx,RequireAuth.jsx,LoginPage.jsx,ForgotPasswordPage.jsx,ResetPasswordPage.jsx}
  src/layout/{AppLayout.jsx,navItems.js}
  src/notifications/NotificationBell.jsx
  src/features/home/HomePage.jsx
  src/features/users/UsersPage.jsx
  src/features/settings/SettingsPage.jsx
  src/test/{setup.js,server.js}
deploy/nginx/api.conf  deploy/ecosystem.config.cjs  deploy/scripts/remote-deploy.sh
.github/workflows/ci.yml  .github/workflows/deploy.yml
docs/ops/infrastructure.md  docs/ops/restore.md
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `vitest.config.js`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `.nvmrc`, `.env.example`, `README.md`
- Create: `packages/shared/package.json`, `packages/shared/src/index.js`, `packages/shared/test/smoke.test.js`
- Create: `apps/api/package.json`, `apps/web/package.json` (dependencies only; code comes later)

**Interfaces:**
- Produces: root scripts `npm test` (`vitest run`), `npm run lint` (`eslint .`), `npm run test:tz` (`cross-env TZ=America/New_York vitest run --project shared`), `npm run dev:db`, `npm run dev:api`, `npm run dev:worker`, `npm run dev:web`. Workspace package names: `@vs/shared`, `@vs/api`, `@vs/web`. Vitest project names: `shared`, `api`, `web`.

- [ ] **Step 1: Create root files**

`package.json`: `"private": true`, `"type": "module"`, `"workspaces": ["packages/*", "apps/*"]`, `"engines": { "node": ">=22 <23" }`, the scripts above. `vitest.config.js` uses `test.projects: ['packages/shared', 'apps/api', 'apps/web']`. `.gitignore`: `node_modules`, `dist`, `.env`, `.data`, `coverage`, `*.eml`, `.dev-files`. `.env.example` lists every key read by `apps/api/src/config.js` (Task 5) with dev values. `README.md`: prerequisites (Node 22), `npm install`, `npm run dev:db` / `dev:api` / `dev:worker` / `dev:web`, `npm test`.

- [ ] **Step 2: Create workspace packages**

`packages/shared/package.json`: name `@vs/shared`, `"type": "module"`, `"exports": { ".": "./src/index.js", "./*": "./src/*" }`, dependency `zod@^4`, own `vitest.config.js` with `test.name: 'shared'`. `apps/api` and `apps/web` get `package.json` with names `@vs/api` / `@vs/web`, dependency `"@vs/shared": "*"`, and the libraries from the Tech Stack line; each gets `vitest.config.js` with `test.name` `api` (environment `node`, `testTimeout: 30000`) / `web` (environment `jsdom`, `setupFiles: ['src/test/setup.js']`).

- [ ] **Step 3: Write smoke test** `packages/shared/test/smoke.test.js`

```js
import { test, expect } from 'vitest';
import * as shared from '@vs/shared';
test('shared package loads', () => { expect(shared).toBeTypeOf('object'); });
```

- [ ] **Step 4: Install and run**

Run: `npm install && npm test -- --project shared && npm run lint`
Expected: 1 test passes; lint exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold npm workspaces monorepo"
```

---

### Task 2: Money helpers

**Files:**
- Create: `packages/shared/src/money.js`
- Test: `packages/shared/test/money.test.js`
- Modify: `packages/shared/src/index.js` (re-export)

**Interfaces:**
- Produces:
  - `rupeesToPaise(value: string|number) → number` — throws `RangeError` for more than 2 decimals or non-finite.
  - `formatINR(paise: number) → string` — Indian digit grouping, `₹` prefix, 2 decimals, `-₹` for negatives.
  - `roundToRupee(paise: number) → { total: number, roundOff: number }` — nearest rupee, 50 paise rounds up.
  - `allocateProRata(totalPaise: number, weights: number[]) → number[]` — largest-remainder method; sum equals total; ties go to the earlier index; throws `RangeError` when all weights are 0.
  - `amountInWords(paise: number) → string` — Indian numbering (Thousand, Lakh, Crore).

- [ ] **Step 1: Write the failing tests**

```js
import { test, expect } from 'vitest';
import { rupeesToPaise, formatINR, roundToRupee, allocateProRata, amountInWords } from '../src/money.js';

test('rupeesToPaise', () => {
  expect(rupeesToPaise('1234.5')).toBe(123450);
  expect(rupeesToPaise(10)).toBe(1000);
  expect(() => rupeesToPaise('0.005')).toThrow(RangeError);
});
test('formatINR uses Indian grouping', () => {
  expect(formatINR(12345678)).toBe('₹1,23,456.78');
  expect(formatINR(-5000)).toBe('-₹50.00');
  expect(formatINR(0)).toBe('₹0.00');
});
test('roundToRupee', () => {
  expect(roundToRupee(12345678)).toEqual({ total: 12345700, roundOff: 22 });
  expect(roundToRupee(12345649)).toEqual({ total: 12345600, roundOff: -49 });
  expect(roundToRupee(12345650)).toEqual({ total: 12345700, roundOff: 50 });
});
test('allocateProRata', () => {
  expect(allocateProRata(1000, [1, 1, 1])).toEqual([334, 333, 333]);
  expect(allocateProRata(1001, [3, 1])).toEqual([751, 250]);
  expect(allocateProRata(0, [5, 5])).toEqual([0, 0]);
  expect(() => allocateProRata(100, [0, 0])).toThrow(RangeError);
});
test('amountInWords', () => {
  expect(amountInWords(12345650)).toBe('Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only');
  expect(amountInWords(10000000000)).toBe('Rupees Ten Crore Only');
  expect(amountInWords(100)).toBe('Rupees One Only');
  expect(amountInWords(0)).toBe('Rupees Zero Only');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/test/money.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the five functions in `packages/shared/src/money.js`**

`rupeesToPaise` parses via string split on `.` (no float multiplication). `formatINR` groups the last 3 digits, then pairs.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/shared/test/money.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): money helpers in paise"
```

---

### Task 3: IST dates, financial year and stages

**Files:**
- Create: `packages/shared/src/fy.js`, `packages/shared/src/stages.js`
- Test: `packages/shared/test/fy.test.js`, `packages/shared/test/stages.test.js`

**Interfaces:**
- Produces (`fy.js`): `IST_OFFSET_MINUTES = 330`; `istDate(date: Date) → 'YYYY-MM-DD'`; `istTime(date) → 'HH:mm'`; `periodOf(date) → 'YYYY-MM'`; `financialYear(date) → { startYear: number, label: '2026-27', code: '2627' }`; `istDayBounds(ymd) → { start: Date, end: Date }`; `atIstTime(ymd, 'HH:mm') → Date`; `addDaysYmd(ymd, n) → ymd`.
- Produces (`stages.js`): `STAGES` — frozen array of `{ key, label }` in this order: `order_taken` "Order taken + advance", `materials_ready` "Materials ready", `pattern_making` "Pattern making", `handwork` "Handwork", `quality_check` "Quality check", `masters_cutting` "Masters cutting table", `tailors` "Tailors", `trials_fittings` "Trials and fittings", `finishing` "Finishing", `branding` "Branding", `final_qc` "Final quality check", `packaging` "Packaging", `ready_for_pickup` "Ready for pickup", `picked_up` "Picked up"; `STAGE_KEYS: string[]`; `stageIndex(key) → number` (throws on unknown key).

- [ ] **Step 1: Write the failing tests**

```js
// fy.test.js
import { test, expect } from 'vitest';
import { istDate, istTime, periodOf, financialYear, istDayBounds, atIstTime, addDaysYmd } from '../src/fy.js';

test('financial year boundary at IST midnight 1 April', () => {
  expect(financialYear(new Date('2027-03-31T18:29:59.999Z'))).toEqual({ startYear: 2026, label: '2026-27', code: '2627' });
  expect(financialYear(new Date('2027-03-31T18:30:00.000Z'))).toEqual({ startYear: 2027, label: '2027-28', code: '2728' });
});
test('IST date, time and period', () => {
  const d = new Date('2026-10-21T19:00:00Z');
  expect(istDate(d)).toBe('2026-10-22');
  expect(istTime(d)).toBe('00:30');
  expect(periodOf(d)).toBe('2026-10');
});
test('day bounds and wall-clock conversion', () => {
  expect(istDayBounds('2026-10-22')).toEqual({ start: new Date('2026-10-21T18:30:00.000Z'), end: new Date('2026-10-22T18:29:59.999Z') });
  expect(atIstTime('2026-10-22', '09:00')).toEqual(new Date('2026-10-22T03:30:00.000Z'));
  expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
});
```

```js
// stages.test.js
import { test, expect } from 'vitest';
import { STAGES, STAGE_KEYS, stageIndex } from '../src/stages.js';
test('stage order', () => {
  expect(STAGES).toHaveLength(14);
  expect(STAGE_KEYS[0]).toBe('order_taken');
  expect(stageIndex('trials_fittings')).toBe(7);
  expect(() => stageIndex('nope')).toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/test/fy.test.js packages/shared/test/stages.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `fy.js` and `stages.js`**

All `fy.js` functions shift by `IST_OFFSET_MINUTES` and use `getUTC*` methods only.

- [ ] **Step 4: Run, including the timezone run**

Run: `npx vitest run packages/shared && npm run test:tz`
Expected: PASS in both runs.

- [ ] **Step 5: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): IST date, financial year and stage helpers"
```

---

### Task 4: Permissions and common schemas

**Files:**
- Create: `packages/shared/src/permissions.js`, `packages/shared/src/schemas/common.js`
- Test: `packages/shared/test/permissions.test.js`, `packages/shared/test/common.test.js`

**Interfaces:**
- Produces (`permissions.js`): `ROLES = ['admin', 'operations', 'designer']`; `PERMISSIONS` — object of constants whose values are: `orders.read.all`, `orders.read.own`, `orders.write`, `production.update`, `measurements.write`, `customers.read`, `customers.write`, `money.view`, `billing.draft`, `billing.issue`, `billing.cancel`, `payments.record`, `discounts.give`, `periods.lock`, `audit.verify`, `reports.export`, `expenses.write`, `stock.write`, `stock.consume.own`, `settings.edit`, `users.manage`, `system.monitor`; `ROLE_PERMISSIONS` — admin: all; operations: all except `production.update`, `billing.cancel`, `periods.lock`, `audit.verify`, `reports.export`, `settings.edit`, `users.manage`, `system.monitor`, `stock.consume.own`; designer: `orders.read.own`, `production.update`, `measurements.write`, `customers.read`, `stock.consume.own`. `permissionsFor(roles: string[]) → Set<string>` (union; throws `Error('Unknown role: x')`); `can(roles, permission) → boolean`.
- Produces (`schemas/common.js`): `objectId` (24-hex string), `email` (trimmed, lower-cased, valid email), `phone` (any country, validated with libphonenumber-js, normalised to E.164 e.g. `+919876543210`; no country code → India; leading `00` → `+`), `gstin` (regex `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`), `stateCode` (`'01'`–`'38'`, `'97'`), `hhmm` (`HH:mm` 00:00–23:59), `paise` (non-negative integer), `password` (min 10 chars, max 200).

- [ ] **Step 1: Write the failing tests**

```js
// permissions.test.js
import { test, expect } from 'vitest';
import { can, permissionsFor, PERMISSIONS } from '../src/permissions.js';
test('designer cannot see money', () => {
  expect(can(['designer'], 'money.view')).toBe(false);
  expect(can(['designer'], 'production.update')).toBe(true);
});
test('operations cannot update production', () => { expect(can(['operations'], 'production.update')).toBe(false); });
test('roles union', () => { expect(can(['operations', 'designer'], 'money.view')).toBe(true); });
test('admin has everything', () => {
  const all = permissionsFor(['admin']);
  for (const p of Object.values(PERMISSIONS)) expect(all.has(p)).toBe(true);
});
test('unknown role', () => { expect(() => permissionsFor(['ceo'])).toThrow('Unknown role: ceo'); });
```

```js
// common.test.js
import { test, expect } from 'vitest';
import { email, phone, gstin, hhmm } from '../src/schemas/common.js';
test('email normalised', () => { expect(email.parse(' Owner@Example.com ')).toBe('owner@example.com'); });
test('phone normalised to E.164', () => { expect(phone.parse('98765 43210')).toBe('+919876543210'); expect(phone.parse('+44 7911 123456')).toBe('+447911123456'); expect(() => phone.parse('12345')).toThrow(); });
test('gstin', () => { expect(gstin.safeParse('29ABCDE1234F1Z5').success).toBe(true); expect(gstin.safeParse('29abcde1234f1z5').success).toBe(false); });
test('hhmm', () => { expect(hhmm.safeParse('21:00').success).toBe(true); expect(hhmm.safeParse('24:00').success).toBe(false); });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/test/permissions.test.js packages/shared/test/common.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement both files**

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/shared`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): permissions map and common schemas"
```

---

### Task 5: API app skeleton — config, logging, errors, validation

**Files:**
- Create: `apps/api/src/config.js`, `apps/api/src/logger.js`, `apps/api/src/clock.js`, `apps/api/src/core/errors.js`, `apps/api/src/core/validate.js`, `apps/api/src/app.js`, `apps/api/src/server.js`
- Test: `apps/api/test/app.test.js`

**Interfaces:**
- Produces:
  - `loadConfig(env = process.env) → Config` where Config = `{ env: 'development'|'test'|'production', port, mongoUri, appOrigin, apiOrigin, sessionSecret, cookie: { name, secure }, aws: { region, filesBucket, backupsBucket }, mail: { adapter: 'ses'|'file', from, fileDir }, storage: { adapter: 's3'|'local', localDir }, quotaBytes: 536870912 }`. Reads `.env` via dotenv in non-test envs; throws listing missing keys in production.
  - `logger` (pino) with `redact: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.email', '*.phone', '*.measurements']`.
  - `clock.now() → Date` (object `clock` exported so tests can `vi.spyOn(clock, 'now')`).
  - `AppError(status, code, message, details?)`; factories `validationError(details)` 400 `VALIDATION_FAILED`, `notAuthenticated(code = 'NOT_AUTHENTICATED')` 401, `forbidden(code = 'FORBIDDEN')` 403, `notFound()` 404 `NOT_FOUND`, `conflict(code = 'CONFLICT', message)` 409, `businessRule(code, message, details)` 422, `unsupportedContentType()` 415 `UNSUPPORTED_CONTENT_TYPE`; `errorHandler` middleware (maps Mongoose `VersionError` → 409 `CONFLICT`).
  - `validate({ body?, query?, params? })` middleware — parses with the given zod schemas, replaces `req.body` / `req.validatedQuery` / `req.params`, issues → `validationError(issues.map(i => ({ path: i.path.join('.'), message: i.message })))`.
  - `createApp({ config, storage, mount }) → express.Application` — `mount(app)` is an optional hook called before the 404 handler (used by tests and later tasks to add routers). Adds `X-Request-Id` (uuid) to every response.

- [ ] **Step 1: Write the failing tests** `apps/api/test/app.test.js`

```js
import { test, expect } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { businessRule } from '../src/core/errors.js';
import { validate } from '../src/core/validate.js';

const app = createApp({ config: loadConfig({ NODE_ENV: 'test' }), mount: (a) => {
  a.get('/t/rule', () => { throw businessRule('X_RULE', 'nope'); });
  a.get('/t/boom', () => { throw new Error('secret detail'); });
  a.post('/t/v', validate({ body: z.strictObject({ n: z.number() }) }), (req, res) => res.json(req.body));
}});

test('404 shape', async () => {
  const r = await request(app).get('/v1/missing');
  expect(r.status).toBe(404);
  expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
});
test('business rule → 422', async () => {
  const r = await request(app).get('/t/rule');
  expect(r.status).toBe(422);
  expect(r.body.error).toMatchObject({ code: 'X_RULE', message: 'nope' });
});
test('unexpected error hides detail', async () => {
  const r = await request(app).get('/t/boom');
  expect(r.status).toBe(500);
  expect(r.body.error.code).toBe('INTERNAL');
  expect(JSON.stringify(r.body)).not.toContain('secret detail');
  expect(r.body.error.requestId).toBe(r.headers['x-request-id']);
});
test('strict validation rejects unknown keys', async () => {
  const r = await request(app).post('/t/v').send({ n: 1, extra: true });
  expect(r.status).toBe(400);
  expect(r.body.error.code).toBe('VALIDATION_FAILED');
});
```

(The CSRF header requirement arrives in Task 9; Task 9 updates this file to send it.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/api/test/app.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the files listed above**

`server.js`: `loadConfig()` → `connectDb` (Task 6 adds it; until then just `createApp().listen(config.port)`).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run apps/api/test/app.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): app skeleton with config, logging, errors, validation"
```

---

### Task 6: Database, transactions, test harness, health

**Files:**
- Create: `apps/api/src/core/db.js`, `apps/api/src/modules/health/routes.js`, `apps/api/scripts/dev-db.js`, `apps/api/test/helpers/db.js`
- Modify: `apps/api/src/app.js` (mount `/v1/health`), `apps/api/src/server.js` (connect before listen)
- Test: `apps/api/test/db.test.js`, `apps/api/test/health.test.js`

**Interfaces:**
- Produces:
  - `connectDb(uri) → Promise<mongoose.Connection>`, `disconnectDb()`.
  - `withTransaction(fn: (session) => Promise<T>) → Promise<T>` — wraps the driver's `session.withTransaction` (which retries on `TransientTransactionError` / `UnknownTransactionCommitResult`); always ends the session; returns `fn`'s result.
  - Test helper `useTestDb()` — registers `beforeAll` (start `MongoMemoryReplSet` with 1 member, `connectDb`), `afterEach` (delete all documents in all collections), `afterAll` (disconnect, stop).
  - `GET /v1/health` → `200 { db: 'ok' }` or `503 { db: 'down' }` (Task 18 adds `worker`).
  - `scripts/dev-db.js` — starts a persistent `MongoMemoryReplSet` with `dbPath: .data/db`, prints the URI; `npm run dev:db` runs it.

- [ ] **Step 1: Write the failing tests**

```js
// db.test.js
import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { withTransaction } from '../src/core/db.js';
useTestDb();
const Thing = mongoose.model('Thing', new mongoose.Schema({ n: Number }));

test('commits', async () => {
  await withTransaction((session) => Thing.create([{ n: 1 }], { session }));
  expect(await Thing.countDocuments()).toBe(1);
});
test('rolls back on throw', async () => {
  await expect(withTransaction(async (session) => { await Thing.create([{ n: 2 }], { session }); throw new Error('x'); })).rejects.toThrow('x');
  expect(await Thing.countDocuments()).toBe(0);
});
test('retries transient errors', async () => {
  let calls = 0;
  await withTransaction(async (session) => {
    calls++;
    await Thing.create([{ n: 3 }], { session });
    if (calls === 1) { const e = new mongoose.mongo.MongoError('transient'); e.addErrorLabel('TransientTransactionError'); throw e; }
  });
  expect(calls).toBe(2);
  expect(await Thing.countDocuments()).toBe(1);
});
```

```js
// health.test.js
import { test, expect } from 'vitest';
import request from 'supertest';
import { useTestDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
useTestDb();
test('health ok', async () => {
  const r = await request(createApp({ config: loadConfig({ NODE_ENV: 'test' }) })).get('/v1/health');
  expect(r.status).toBe(200);
  expect(r.body.db).toBe('ok');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/api/test/db.test.js apps/api/test/health.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `db.js`, health route, test helper, dev-db script**

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run apps/api/test/db.test.js apps/api/test/health.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api package.json && git commit -m "feat(api): mongodb connection, transaction helper, health check"
```

---

### Task 7: Gapless counters

**Files:**
- Create: `apps/api/src/core/counters.js`
- Test: `apps/api/test/counters.test.js`

**Interfaces:**
- Produces: `nextSequence(name: string, session) → Promise<number>` — `findOneAndUpdate({ _id: name }, { $inc: { value: 1 } }, { upsert: true, new: true, session })` on collection `counters`; first value is 1. Must be called inside a transaction so an aborted transaction releases the number.

- [ ] **Step 1: Write the failing tests**

```js
import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { withTransaction } from '../src/core/db.js';
import { nextSequence } from '../src/core/counters.js';
useTestDb();

test('sequential from 1', async () => {
  const a = await withTransaction((s) => nextSequence('t', s));
  const b = await withTransaction((s) => nextSequence('t', s));
  expect([a, b]).toEqual([1, 2]);
});
test('concurrent transactions get unique contiguous numbers', async () => {
  const nums = await Promise.all(Array.from({ length: 20 }, () => withTransaction((s) => nextSequence('c', s))));
  expect([...nums].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
});
test('aborted transaction does not consume a number', async () => {
  await withTransaction((s) => nextSequence('g', s));
  await expect(withTransaction(async (s) => { await nextSequence('g', s); throw new Error('abort'); })).rejects.toThrow();
  expect(await withTransaction((s) => nextSequence('g', s))).toBe(2);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/counters.test.js` → FAIL.
- [ ] **Step 3: Implement `nextSequence`.**
- [ ] **Step 4: Run to verify pass** — same command → PASS (3 tests).
- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): gapless transactional counters"
```

---

### Task 8: Hash-chained audit log

**Files:**
- Create: `apps/api/src/core/audit/model.js`, `canonical.js`, `diff.js`, `service.js`
- Test: `apps/api/test/audit.test.js`

**Interfaces:**
- Consumes: `nextSequence` (Task 7), `withTransaction` (Task 6), `clock.now` (Task 5).
- Produces:
  - `normalize(value) → JSON-safe value` — `Date` → ISO string, `ObjectId` → hex string, Mongoose docs → `toObject()`, `undefined` removed, arrays/objects recursed.
  - `canonicalJson(value) → string` — `JSON.stringify` of `normalize(value)` with object keys sorted recursively.
  - `diff(before, after) → Array<{ path, before, after }>` — dotted paths over plain objects (arrays compared as whole values); missing side is `null`; values normalized; sorted by path.
  - `recordAudit({ branchId, entityType, entityId, action, before = null, after = null, changes, actor: { userId = null, ip = null, userAgent = null } }, session) → Promise<AuditEntry>` — `changes` defaults to `diff(before, after)`; `seq = nextSequence('audit:' + branchId, session)`; `prevHash` = hash of entry `seq - 1` read inside the session (genesis `'0'.repeat(64)`); `hash = sha256hex(prevHash + canonicalJson({ seq, branchId, entityType, entityId, action, changes, userId, at, ip, userAgent }))` with `at` as ISO string. Throws if `session` is missing.
  - `verifyAuditChain(branchId) → Promise<{ ok: true, checked } | { ok: false, checked, firstBreak: { seq, reason: 'hash_mismatch' | 'missing_seq' | 'prev_mismatch' } }>` — streams entries by `seq` ascending.
  - Model `AuditLog` (collection `auditLog`): fields above, unique index `{ branchId: 1, seq: 1 }`, index `{ entityType: 1, entityId: 1, seq: -1 }`. No update/delete helpers are exported.

- [ ] **Step 1: Write the failing tests**

```js
import { test, expect } from 'vitest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { withTransaction } from '../src/core/db.js';
import { recordAudit, verifyAuditChain } from '../src/core/audit/service.js';
import { diff } from '../src/core/audit/diff.js';
import { AuditLog } from '../src/core/audit/model.js';
useTestDb();
const branchId = new mongoose.Types.ObjectId().toString();
const write = (extra = {}) => withTransaction((s) => recordAudit({ branchId, entityType: 'setting', entityId: 'x', action: 'update', before: { a: 1 }, after: { a: 2 }, actor: {}, ...extra }, s));

test('chains entries', async () => {
  const e1 = await write(); const e2 = await write();
  expect(e1.seq).toBe(1); expect(e1.prevHash).toBe('0'.repeat(64));
  expect(e2.prevHash).toBe(e1.hash);
});
test('field-level diff', () => {
  expect(diff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: 4 })).toEqual([
    { path: 'b.c', before: 2, after: 3 }, { path: 'd', before: null, after: 4 },
  ]);
});
test('verifies after reload with dates and object ids', async () => {
  const id = new mongoose.Types.ObjectId();
  await write({ before: { at: new Date('2026-10-22T05:00:00.123Z'), ref: id, z: { b: 1, a: 2 } }, after: { at: new Date('2026-10-23T05:00:00Z'), ref: id, z: { a: 2, b: 3 } } });
  await write();
  expect(await verifyAuditChain(branchId)).toEqual({ ok: true, checked: 2 });
});
test('detects tampering', async () => {
  await write(); await write(); await write();
  await AuditLog.collection.updateOne({ branchId, seq: 2 }, { $set: { 'changes.0.after': 999 } });
  expect(await verifyAuditChain(branchId)).toMatchObject({ ok: false, firstBreak: { seq: 2, reason: 'hash_mismatch' } });
});
test('detects deletion', async () => {
  await write(); await write(); await write();
  await AuditLog.collection.deleteOne({ branchId, seq: 2 });
  expect(await verifyAuditChain(branchId)).toMatchObject({ ok: false, firstBreak: { seq: 2, reason: 'missing_seq' } });
});
test('aborted transaction leaves no entry', async () => {
  await expect(withTransaction(async (s) => { await recordAudit({ branchId, entityType: 't', entityId: '1', action: 'x', actor: {} }, s); throw new Error('abort'); })).rejects.toThrow();
  expect(await AuditLog.countDocuments()).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/audit.test.js` → FAIL.
- [ ] **Step 3: Implement the four files.** Store `changes` already normalized so the stored form is exactly what was hashed.
- [ ] **Step 4: Run to verify pass** — PASS (6 tests).
- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): hash-chained append-only audit log"
```

---

### Task 9: Security middleware — helmet, CORS, CSRF header

**Files:**
- Create: `apps/api/src/core/security.js`, `apps/api/test/helpers/app.js`
- Modify: `apps/api/src/app.js`, `apps/api/test/app.test.js` (send `X-Requested-With`)
- Test: `apps/api/test/security.test.js`

**Interfaces:**
- Produces:
  - `securityMiddleware(config) → express.RequestHandler[]` — helmet; cors `{ origin: config.appOrigin, credentials: true, maxAge: 7200, allowedHeaders: ['Content-Type', 'X-Requested-With', 'Idempotency-Key'] }`.
  - `requireAppHeader` — for methods other than GET/HEAD/OPTIONS: missing/incorrect `X-Requested-With: vs-app` → 403 `CSRF_HEADER_MISSING`; non-empty body with content type other than `application/json` → 415 `UNSUPPORTED_CONTENT_TYPE`.
  - Middleware order in `createApp`: request id → `securityMiddleware` → `express.json({ limit: '1mb' })` → `/v1/health` → `/v1/webhooks` (mounted later, Task 15) → session (Task 10) → `requireAppHeader` → routers → `mount` hook → 404 → `errorHandler`.
  - Test helper `buildTestApp(overrides?) → app` (test config, `appOrigin: 'https://app.test'`), and `api(agentOrApp)` → wrapper whose `post/put/patch/delete` set `X-Requested-With: vs-app`.

- [ ] **Step 1: Write the failing tests**

```js
import { test, expect } from 'vitest';
import request from 'supertest';
import { buildTestApp } from './helpers/app.js';
const app = buildTestApp({ mount: (a) => a.post('/t/echo', (req, res) => res.json({ ok: true })) });

test('preflight allows app origin only', async () => {
  const ok = await request(app).options('/t/echo').set('Origin', 'https://app.test').set('Access-Control-Request-Method', 'POST');
  expect(ok.headers['access-control-allow-origin']).toBe('https://app.test');
  expect(ok.headers['access-control-allow-credentials']).toBe('true');
  expect(ok.headers['access-control-max-age']).toBe('7200');
  const evil = await request(app).options('/t/echo').set('Origin', 'https://evil.test').set('Access-Control-Request-Method', 'POST');
  expect(evil.headers['access-control-allow-origin']).toBeUndefined();
});
test('POST without app header rejected', async () => {
  const r = await request(app).post('/t/echo').send({});
  expect(r.status).toBe(403); expect(r.body.error.code).toBe('CSRF_HEADER_MISSING');
});
test('non-JSON body rejected', async () => {
  const r = await request(app).post('/t/echo').set('X-Requested-With', 'vs-app').set('Content-Type', 'text/plain').send('hi');
  expect(r.status).toBe(415);
});
test('helmet headers', async () => {
  const r = await request(app).get('/v1/health');
  expect(r.headers['x-content-type-options']).toBe('nosniff');
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/security.test.js` → FAIL.
- [ ] **Step 3: Implement `security.js`, the helper, and update `app.js` / `app.test.js`.**
- [ ] **Step 4: Run** — `npx vitest run apps/api` → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): helmet, strict CORS and CSRF header check"
```

---

### Task 10: Branches, users, sessions and login

**Files:**
- Create: `apps/api/src/modules/branches/model.js`, `apps/api/src/modules/users/model.js`, `apps/api/src/core/auth/sessions.js`, `apps/api/src/core/auth/middleware.js`, `apps/api/src/modules/auth/service.js`, `apps/api/src/modules/auth/routes.js`
- Modify: `apps/api/src/app.js`, `apps/api/test/helpers/app.js`
- Test: `apps/api/test/auth.test.js`

**Interfaces:**
- Consumes: `recordAudit` (Task 8), `withTransaction`, `clock`, `permissionsFor`/`can` (Task 4), `email`/`password` schemas.
- Produces:
  - `Branch` model: `name, legalName, gstin, stateCode, address { line1, line2, city, pincode }, phone, email, logoKey, prefixes { invoice: 'INV', creditNote: 'CN', receiptVoucher: 'RV', receipt: 'RCPT', refund: 'RF', expense: 'EXP', order: 'VS/ORD' }` + common fields.
  - `User` model: `branchId, name, email (unique, lowercase), passwordHash, roles [enum ROLES], active (default true), failedLoginCount, lockedUntil` + common fields.
  - `hashPassword(plain) → Promise<string>` / `verifyPassword(hash, plain) → Promise<boolean>` (argon2id) in `modules/auth/service.js`.
  - `sessionMiddleware(config, mongoClient)` — express-session + connect-mongo (`collectionName: 'sessions'`, `stringify: false`, `ttl: 12 h`), `rolling: true`, cookie per Global Constraints; session data `{ userId, createdAt }`.
  - `revokeUserSessions(userId) → Promise<number>` — `deleteMany({ 'session.userId': String(userId) })`.
  - `loadUser` middleware — sets `req.user = { id, branchId, name, email, roles, permissions: Set }` when a session exists; destroys the session and responds 401 `SESSION_EXPIRED` when `createdAt` is more than 7 days before `clock.now()`, or the user is missing/inactive.
  - `requireAuth` → 401 `NOT_AUTHENTICATED`; `requirePermission(...perms)` → 403 `FORBIDDEN` unless the user has all of them.
  - `actorFrom(req) → { userId, ip, userAgent }`.
  - Routes: `POST /v1/auth/login { email, password }` → 200 `{ user: Me }`; `POST /v1/auth/logout` → 204; `GET /v1/auth/me` → 200 `Me` where `Me = { id, name, email, roles, permissions: string[] (sorted), branchId }`.
  - Login errors: unknown email / wrong password / inactive → 401 `INVALID_CREDENTIALS`; locked → 423 `ACCOUNT_LOCKED`; IP limit → 429 `RATE_LIMITED`. Successful and failed logins are audited (`entityType: 'user'`, actions `login` / `login_failed`), the email is never in `changes`.
  - Test helpers added: `createTestBranch() → branch`, `createTestUser({ roles, email?, password = 'correct-horse-1', active? }) → user`, `loginAs(app, { roles }) → { agent, user }` (agent wrapped with `api()` from Task 9).

- [ ] **Step 1: Write the failing tests**

```js
import { test, expect, vi } from 'vitest';
import request from 'supertest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, api, createTestUser, loginAs } from './helpers/app.js';
import { clock } from '../src/clock.js';
import { requirePermission } from '../src/core/auth/middleware.js';
import { revokeUserSessions } from '../src/core/auth/sessions.js';
import { AuditLog } from '../src/core/audit/model.js';
useTestDb();
const app = buildTestApp({ mount: (a) => a.get('/t/money', requirePermission('money.view'), (req, res) => res.json({ ok: 1 })) });
const login = (email, password) => api(request(app)).post('/v1/auth/login').send({ email, password });

test('logs in and sets strict cookie', async () => {
  await createTestUser({ roles: ['admin'], email: 'owner@example.com' });
  const r = await login('owner@example.com', 'correct-horse-1');
  expect(r.status).toBe(200);
  expect(r.body.user.permissions).toContain('settings.edit');
  expect(r.headers['set-cookie'][0]).toMatch(/^sid=.*HttpOnly.*SameSite=Strict/i);
});
test('logs in with differently-cased email', async () => {
  await createTestUser({ roles: ['admin'], email: 'owner@example.com' });
  expect((await login('Owner@Example.com', 'correct-horse-1')).status).toBe(200);
});
test('wrong password and inactive user', async () => {
  await createTestUser({ roles: ['admin'], email: 'a@x.com' });
  await createTestUser({ roles: ['admin'], email: 'b@x.com', active: false });
  expect((await login('a@x.com', 'wrong-pass-12')).body.error.code).toBe('INVALID_CREDENTIALS');
  expect((await login('b@x.com', 'correct-horse-1')).body.error.code).toBe('INVALID_CREDENTIALS');
  expect(await AuditLog.countDocuments({ action: 'login_failed' })).toBe(2); // every failed attempt on an existing account
});
test('locks after 10 failures for 15 minutes', async () => {
  await createTestUser({ roles: ['admin'], email: 'a@x.com' });
  for (let i = 0; i < 10; i++) await login('a@x.com', 'wrong-pass-12');
  expect((await login('a@x.com', 'correct-horse-1')).status).toBe(423);
  vi.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + 16 * 60_000));
  expect((await login('a@x.com', 'correct-horse-1')).status).toBe(200);
  vi.restoreAllMocks();
});
test('me, logout, absolute expiry', async () => {
  const { agent } = await loginAs(app, { roles: ['operations'] });
  expect((await agent.get('/v1/auth/me')).status).toBe(200);
  vi.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + 8 * 24 * 3600_000));
  expect((await agent.get('/v1/auth/me')).body.error.code).toBe('SESSION_EXPIRED');
  vi.restoreAllMocks();
});
test('permission check and revocation', async () => {
  const { agent, user } = await loginAs(app, { roles: ['designer'] });
  expect((await agent.get('/t/money')).status).toBe(403);
  await revokeUserSessions(user._id);
  expect((await agent.get('/v1/auth/me')).status).toBe(401);
});
test('unauthenticated me', async () => {
  expect((await request(app).get('/v1/auth/me')).body.error.code).toBe('NOT_AUTHENTICATED');
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/auth.test.js` → FAIL.
- [ ] **Step 3: Implement.** Lockout: on failure increment `failedLoginCount`; at 10 set `lockedUntil = now + 15 min` and reset the count; success resets both. Rate limiter: `express-rate-limit` `{ windowMs: 15 min, limit: 20 }` on the login route, handler throws 429 `RATE_LIMITED`; in test config `limit: 1000`.
- [ ] **Step 4: Run** — `npx vitest run apps/api` → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): users, server-side sessions, login with lockout"
```

---

### Task 11: Idempotency keys

**Files:**
- Create: `apps/api/src/core/idempotency.js`
- Test: `apps/api/test/idempotency.test.js`

**Interfaces:**
- Consumes: `req.user` (Task 10).
- Produces: `idempotent()` middleware. Collection `idempotencyKeys`: `{ _id: userId + ':' + key, method, path, state: 'in_progress' | 'done', status, body, createdAt }` with TTL index 24 h on `createdAt`. Missing `Idempotency-Key` → 400 `IDEMPOTENCY_KEY_REQUIRED`; same key on a different method+path → 422 `IDEMPOTENCY_KEY_REUSED`; key in progress → 409 `IDEMPOTENCY_IN_PROGRESS`; finished → replays stored status and body; handler responded ≥ 400 or threw → key deleted so the client may retry.

- [ ] **Step 1: Write the failing tests**

```js
import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { idempotent } from '../src/core/idempotency.js';
useTestDb();
let runs = 0;
const app = buildTestApp({ mount: (a) => {
  a.post('/t/pay', idempotent(), async (req, res) => { runs++; await new Promise((r) => setTimeout(r, 50)); res.status(201).json({ run: runs }); });
  a.post('/t/other', idempotent(), (req, res) => res.json({}));
  a.post('/t/fail', idempotent(), (req, res) => { runs++; res.status(422).json({ error: { code: 'X' } }); });
}});

test('requires key', async () => {
  const { agent } = await loginAs(app, { roles: ['operations'] });
  expect((await agent.post('/t/pay').send({})).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
});
test('replays a finished request', async () => {
  runs = 0; const { agent } = await loginAs(app, { roles: ['operations'] });
  const a = await agent.post('/t/pay').set('Idempotency-Key', 'k1').send({});
  const b = await agent.post('/t/pay').set('Idempotency-Key', 'k1').send({});
  expect(b.status).toBe(201); expect(b.body).toEqual(a.body); expect(runs).toBe(1);
});
test('concurrent duplicate runs handler once', async () => {
  runs = 0; const { agent } = await loginAs(app, { roles: ['operations'] });
  const [x, y] = await Promise.all([1, 2].map(() => agent.post('/t/pay').set('Idempotency-Key', 'k2').send({})));
  expect([x.status, y.status].sort()).toEqual([201, 409]); expect(runs).toBe(1);
});
test('key reused on another route', async () => {
  const { agent } = await loginAs(app, { roles: ['operations'] });
  await agent.post('/t/pay').set('Idempotency-Key', 'k3').send({});
  expect((await agent.post('/t/other').set('Idempotency-Key', 'k3').send({})).status).toBe(422);
});
test('failed request can be retried', async () => {
  runs = 0; const { agent } = await loginAs(app, { roles: ['operations'] });
  await agent.post('/t/fail').set('Idempotency-Key', 'k4').send({});
  await agent.post('/t/fail').set('Idempotency-Key', 'k4').send({});
  expect(runs).toBe(2);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/idempotency.test.js` → FAIL.
- [ ] **Step 3: Implement** — insert the `in_progress` record (duplicate key → load and decide), wrap `res.json` to capture the response, then update to `done` or delete.
- [ ] **Step 4: Run to verify pass** — PASS (5 tests).
- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): idempotency keys for state-changing requests"
```

---

### Task 12: File storage and upload/download URLs

**Files:**
- Create: `apps/api/src/core/files/storage-s3.js`, `storage-local.js`, `purposes.js`, `routes.js`
- Modify: `apps/api/src/app.js` (mount `/v1/files`; mount `/v1/dev-files` only when `config.storage.adapter === 'local'`)
- Test: `apps/api/test/files.test.js`

**Interfaces:**
- Produces:
  - Storage interface (both implementations): `presignPut({ key, contentType, size }) → Promise<{ url, headers }>`, `presignGet(key, { expiresIn = 300 }) → Promise<string>`, `putObject({ key, body, contentType }) → Promise<void>` (body may be a Buffer or Readable), `getObject(key) → Promise<Readable>`, `headObject(key) → Promise<{ size, sha256? } | null>`.
  - `createS3Storage({ region, bucket })` — presigned PUT signs `Content-Type` and `Content-Length`. `createLocalStorage({ dir, apiOrigin, secret })` — presigned URLs point to `/v1/dev-files/<key>?exp=&sig=` (HMAC-SHA256); its router serves PUT/GET for valid signatures.
  - `createStorage(config, bucketKey = 'filesBucket')` picks the implementation.
  - `ALLOWED_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' }`, `MAX_UPLOAD_BYTES = 10485760`.
  - `registerFilePurpose(name, { allowedTypes = Object.keys(ALLOWED_TYPES), canWrite: (user) => boolean, canRead: (user, key) => Promise<boolean> })`; registered here: `branch_logo` (write: `settings.edit`; read: any authenticated user of that branch).
  - `POST /v1/files/upload-url { purpose, contentType, size }` → `{ key, url, headers }` with `key = <branchId>/<purpose>/<yyyy>/<uuid>.<ext>` (IST year). Errors: unknown purpose 400 `VALIDATION_FAILED`; type 400 `FILE_TYPE_NOT_ALLOWED`; size 400 `FILE_TOO_LARGE`; no permission 403.
  - `GET /v1/files/url?key=` → `{ url }`; another branch's key or `canRead` false → 404.

- [ ] **Step 1: Write the failing tests**

```js
import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createS3Storage } from '../src/core/files/storage-s3.js';
useTestDb();
const app = buildTestApp();

test('s3 presigned PUT signs length and type', async () => {
  process.env.AWS_ACCESS_KEY_ID = 'test'; process.env.AWS_SECRET_ACCESS_KEY = 'test';
  const { url } = await createS3Storage({ region: 'ap-south-1', bucket: 'b' }).presignPut({ key: 'k.png', contentType: 'image/png', size: 10 });
  expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
});
test('upload url for allowed file', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  const r = await agent.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'image/png', size: 1000 });
  expect(r.status).toBe(200);
  expect(r.body.key).toMatch(new RegExp(`^${user.branchId}/branch_logo/\\d{4}/[0-9a-f-]{36}\\.png$`));
});
test('rejects bad type, size and permission', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  expect((await agent.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'application/zip', size: 10 })).body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
  expect((await agent.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'image/png', size: 10485761 })).body.error.code).toBe('FILE_TOO_LARGE');
  const { agent: d } = await loginAs(app, { roles: ['designer'] });
  expect((await d.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'image/png', size: 10 })).status).toBe(403);
});
test('download url hides other branches', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  expect((await agent.get('/v1/files/url').query({ key: '000000000000000000000000/branch_logo/2026/x.png' })).status).toBe(404);
});
test('local storage round trip', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  const { body } = await agent.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'image/png', size: 3 });
  const put = await fetchLike(app, 'PUT', body.url, Buffer.from('abc'), body.headers);
  expect(put.status).toBe(200);
  const { body: g } = await agent.get('/v1/files/url').query({ key: body.key });
  expect((await fetchLike(app, 'GET', g.url)).body.toString()).toBe('abc');
});
```

(`buildTestApp` uses local storage in a fresh `os.tmpdir()` folder. `fetchLike(app, method, absoluteUrl, body?, headers?)` is a 5-line helper added to `test/helpers/app.js` that strips the origin and sends through supertest with `X-Requested-With`.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/files.test.js` → FAIL.
- [ ] **Step 3: Implement the four files and mounts.**
- [ ] **Step 4: Run to verify pass** — PASS (5 tests).
- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): S3/local storage and presigned file URLs"
```

---

### Task 13: Notification rendering, quiet hours, email layout

**Files:**
- Create: `apps/api/src/core/notify/render.js`, `quietHours.js`, `emailLayout.js`
- Test: `apps/api/test/notify-render.test.js`

**Interfaces:**
- Consumes: `istDate`, `istTime`, `atIstTime`, `addDaysYmd` (Task 3).
- Produces:
  - `renderTemplate(text, vars, { escape } = {}) → string` — replaces `{name}`; a missing variable throws `Error('Missing template variable: name')`.
  - `escapeHtml(s) → string`.
  - `nextAllowedTime(now: Date, window: { start: 'HH:mm', end: 'HH:mm' } | null) → Date` — returns `now` when outside the window or the window is null, otherwise the window's next IST end time; supports windows that cross midnight.
  - `renderEmail({ branch: { name, phone, email }, subject, body }) → { subject, html, text }` — `html` is a simple branded layout with the escaped body, newlines → `<br>`; `text` = body + `\n\n— ${branch.name}, ${branch.phone}`.

- [ ] **Step 1: Write the failing tests**

```js
import { test, expect } from 'vitest';
import { renderTemplate, escapeHtml } from '../src/core/notify/render.js';
import { nextAllowedTime } from '../src/core/notify/quietHours.js';
import { renderEmail } from '../src/core/notify/emailLayout.js';
const w = { start: '21:00', end: '09:00' };

test('renders variables', () => {
  expect(renderTemplate('Hi {customerName}, bill {invoiceNo}', { customerName: 'Asha', invoiceNo: 'INV/2627/0001' })).toBe('Hi Asha, bill INV/2627/0001');
  expect(() => renderTemplate('{customerName}', {})).toThrow('customerName');
  expect(renderTemplate('{x}', { x: '<b>' }, { escape: escapeHtml })).toBe('&lt;b&gt;');
});
test('quiet hours', () => {
  expect(nextAllowedTime(new Date('2026-10-22T16:30:00Z'), w)).toEqual(new Date('2026-10-23T03:30:00Z')); // 22:00 IST
  expect(nextAllowedTime(new Date('2026-10-21T19:00:00Z'), w)).toEqual(new Date('2026-10-22T03:30:00Z')); // 00:30 IST
  expect(nextAllowedTime(new Date('2026-10-22T03:29:00Z'), w)).toEqual(new Date('2026-10-22T03:30:00Z')); // 08:59 IST
  const day = new Date('2026-10-22T04:30:00Z'); // 10:00 IST
  expect(nextAllowedTime(day, w)).toEqual(day);
  expect(nextAllowedTime(day, null)).toEqual(day);
});
test('email layout', () => {
  const e = renderEmail({ branch: { name: 'Vastrasanskara', phone: '9876543210', email: 'a@b.c' }, subject: 'S', body: 'Line1\nLine2 <x>' });
  expect(e.html).toContain('Vastrasanskara');
  expect(e.html).toContain('Line1<br>Line2 &lt;x&gt;');
  expect(e.text).toBe('Line1\nLine2 <x>\n\n— Vastrasanskara, 9876543210');
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/notify-render.test.js` → FAIL.
- [ ] **Step 3: Implement the three files.**
- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): notification templates, quiet hours, email layout"
```

---

### Task 14: Notification catalog, recipients and `emit` → outbox

**Files:**
- Create: `apps/api/src/core/notify/catalog.js`, `recipients.js`, `models.js`, `emit.js`
- Test: `apps/api/test/notify-emit.test.js`

**Interfaces:**
- Consumes: `nextAllowedTime` (Task 13), `clock`, `User` model (Task 10), settings `quietHours` (Task 17 creates the settings service; until then `emit` reads quiet hours via `getQuietHours(branchId, session)` exported from `catalog.js` that falls back to `{ email: w, whatsapp: w, sms: w, in_app: null }`; Task 17 replaces the fallback with the settings lookup).
- Produces:
  - `defineEvent(name, { recipients: string[], channels: string[], fallback = null, templates: { [channel]: { subject?, body } } })`; `getEventDefinition(name)` (throws `Error('Unknown notification event: name')`).
  - Foundation events: `auth.password_reset` (recipients `['user']`, channels `['email']`), `system.backup_failed`, `system.storage_warning`, `system.job_failed` (recipients `['owner']`, channels `['in_app', 'email']`).
  - Models: `NotificationRule { branchId, event, recipients, channels, fallback, enabled }` (unique `{ branchId, event }`); `NotificationTemplate { branchId, event, channel, subject, body }`; `Outbox { branchId (String), event, channel, recipient: { kind: 'user'|'client', id, name, address, addresses }, vars, attachments: [{ key, filename }], scheduledFor, status: 'pending'|'sending'|'sent'|'delivered'|'failed'|'skipped', skipReason, attempts, lastError, providerMessageId, isFallback, dedupeKey (unique), lockedAt, sentAt, deliveredAt }`, index `{ status: 1, scheduledFor: 1 }`. `recipient.address` is this channel's address; `recipient.addresses` keeps all of them so a fallback entry can be created later.
  - `getRule(branchId, event, session)` — DB rule if present, else the definition's defaults.
  - `registerRecipientResolver(role, async ({ branchId, data, session }) => Recipient[])`, where `Recipient = { kind: 'user'|'client', id, name, addresses: { email?, phone?, in_app? }, consent?: { [channel]: boolean } }`. Registered here: `owner` (active users with role `admin`), `operations` (active users with role `operations`), `user` (`data.userId`). Users get `addresses.in_app = id`; consent is implied for `kind: 'user'`.
  - `emit(event, { branchId, refId, sequence = 1, data = {}, vars = {}, attachments = [] }, { session } = {}) → Promise<number>` — for each recipient × channel: `dedupeKey = [event, refId, sequence, channel, kind, id].join(':')`; upsert with `$setOnInsert`; status `skipped` + `skipReason: 'no_address' | 'no_consent'` when appropriate; client recipients get `scheduledFor = nextAllowedTime(now, quietHours[channel])`, users get `now`; returns the number of new entries. A disabled rule returns 0.

- [ ] **Step 1: Write the failing tests**

```js
import { test, expect, vi } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { createTestUser } from './helpers/app.js';
import { emit } from '../src/core/notify/emit.js';
import { defineEvent, registerRecipientResolver } from '../src/core/notify/catalog.js';
import { Outbox, NotificationRule } from '../src/core/notify/models.js';
import { withTransaction } from '../src/core/db.js';
import { clock } from '../src/clock.js';
import mongoose from 'mongoose';
useTestDb();
const B = new mongoose.Types.ObjectId().toString();

defineEvent('test.client', { recipients: ['client'], channels: ['email'], templates: { email: { subject: 'S', body: 'B' } } });
let client;
registerRecipientResolver('client', async () => [client]);

test('fans out to owners on all channels, once', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  const args = { branchId: u.branchId, refId: 'r1', vars: { error: 'x' } };
  expect(await emit('system.backup_failed', args)).toBe(2);
  expect(await emit('system.backup_failed', args)).toBe(0);
  expect((await Outbox.find()).map((o) => o.channel).sort()).toEqual(['email', 'in_app']);
});
test('disabled rule sends nothing', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  await NotificationRule.create({ branchId: u.branchId, event: 'system.backup_failed', recipients: ['owner'], channels: ['email'], enabled: false });
  expect(await emit('system.backup_failed', { branchId: u.branchId, refId: 'r' })).toBe(0);
});
test('client email held until quiet hours end', async () => {
  vi.spyOn(clock, 'now').mockReturnValue(new Date('2026-10-22T16:30:00Z'));
  client = { kind: 'client', id: 'c1', name: 'Asha', addresses: { email: 'asha@x.com' }, consent: { email: true } };
  await emit('test.client', { branchId: B, refId: 'r' });
  expect((await Outbox.findOne()).scheduledFor).toEqual(new Date('2026-10-23T03:30:00Z'));
  vi.restoreAllMocks();
});
test('skips client without consent', async () => {
  client = { kind: 'client', id: 'c2', name: 'B', addresses: { email: 'b@x.com' }, consent: { email: false } };
  await emit('test.client', { branchId: B, refId: 'r' });
  expect(await Outbox.findOne()).toMatchObject({ status: 'skipped', skipReason: 'no_consent' });
});
test('skips recipient without address', async () => {
  client = { kind: 'client', id: 'c3', name: 'C', addresses: {}, consent: { email: true } };
  await emit('test.client', { branchId: B, refId: 'r' });
  expect(await Outbox.findOne()).toMatchObject({ status: 'skipped', skipReason: 'no_address' });
});
test('nothing written when transaction aborts', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  await expect(withTransaction(async (session) => { await emit('system.job_failed', { branchId: u.branchId, refId: 'r' }, { session }); throw new Error('abort'); })).rejects.toThrow();
  expect(await Outbox.countDocuments()).toBe(0);
});
test('unknown event', async () => { await expect(emit('nope', { branchId: B, refId: 'r' })).rejects.toThrow('Unknown notification event'); });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/notify-emit.test.js` → FAIL.
- [ ] **Step 3: Implement the four files.**
- [ ] **Step 4: Run to verify pass** — PASS (7 tests).
- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): notification catalog, recipients and transactional outbox"
```

---

### Task 15: Channel adapters and delivery

**Files:**
- Create: `apps/api/src/core/notify/adapters/registry.js`, `inApp.js`, `emailSes.js`, `emailFile.js`, `apps/api/src/core/notify/deliver.js`
- Test: `apps/api/test/notify-deliver.test.js`, `apps/api/test/notify-ses.test.js`

**Interfaces:**
- Consumes: `Outbox`, `getRule`, `getEventDefinition`, `NotificationTemplate` (Task 14); `renderTemplate`, `renderEmail` (Task 13); storage `getObject` (Task 12); `Branch`.
- Produces:
  - Adapter shape: `{ channel, provider, capabilities: { attachments: boolean, templatesOnly: boolean, maxLength?: number }, send(message) → Promise<{ providerMessageId, status: 'sent'|'delivered' }>, parseWebhook?(req) → Promise<Array<{ providerMessageId, status, at }>> }`; `message = { to, subject?, text, html?, attachments: [{ filename, content: Readable }], event, vars }`.
  - `registerAdapter(adapter)`, `getAdapter(channel)`, `getAdapterByProvider(provider)`, `resetAdapters()` (tests).
  - `createInAppAdapter()` — channel `in_app`, provider `in_app`; creates `Notification { branchId, userId, event, message, link, read: false, createdAt }` (model `Notification` in `core/notify/models.js`; `link` from `vars.link`).
  - `createSesEmailAdapter({ region, from, storage })` — nodemailer SES transport with `SESv2Client` + `SendEmailCommand`; returns the SES `MessageId`. `createFileEmailAdapter({ dir, from })` — writes `.eml` files (dev).
  - `deliverDue({ now = clock.now(), limit = 50 } = {}) → Promise<{ sent, retried, failed }>` — atomically claims `pending` entries due by `now` (or `sending` with `lockedAt` older than 10 minutes) by setting `sending`; renders the template (DB template override, else the catalog default; email goes through `renderEmail` with the branch); sends; success → `sent`, `sentAt`, `providerMessageId`; failure → `attempts + 1`, `lastError`, back to `pending` with `scheduledFor = now + [1, 5, 15, 60][attempts - 1]` minutes; at 5 attempts → `failed`, and when the rule has a `fallback` and the entry is not itself a fallback, a new entry for the fallback channel (`dedupeKey + ':fallback'`, `isFallback: true`, `scheduledFor: now`).

- [ ] **Step 1: Write the failing tests**

```js
// notify-deliver.test.js
import { test, expect, vi, beforeEach } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { createTestUser } from './helpers/app.js';
import { emit } from '../src/core/notify/emit.js';
import { defineEvent } from '../src/core/notify/catalog.js';
import { Outbox } from '../src/core/notify/models.js';
import { deliverDue } from '../src/core/notify/deliver.js';
import { registerAdapter, resetAdapters } from '../src/core/notify/adapters/registry.js';
import { createInAppAdapter } from '../src/core/notify/adapters/inApp.js';
import { Notification } from '../src/core/notify/models.js';
useTestDb();
defineEvent('test.fb', { recipients: ['owner'], channels: ['email'], fallback: 'in_app', templates: { email: { subject: 'S {n}', body: 'B {n}' }, in_app: { body: 'B {n}' } } });
const fake = { channel: 'email', provider: 'fake', capabilities: { attachments: true, templatesOnly: false }, send: vi.fn() };
beforeEach(() => { resetAdapters(); registerAdapter(fake); registerAdapter(createInAppAdapter()); fake.send.mockReset(); });
const now = new Date('2026-10-22T06:00:00Z');

test('sends due entries with rendered content', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  fake.send.mockResolvedValue({ providerMessageId: 'm1', status: 'sent' });
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: { n: '7' } });
  expect(await deliverDue({ now })).toMatchObject({ sent: 1 });
  expect(fake.send.mock.calls[0][0]).toMatchObject({ to: u.email, subject: 'S 7', text: expect.stringContaining('B 7') });
  expect(await Outbox.findOne()).toMatchObject({ status: 'sent', providerMessageId: 'm1' });
});
test('future entries wait', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: { n: 1 } });
  await Outbox.updateMany({}, { scheduledFor: new Date(now.getTime() + 60_000) });
  expect(await deliverDue({ now })).toMatchObject({ sent: 0 });
});
test('retries with backoff then falls back', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  fake.send.mockRejectedValue(new Error('down'));
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: { n: 1 } });
  await deliverDue({ now });
  expect((await Outbox.findOne({ channel: 'email' })).scheduledFor).toEqual(new Date(now.getTime() + 60_000));
  for (let i = 0; i < 4; i++) await deliverDue({ now: new Date(now.getTime() + 24 * 3600_000 * (i + 1)) });
  expect(await Outbox.findOne({ channel: 'email' })).toMatchObject({ status: 'failed', attempts: 5 });
  await deliverDue({ now: new Date(now.getTime() + 6 * 24 * 3600_000) });
  expect(await Notification.countDocuments({ userId: u._id })).toBe(1);
});
test('reclaims stale sending entries', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  fake.send.mockResolvedValue({ providerMessageId: 'm', status: 'sent' });
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: { n: 1 } });
  await Outbox.updateMany({}, { status: 'sending', lockedAt: new Date(now.getTime() - 11 * 60_000) });
  expect(await deliverDue({ now })).toMatchObject({ sent: 1 });
});
test('concurrent runs send once', async () => {
  const u = await createTestUser({ roles: ['admin'] });
  fake.send.mockResolvedValue({ providerMessageId: 'm', status: 'sent' });
  await emit('test.fb', { branchId: u.branchId, refId: 'r', vars: { n: 1 } });
  await Promise.all([deliverDue({ now }), deliverDue({ now })]);
  expect(fake.send).toHaveBeenCalledTimes(1);
});
```

```js
// notify-ses.test.js
import { test, expect } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { createSesEmailAdapter } from '../src/core/notify/adapters/emailSes.js';
test('sends raw MIME through SESv2', async () => {
  const ses = mockClient(SESv2Client); ses.on(SendEmailCommand).resolves({ MessageId: 'abc' });
  const a = createSesEmailAdapter({ region: 'ap-south-1', from: 'no-reply@x.com', storage: {} });
  expect(await a.send({ to: 'a@b.c', subject: 'S', text: 'T', html: '<p>T</p>', attachments: [] })).toEqual({ providerMessageId: 'abc', status: 'sent' });
  expect(ses.commandCalls(SendEmailCommand)[0].args[0].input.Content.Raw).toBeDefined();
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/notify-deliver.test.js apps/api/test/notify-ses.test.js` → FAIL.
- [ ] **Step 3: Implement the adapters, registry and `deliverDue`.** Adapters are registered at startup from config in `server.js`/`worker.js` (`mail.adapter === 'ses'` → SES, else file).
- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): channel adapters and outbox delivery with retry and fallback"
```

---

### Task 16: Notifications API, webhooks, failed-outbox admin

**Files:**
- Create: `apps/api/src/core/notify/routes.js`
- Modify: `apps/api/src/app.js` (mount `/v1/notifications`, `/v1/webhooks` before session/CSRF, `/v1/admin/outbox`)
- Test: `apps/api/test/notify-routes.test.js`

**Interfaces:**
- Consumes: `Notification`, `Outbox`, `getAdapterByProvider`, `requirePermission`.
- Produces:
  - `GET /v1/notifications?unread=true` → `{ items: [{ id, event, message, link, read, createdAt }], unreadCount }` (own only, newest first, max 50).
  - `POST /v1/notifications/:id/read` → 204 (another user's id → 404); `POST /v1/notifications/read-all` → 204.
  - `POST /v1/webhooks/:provider` → unknown provider or no `parseWebhook` → 404; otherwise each parsed status updates `Outbox` by `providerMessageId` (`delivered` sets `deliveredAt`; `failed` sets `lastError`) → 200.
  - `GET /v1/admin/outbox?status=failed` (`system.monitor`) → `{ items }` newest first, max 100; `POST /v1/admin/outbox/:id/retry` → `status: 'pending', attempts: 0, scheduledFor: now` → 204.

- [ ] **Step 1: Write the failing tests**

```js
import { test, expect } from 'vitest';
import request from 'supertest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { Notification } from '../src/core/notify/models.js';
import { Outbox } from '../src/core/notify/models.js';
import { registerAdapter } from '../src/core/notify/adapters/registry.js';
useTestDb();
const app = buildTestApp();

test('lists own notifications with unread count', async () => {
  const { agent, user } = await loginAs(app, { roles: ['operations'] });
  const { user: other } = await loginAs(app, { roles: ['operations'] });
  await Notification.create([{ branchId: user.branchId, userId: user._id, event: 'e', message: 'm' }, { branchId: user.branchId, userId: other._id, event: 'e', message: 'x' }]);
  const r = await agent.get('/v1/notifications');
  expect(r.body.items).toHaveLength(1); expect(r.body.unreadCount).toBe(1);
});
test('cannot mark another user notification', async () => {
  const { agent, user } = await loginAs(app, { roles: ['operations'] });
  const { user: other } = await loginAs(app, { roles: ['operations'] });
  const n = await Notification.create({ branchId: user.branchId, userId: other._id, event: 'e', message: 'x' });
  expect((await agent.post(`/v1/notifications/${n._id}/read`).send({})).status).toBe(404);
});
test('webhook updates delivery status', async () => {
  registerAdapter({ channel: 'whatsapp', provider: 'fakewa', capabilities: {}, send: async () => ({}), parseWebhook: async (req) => req.body.events });
  await Outbox.create({ branchId: 'b', event: 'e', channel: 'whatsapp', recipient: { kind: 'client', id: 'c' }, status: 'sent', providerMessageId: 'p1', dedupeKey: 'd', scheduledFor: new Date() });
  const r = await request(app).post('/v1/webhooks/fakewa').send({ events: [{ providerMessageId: 'p1', status: 'delivered', at: '2026-10-22T06:00:00Z' }] });
  expect(r.status).toBe(200);
  expect(await Outbox.findOne({ providerMessageId: 'p1' })).toMatchObject({ status: 'delivered' });
  expect((await request(app).post('/v1/webhooks/nope').send({})).status).toBe(404);
});
test('admin sees and retries failed entries', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  const o = await Outbox.create({ branchId: 'b', event: 'e', channel: 'email', recipient: { kind: 'user', id: 'u' }, status: 'failed', attempts: 5, dedupeKey: 'f', scheduledFor: new Date() });
  expect((await agent.get('/v1/admin/outbox').query({ status: 'failed' })).body.items).toHaveLength(1);
  await agent.post(`/v1/admin/outbox/${o._id}/retry`).send({});
  expect(await Outbox.findById(o._id)).toMatchObject({ status: 'pending', attempts: 0 });
  const { agent: ops } = await loginAs(app, { roles: ['operations'] });
  expect((await ops.get('/v1/admin/outbox')).status).toBe(403);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/notify-routes.test.js` → FAIL.
- [ ] **Step 3: Implement routes and mounts.**
- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): notifications API, provider webhooks, failed outbox admin"
```

---

### Task 17: Settings, branch, users management, password reset, bootstrap

**Files:**
- Create: `packages/shared/src/schemas/settings.js`, `packages/shared/src/schemas/users.js`
- Create: `apps/api/src/modules/settings/model.js`, `service.js`, `routes.js`; `apps/api/src/modules/branches/service.js`; `apps/api/src/modules/users/service.js`, `routes.js`, `passwordReset.js`; `apps/api/src/cli/bootstrap.js`
- Modify: `apps/api/src/core/notify/catalog.js` (`getQuietHours` reads settings), `apps/api/src/app.js`
- Test: `apps/api/test/settings.test.js`, `apps/api/test/users.test.js`, `apps/api/test/bootstrap.test.js`

**Interfaces:**
- Consumes: `recordAudit`, `actorFrom`, `revokeUserSessions`, `hashPassword`, `emit`, `withTransaction`, `STAGE_KEYS`, common schemas.
- Produces:
  - `settingsSchema` (zod strict, shared) and `DEFAULT_SETTINGS`:
    `advancePercent: 100` (0–100 int); `billDueDays: 0` (0–365 int); `cancellationRefundSchedule: []` (`[{ uptoStage: stageKey, refundPercent: 0–100 }]`); `uncollectedFlagDays: 7`; `stageDurations: { default: { materials_ready: 2, pattern_making: 1, handwork: 7, quality_check: 1, masters_cutting: 1, tailors: 4, trials_fittings: 2, finishing: 2, branding: 1, final_qc: 1, packaging: 1 }, byGarmentType: {} }`; `appointmentDurations: { consultation: 60, measurement: 30, fitting: 45, pickup: 15 }`; `quietHours: { email: { start: '21:00', end: '09:00' }, whatsapp: { start: '21:00', end: '09:00' }, sms: { start: '21:00', end: '09:00' }, in_app: null }`; `b2clThreshold: 10000000`; `numberSeries: {}` (keys `'<docType>:<fyCode>'` → positive int start); `dailyJobTime: '08:00'`; `closingTime: '20:00'`.
  - `getSettings(branchId, session?) → Promise<Settings>` (creates defaults on first read); `updateSettings(branchId, patch, actor) → Promise<Settings>` (validates the merged result, saves and audits `entityType: 'settings'` in one transaction).
  - `getBranch(branchId)`, `updateBranch(branchId, patch, actor)` (audited; `gstin` validated; `stateCode` must equal the GSTIN's first two digits → 422 `STATE_GSTIN_MISMATCH`).
  - Routes: `GET /v1/settings` (any authenticated), `PUT /v1/settings` (`settings.edit`), `GET /v1/branch`, `PUT /v1/branch` (`settings.edit`).
  - Users routes (`users.manage`): `GET /v1/users`, `POST /v1/users { name, email, roles }` → 201 + invite (password-reset email), `PATCH /v1/users/:id { name?, roles?, active? }` → revokes that user's sessions when roles or active change. Errors: 409 `EMAIL_TAKEN`; 422 `CANNOT_DEACTIVATE_SELF`; 422 `LAST_ADMIN` (removing admin role from, or deactivating, the last active admin). All changes audited.
  - Password reset: `POST /v1/auth/password-reset/request { email }` → always 204; for an active user creates `PasswordReset { userId, tokenHash (sha256), expiresAt: now + 30 min, usedAt }` and emits `auth.password_reset` with `vars: { name, resetUrl: appOrigin + '/reset-password?token=' + token }`. `POST /v1/auth/password-reset/confirm { token, password }` → 204, sets the password, marks the token used, revokes all sessions, clears lockout; invalid/used/expired → 400 `RESET_TOKEN_INVALID`.
  - `bootstrap({ branch, admin: { name, email, password } }) → Promise<{ branchId, adminId }>` — creates branch, default settings, notification rule defaults and the admin in one transaction; throws `Error('Already bootstrapped')` if any branch exists. CLI `node apps/api/src/cli/bootstrap.js` reads `BOOTSTRAP_*` env vars.

- [ ] **Step 1: Write the failing tests**

```js
// settings.test.js
import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { AuditLog } from '../src/core/audit/model.js';
useTestDb();
const app = buildTestApp();

test('defaults', async () => {
  const { agent } = await loginAs(app, { roles: ['designer'] });
  const r = await agent.get('/v1/settings');
  expect(r.body).toMatchObject({ advancePercent: 100, billDueDays: 0, uncollectedFlagDays: 7, dailyJobTime: '08:00', closingTime: '20:00', b2clThreshold: 10000000 });
  expect(r.body.quietHours.email).toEqual({ start: '21:00', end: '09:00' });
});
test('admin updates with audit; others forbidden; invalid rejected', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  expect((await agent.put('/v1/settings').send({ billDueDays: 5 })).body.billDueDays).toBe(5);
  expect((await AuditLog.findOne({ entityType: 'settings' })).changes).toEqual([{ path: 'billDueDays', before: 0, after: 5 }]);
  expect((await agent.put('/v1/settings').send({ advancePercent: 150 })).status).toBe(400);
  const { agent: ops } = await loginAs(app, { roles: ['operations'] });
  expect((await ops.put('/v1/settings').send({ billDueDays: 1 })).status).toBe(403);
});
test('branch state must match GSTIN', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  expect((await agent.put('/v1/branch').send({ gstin: '29ABCDE1234F1Z5', stateCode: '32' })).body.error.code).toBe('STATE_GSTIN_MISMATCH');
});
```

```js
// users.test.js
import { test, expect, vi } from 'vitest';
import request from 'supertest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs, api } from './helpers/app.js';
import { Outbox } from '../src/core/notify/models.js';
import { clock } from '../src/clock.js';
useTestDb();
const app = buildTestApp();
const tokenFromOutbox = async () => new URL((await Outbox.findOne({ event: 'auth.password_reset' }).sort({ _id: -1 })).vars.resetUrl).searchParams.get('token');

test('admin creates user and invite is queued', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  const r = await agent.post('/v1/users').send({ name: 'Riya', email: 'Riya@X.com', roles: ['designer'] });
  expect(r.status).toBe(201); expect(r.body.email).toBe('riya@x.com');
  expect(await tokenFromOutbox()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await agent.post('/v1/users').send({ name: 'R', email: 'riya@x.com', roles: ['designer'] })).body.error.code).toBe('EMAIL_TAKEN');
});
test('role change logs the user out', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  const { agent: d, user } = await loginAs(app, { roles: ['designer'] });
  await agent.patch(`/v1/users/${user._id}`).send({ roles: ['operations'] });
  expect((await d.get('/v1/auth/me')).status).toBe(401);
});
test('guards self-deactivation and last admin', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  expect((await agent.patch(`/v1/users/${user._id}`).send({ active: false })).body.error.code).toBe('CANNOT_DEACTIVATE_SELF');
  expect((await agent.patch(`/v1/users/${user._id}`).send({ roles: ['operations'] })).body.error.code).toBe('LAST_ADMIN');
});
test('password reset flow', async () => {
  const { user } = await loginAs(app, { roles: ['operations'] });
  const anon = api(request(app));
  expect((await anon.post('/v1/auth/password-reset/request').send({ email: 'nobody@x.com' })).status).toBe(204);
  expect(await Outbox.countDocuments({ event: 'auth.password_reset' })).toBe(0);
  await anon.post('/v1/auth/password-reset/request').send({ email: user.email });
  const token = await tokenFromOutbox();
  expect((await anon.post('/v1/auth/password-reset/confirm').send({ token, password: 'short' })).status).toBe(400);
  expect((await anon.post('/v1/auth/password-reset/confirm').send({ token, password: 'brand-new-pass-1' })).status).toBe(204);
  expect((await anon.post('/v1/auth/password-reset/confirm').send({ token, password: 'brand-new-pass-2' })).body.error.code).toBe('RESET_TOKEN_INVALID');
  expect((await anon.post('/v1/auth/login').send({ email: user.email, password: 'brand-new-pass-1' })).status).toBe(200);
});
test('expired reset token', async () => {
  const { user } = await loginAs(app, { roles: ['operations'] });
  const anon = api(request(app));
  await anon.post('/v1/auth/password-reset/request').send({ email: user.email });
  const token = await tokenFromOutbox();
  vi.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + 31 * 60_000));
  expect((await anon.post('/v1/auth/password-reset/confirm').send({ token, password: 'brand-new-pass-1' })).body.error.code).toBe('RESET_TOKEN_INVALID');
  vi.restoreAllMocks();
});
```

```js
// bootstrap.test.js
import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { bootstrap } from '../src/cli/bootstrap.js';
import { getSettings } from '../src/modules/settings/service.js';
useTestDb();
const input = { branch: { name: 'Vastrasanskara', legalName: 'Vastrasanskara', gstin: '29ABCDE1234F1Z5', stateCode: '29', address: { line1: 'x', city: 'Bengaluru', pincode: '560001' }, phone: '9876543210', email: 'hello@vs.in' }, admin: { name: 'Owner', email: 'owner@vs.in', password: 'correct-horse-1' } };
test('bootstraps once', async () => {
  const { branchId } = await bootstrap(input);
  expect((await getSettings(branchId)).advancePercent).toBe(100);
  await expect(bootstrap(input)).rejects.toThrow('Already bootstrapped');
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/settings.test.js apps/api/test/users.test.js apps/api/test/bootstrap.test.js` → FAIL.
- [ ] **Step 3: Implement.** Reset tokens: `crypto.randomBytes(32).toString('base64url')`.
- [ ] **Step 4: Run the whole API suite** — `npx vitest run apps/api` → PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/api && git commit -m "feat(api): settings, branch, user management, password reset, bootstrap"
```

---

### Task 18: Worker — job registry, heartbeat, failures, outbox job

**Files:**
- Create: `apps/api/src/core/jobs/registry.js`, `runJob.js`, `worker.js`, `routes.js`; `apps/api/src/worker.js`
- Modify: `apps/api/src/modules/health/routes.js` (worker heartbeat), `apps/api/src/app.js` (mount `/v1/admin/jobs`)
- Test: `apps/api/test/jobs.test.js`

**Interfaces:**
- Consumes: `deliverDue` (Task 15), `emit`, `istDate`, `clock`.
- Produces:
  - `defineJob(name, { schedule: string /* agenda interval or cron */, handler: async (ctx) => void, retries = 0 })`; `getJobDefinitions() → Map`.
  - `runJob(name, ctx) → Promise<{ ok: boolean }>` — runs the handler; on throw writes `JobFailure { job, error, attempt, at }` and emits `system.job_failed` with `refId: name + ':' + istDate(now)` and `vars: { job: name, error: message }` for every branch; for one-off jobs (`retries > 0`) schedules the retry after 1, 5, 15 minutes.
  - `startWorker({ config }) → Promise<{ agenda, stop }>` — Agenda on the Mongoose connection's db, `processEvery: '30 seconds'`, `defaultConcurrency: 1`, schedules every definition with `{ timezone: 'Asia/Kolkata' }`.
  - Jobs defined at module load of `core/jobs/worker.js` (so importing it registers them): `heartbeat` (every minute, upserts `system` `{ _id: 'worker-heartbeat', at }`), `deliver-outbox` (every minute → `deliverDue()`).
  - Health: `{ db, worker: 'ok' | 'stale' }`; worker stale when the heartbeat is missing or older than 3 minutes; 503 when db is down or worker stale.
  - `GET /v1/admin/jobs/failures` (`system.monitor`) → `{ items }` newest first, max 100.

- [ ] **Step 1: Write the failing tests**

```js
import { test, expect } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, createTestUser } from './helpers/app.js';
import { defineJob, getJobDefinitions } from '../src/core/jobs/registry.js';
import { runJob } from '../src/core/jobs/runJob.js';
import { startWorker } from '../src/core/jobs/worker.js';
import { Outbox } from '../src/core/notify/models.js';
useTestDb();
const app = buildTestApp();

test('failed job is recorded and alerts the owner', async () => {
  await createTestUser({ roles: ['admin'] });
  defineJob('t-fail', { schedule: '1 hour', handler: async () => { throw new Error('boom'); } });
  expect(await runJob('t-fail', {})).toEqual({ ok: false });
  expect(await mongoose.connection.collection('jobFailures').countDocuments({ job: 't-fail' })).toBe(1);
  expect(await Outbox.countDocuments({ event: 'system.job_failed' })).toBe(2);
});
test('health reports stale worker, then ok after heartbeat', async () => {
  expect((await request(app).get('/v1/health')).status).toBe(503);
  await runJob('heartbeat', {});
  const r = await request(app).get('/v1/health');
  expect(r.status).toBe(200); expect(r.body).toEqual({ db: 'ok', worker: 'ok' });
});
test('worker schedules core jobs', async () => {
  const { stop } = await startWorker({ config: { env: 'test' } });
  expect([...getJobDefinitions().keys()]).toEqual(expect.arrayContaining(['heartbeat', 'deliver-outbox']));
  await stop();
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/jobs.test.js` → FAIL.
- [ ] **Step 3: Implement.** Update `apps/api/test/health.test.js` to expect `db: 'ok'` only via `toMatchObject` (the worker check is covered here).
- [ ] **Step 4: Run** — `npx vitest run apps/api` → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): agenda worker, job failure alerts, heartbeat health"
```

---

### Task 19: Backups and storage check

**Files:**
- Create: `apps/api/src/core/backup/backup.js`, `storageCheck.js`; `docs/ops/restore.md`
- Modify: `apps/api/src/worker.js` (register jobs)
- Test: `apps/api/test/backup.test.js`

**Interfaces:**
- Consumes: storage `putObject` (Task 12, backups bucket via `createStorage(config, 'backupsBucket')`), `emit`, `defineJob`, `istDate`/`istTime`.
- Produces:
  - `runBackup({ now = clock.now(), dump, storage }) → Promise<{ key }>` — `dump()` returns a Readable (production: `spawn('mongodump', ['--uri', mongoUri, '--archive', '--gzip']).stdout`, rejecting on non-zero exit); key `mongodump/YYYY/MM/DD/HHmm.archive.gz` in IST; on failure emits `system.backup_failed` (`refId: key`, `vars: { error }`) for every branch and rethrows.
  - `checkStorage({ usedBytes, quotaBytes = 536870912, now }) → Promise<{ ratio, warned }>` — warns at ≥ 0.7 by emitting `system.storage_warning` with `refId: istDate(now)` and `vars: { usedMb, quotaMb, percent }`. Production gets `usedBytes` from `db.stats()` as `dataSize + indexSize`.
  - Jobs: `backup` schedule `0 */6 * * *`; `storage-check` schedule `0 9 * * 1`.
  - `docs/ops/restore.md`: list backups (`aws s3 ls s3://<backups>/mongodump/ --recursive`), download, `mongorestore --uri <target> --archive=<file> --gzip --drop`, verify via `/v1/health` and the admin "Verify audit trail" check (added in the billing milestone).

- [ ] **Step 1: Write the failing tests**

```js
import { test, expect } from 'vitest';
import { Readable } from 'node:stream';
import { useTestDb } from './helpers/db.js';
import { createTestUser } from './helpers/app.js';
import { runBackup } from '../src/core/backup/backup.js';
import { checkStorage } from '../src/core/backup/storageCheck.js';
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
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/api/test/backup.test.js` → FAIL.
- [ ] **Step 3: Implement and write `docs/ops/restore.md`.**
- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/api docs/ops && git commit -m "feat(api): six-hourly mongodump backups and storage warning"
```

---

### Task 20: Web shell — API client, auth, login, layout, notification bell

**Files:**
- Create: `apps/web/index.html`, `vite.config.js`, `src/main.jsx`, `src/App.jsx`, `src/theme.js`, `src/lib/api.js`, `src/lib/errorMessages.js`, `src/lib/queryClient.js`, `src/auth/AuthProvider.jsx`, `src/auth/RequireAuth.jsx`, `src/auth/LoginPage.jsx`, `src/layout/AppLayout.jsx`, `src/layout/navItems.js`, `src/notifications/NotificationBell.jsx`, `src/features/home/HomePage.jsx`, `src/test/setup.js`, `src/test/server.js`
- Test: `apps/web/src/lib/api.test.js`, `apps/web/src/auth/LoginPage.test.jsx`, `apps/web/src/layout/AppLayout.test.jsx`

**Interfaces:**
- Consumes: API routes from Tasks 10, 16 (`/v1/auth/*`, `/v1/notifications`).
- Produces:
  - `vite.config.js`: dev server proxy `'/v1' → 'http://localhost:4000'` (same origin locally, so cookies work without HTTPS); production uses `VITE_API_URL=https://api.<domain>`.
  - `apiFetch(path, { method = 'GET', body, idempotencyKey, query } = {}) → Promise<any>` — base `import.meta.env.VITE_API_URL ?? ''`, `credentials: 'include'`, headers `X-Requested-With: vs-app` and `Content-Type: application/json` when there is a body, `Idempotency-Key` when given; 204 → `null`; error → throws `ApiError { status, code, message, details }` with `message` from `errorMessages[code]` falling back to the server message.
  - `errorMessages`: `INVALID_CREDENTIALS: 'Email or password is incorrect.'`, `ACCOUNT_LOCKED: 'Too many failed attempts. Try again in 15 minutes.'`, `RATE_LIMITED: 'Too many attempts. Please wait and try again.'`, `SESSION_EXPIRED: 'Your session has expired. Please log in again.'`, `NOT_AUTHENTICATED: 'Please log in.'`, `FORBIDDEN: 'You do not have access to this.'`, `CONFLICT: 'Someone else changed this. Reload and try again.'`, `PERIOD_LOCKED: 'This month is locked for filing and cannot be changed.'`, `FILE_TYPE_NOT_ALLOWED: 'Only JPG, PNG, WebP, HEIC or PDF files can be uploaded.'`, `FILE_TOO_LARGE: 'Files must be 10 MB or smaller.'`, `EMAIL_TAKEN: 'A user with this email already exists.'`, `LAST_ADMIN: 'At least one active admin is required.'`, `CANNOT_DEACTIVATE_SELF: 'You cannot deactivate your own account.'`, `RESET_TOKEN_INVALID: 'This reset link is invalid or has expired.'`.
  - `AuthProvider` / `useAuth() → { user, loading, can(permission), login(email, password), logout() }` — loads `/v1/auth/me` on start; a 401 from any query clears the user and sends them to `/login`.
  - `navItems: Array<{ label, path, permission? }>` — Home `/`; Users `/users` (`users.manage`); Settings `/settings` (`settings.edit`). Later milestones append items.
  - `AppLayout` — Mantine `AppShell` with a burger on small screens, nav filtered by `can`, `NotificationBell` (polls `/v1/notifications` every 60 000 ms, shows `unreadCount`, menu lists items and marks them read), logout button.

- [ ] **Step 1: Write the failing tests** (msw handlers in `src/test/server.js`; `setup.js` starts the server and loads jest-dom)

```js
// api.test.js
import { test, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../test/server.js';
import { apiFetch } from './api.js';
test('sends app header, credentials and idempotency key', async () => {
  let seen;
  server.use(http.post('/v1/x', ({ request }) => { seen = request; return HttpResponse.json({ ok: 1 }); }));
  await apiFetch('/v1/x', { method: 'POST', body: { a: 1 }, idempotencyKey: 'k' });
  expect(seen.headers.get('x-requested-with')).toBe('vs-app');
  expect(seen.headers.get('idempotency-key')).toBe('k');
  expect(seen.credentials).toBe('include');
});
test('maps error codes to messages', async () => {
  server.use(http.get('/v1/y', () => HttpResponse.json({ error: { code: 'PERIOD_LOCKED', message: 'x' } }, { status: 422 })));
  await expect(apiFetch('/v1/y')).rejects.toMatchObject({ status: 422, code: 'PERIOD_LOCKED', message: 'This month is locked for filing and cannot be changed.' });
});
```

```jsx
// LoginPage.test.jsx
import { test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../test/server.js';
import { renderApp } from '../test/setup.js';
test('shows friendly error on bad credentials', async () => {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json({ error: { code: 'NOT_AUTHENTICATED' } }, { status: 401 })),
             http.post('/v1/auth/login', () => HttpResponse.json({ error: { code: 'INVALID_CREDENTIALS' } }, { status: 401 })));
  renderApp('/login');
  await userEvent.type(await screen.findByLabelText('Email'), 'a@b.c');
  await userEvent.type(screen.getByLabelText('Password'), 'wrong-pass-1');
  await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
  expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument();
});
test('redirects home after login', async () => {
  const me = { id: '1', name: 'Owner', email: 'o@x.com', roles: ['admin'], permissions: ['users.manage', 'settings.edit'] };
  let loggedIn = false;
  server.use(http.get('/v1/auth/me', () => loggedIn ? HttpResponse.json(me) : HttpResponse.json({ error: { code: 'NOT_AUTHENTICATED' } }, { status: 401 })),
             http.post('/v1/auth/login', () => { loggedIn = true; return HttpResponse.json({ user: me }); }));
  renderApp('/login');
  await userEvent.type(await screen.findByLabelText('Email'), 'o@x.com');
  await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-1');
  await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
  expect(await screen.findByText('Welcome, Owner')).toBeInTheDocument();
});
```

```jsx
// AppLayout.test.jsx
import { test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/server.js';
import { renderApp } from '../test/setup.js';
test('designer sees no admin links; bell shows unread count', async () => {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json({ id: '2', name: 'Riya', email: 'r@x.com', roles: ['designer'], permissions: ['production.update'] })),
             http.get('/v1/notifications', () => HttpResponse.json({ items: [], unreadCount: 3 })));
  renderApp('/');
  expect(await screen.findByText('Welcome, Riya')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();
  expect(await screen.findByLabelText('3 unread notifications')).toBeInTheDocument();
});
```

(`renderApp(path)` in `src/test/setup.js` renders `<App />` inside a `MemoryRouter` at `path` with a fresh `QueryClient` and `MantineProvider`; `App` accepts an optional `router` prop so tests can swap in `MemoryRouter`.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement the files listed above.** `HomePage` shows `Welcome, {user.name}` (the dashboard replaces it in the dashboard milestone).
- [ ] **Step 4: Run to verify pass, then build** — `npx vitest run --project web && npm run build -w @vs/web` → PASS; build emits `apps/web/dist/index.html`.
- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "feat(web): app shell with auth, layout and notification bell"
```

---

### Task 21: Web admin pages — users, settings, password reset

**Files:**
- Create: `apps/web/src/features/users/UsersPage.jsx`, `apps/web/src/features/settings/SettingsPage.jsx`, `apps/web/src/auth/ForgotPasswordPage.jsx`, `apps/web/src/auth/ResetPasswordPage.jsx`
- Modify: `apps/web/src/App.jsx` (routes `/users`, `/settings`, `/forgot-password`, `/reset-password`), `apps/web/src/auth/LoginPage.jsx` (link "Forgot password?")
- Test: `apps/web/src/features/users/UsersPage.test.jsx`, `apps/web/src/features/settings/SettingsPage.test.jsx`, `apps/web/src/auth/ResetPasswordPage.test.jsx`

**Interfaces:**
- Consumes: `/v1/users`, `/v1/settings`, `/v1/branch`, `/v1/auth/password-reset/*` (Task 17); `apiFetch`, `useAuth` (Task 20); `settingsSchema`, `STAGES` from `@vs/shared` (client-side validation and stage labels).
- Produces:
  - **UsersPage:** table (name, email, roles, active); "Add user" modal (Name, Email, Roles multi-select of Admin/Operations/Designer) → POST; row actions to edit roles and toggle active → PATCH; API errors shown inline via `ApiError.message`.
  - **SettingsPage:** tabs "Business" (branch details + logo upload via `/v1/files/upload-url`), "Money" (advance %, bill due days, cancellation refund schedule rows, B2CL threshold in rupees), "Production" (default days per stage using `STAGES` labels; per-garment-type overrides table), "Appointments" (minutes per type), "Notifications" (quiet hours per channel, daily job time, closing time), "Numbering" (start number per document type for the current financial year). Saves with PUT; field errors from `VALIDATION_FAILED.details` shown under the matching inputs.
  - **ForgotPasswordPage:** email → request → always shows "If that email has an account, a reset link has been sent."
  - **ResetPasswordPage:** reads `token` from the query string; "New password" + "Confirm password"; mismatch → "Passwords do not match." (no request); success → "Password updated. You can now log in." with a link to `/login`.

- [ ] **Step 1: Write the failing tests**

```jsx
// UsersPage.test.jsx
import { test, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asAdmin } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
test('creates a user', async () => {
  asAdmin(); let body;
  server.use(http.get('/v1/users', () => HttpResponse.json({ items: [] })),
             http.post('/v1/users', async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: 'n', ...body }, { status: 201 }); }));
  renderApp('/users');
  await userEvent.click(await screen.findByRole('button', { name: 'Add user' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Riya');
  await userEvent.type(within(dialog).getByLabelText('Email'), 'riya@x.com');
  await userEvent.click(within(dialog).getByLabelText('Designer'));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create user' }));
  expect(body).toEqual({ name: 'Riya', email: 'riya@x.com', roles: ['designer'] });
});
test('shows server error', async () => {
  asAdmin();
  server.use(http.get('/v1/users', () => HttpResponse.json({ items: [] })),
             http.post('/v1/users', () => HttpResponse.json({ error: { code: 'EMAIL_TAKEN' } }, { status: 409 })));
  renderApp('/users');
  await userEvent.click(await screen.findByRole('button', { name: 'Add user' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Name'), 'R');
  await userEvent.type(within(dialog).getByLabelText('Email'), 'r@x.com');
  await userEvent.click(within(dialog).getByLabelText('Designer'));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create user' }));
  expect(await within(dialog).findByText('A user with this email already exists.')).toBeInTheDocument();
});
```

```jsx
// SettingsPage.test.jsx
import { test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asAdmin, defaultSettings } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
test('saves bill due days and shows field errors', async () => {
  asAdmin(); let sent;
  server.use(http.get('/v1/settings', () => HttpResponse.json(defaultSettings)),
             http.put('/v1/settings', async ({ request }) => { sent = await request.json();
               return HttpResponse.json({ error: { code: 'VALIDATION_FAILED', details: [{ path: 'billDueDays', message: 'Too big' }] } }, { status: 400 }); }));
  renderApp('/settings');
  await userEvent.click(await screen.findByRole('tab', { name: 'Money' }));
  const input = screen.getByLabelText('Bill due days');
  await userEvent.clear(input); await userEvent.type(input, '400');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(sent.billDueDays).toBe(400);
  expect(await screen.findByText('Too big')).toBeInTheDocument();
});
```

```jsx
// ResetPasswordPage.test.jsx
import { test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asAnonymous } from '../test/server.js';
import { renderApp } from '../test/setup.js';
test('mismatch blocks submit; success confirms', async () => {
  asAnonymous(); let body;
  server.use(http.post('/v1/auth/password-reset/confirm', async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 204 }); }));
  renderApp('/reset-password?token=abc');
  await userEvent.type(await screen.findByLabelText('New password'), 'brand-new-pass-1');
  await userEvent.type(screen.getByLabelText('Confirm password'), 'different-pass-1');
  await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
  expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
  expect(body).toBeUndefined();
  await userEvent.clear(screen.getByLabelText('Confirm password'));
  await userEvent.type(screen.getByLabelText('Confirm password'), 'brand-new-pass-1');
  await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
  expect(await screen.findByText('Password updated. You can now log in.')).toBeInTheDocument();
  expect(body).toEqual({ token: 'abc', password: 'brand-new-pass-1' });
});
```

(`asAdmin()`, `asAnonymous()` and `defaultSettings` are added to `src/test/server.js`; `defaultSettings` mirrors `DEFAULT_SETTINGS` from `@vs/shared`.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement the four pages and routes.**
- [ ] **Step 4: Run to verify pass** — `npx vitest run --project web` → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "feat(web): users, settings and password reset pages"
```

---

### Task 22: Deployment — nginx, pm2, CI/CD, infrastructure runbook

**Files:**
- Create: `deploy/nginx/api.conf`, `deploy/ecosystem.config.cjs`, `deploy/scripts/remote-deploy.sh`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `docs/ops/infrastructure.md`
- Modify: `apps/api/src/server.js` (`app.set('trust proxy', 1)` behind nginx)

**Interfaces:**
- Consumes: root scripts (Task 1), `npm run build -w @vs/web`, `apps/api/src/server.js`, `apps/api/src/worker.js`, `apps/api/src/cli/bootstrap.js`.
- Produces:
  - `deploy/nginx/api.conf` — `server_name api.<domain>`; port 80 serves `/.well-known/acme-challenge/` and redirects everything else to HTTPS; 443 with Let's Encrypt certs, `client_max_body_size 2m`, `proxy_pass http://127.0.0.1:4000`, forwards `X-Forwarded-For` / `X-Forwarded-Proto`.
  - `deploy/ecosystem.config.cjs` — pm2 apps `vs-api` (`apps/api/src/server.js`) and `vs-worker` (`apps/api/src/worker.js`), `env_file: '.env'`, `max_memory_restart: '600M'`.
  - `deploy/scripts/remote-deploy.sh` — on EC2: `git fetch && git reset --hard <sha>`, `npm ci --omit=dev`, `aws ssm get-parameters-by-path --path /vastrasanskara/prod --with-decryption` → `.env` (mode 600), `pm2 reload deploy/ecosystem.config.cjs`, `curl -fsS https://api.<domain>/v1/health`.
  - `ci.yml` (pull requests and pushes): Node 22, `npm ci`, `npm run lint`, `npm test`, `npm run test:tz`.
  - `deploy.yml` (push to `main`): runs the CI job; then builds web with `VITE_API_URL`; `aws s3 sync apps/web/dist s3://<web-bucket> --delete`; CloudFront invalidation `/*`; `aws ssm send-command` running `remote-deploy.sh <sha>` on the instance; fails if the health check fails. AWS access through GitHub OIDC role (`AWS_DEPLOY_ROLE_ARN` secret) — no long-lived keys.
  - `docs/ops/infrastructure.md` — ordered checklist: domain DNS (`app.` CNAME → CloudFront, `api.` A → Elastic IP); ACM certificate in us-east-1 for `app.`; private S3 web bucket + CloudFront with OAC, default root `index.html`, 403/404 → `/index.html` (200), response headers policy (HSTS, CSP `default-src 'self'; connect-src 'self' https://api.<domain> https://*.s3.ap-south-1.amazonaws.com; img-src 'self' data: https://*.s3.ap-south-1.amazonaws.com`); files bucket (private, CORS PUT/GET from `https://app.<domain>`, versioning); backups bucket (versioning, Object Lock compliance mode, lifecycle → Glacier after 30 days, expire after 8 years); EC2 t4g.small Amazon Linux 2023 arm64, 30 GB gp3, Elastic IP, security group 80/443 in, no 22; IAM instance role (S3 files RW, backups PutObject only, `ses:SendRawEmail`, `ssm:GetParametersByPath` on `/vastrasanskara/prod`, CloudWatch agent); install Node 22, nginx, certbot, pm2, mongodb-database-tools (arm64); Atlas M0 in AWS ap-south-1, database user, IP access list = Elastic IP; SES domain identity with DKIM, SPF, DMARC and production access request; SSM parameters (every key in `.env.example`); CloudWatch agent for pm2 logs, alarms for health check failure and EC2 status check with auto-recovery; DLM daily EBS snapshots; first deploy then `node apps/api/src/cli/bootstrap.js`.

- [ ] **Step 1: Write the files above.**
- [ ] **Step 2: Verify locally**

Run: `npm ci && npm run lint && npm test && npm run test:tz && npm run build -w @vs/web && bash -n deploy/scripts/remote-deploy.sh && node -e "require('./deploy/ecosystem.config.cjs')"`
Expected: all exit 0.

- [ ] **Step 3: Provision and deploy (human-run, following `docs/ops/infrastructure.md`)**

Run after provisioning: push to `main`, watch the deploy workflow, then `curl -fsS https://api.<domain>/v1/health`
Expected: `{"db":"ok","worker":"ok"}`; `https://app.<domain>/login` loads; logging in as the bootstrapped admin works and the session cookie is `__Host-sid`.

- [ ] **Step 4: Commit**

```bash
git add deploy .github docs/ops apps/api/src/server.js && git commit -m "chore: production deployment config, CI/CD and infrastructure runbook"
```

---

## Later milestone plans

Written after this plan is executed, each against the same spec: M2 customers & orders, M3 production, M4 billing (counters, invoices, PDFs with Object Lock + hash, payments, vouchers, credit notes, period locks, audit-trail verify screen), M5 expenses, M6 stock & costing, M7 front office, M8 dashboard & reports, M9 imports & go-live.
