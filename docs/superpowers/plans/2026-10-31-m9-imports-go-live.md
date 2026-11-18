# M9 Imports and Go-live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner brings the boutique's existing records into the system without help: on "Bring in old records" she picks what to bring in (customers, vendors, workers, price list, stock, open orders, opening balances), downloads a ready-made Excel template, fills it, uploads it, and sees a preview in plain words: "480 ready to add · 12 already in the system · 8 need fixing — Row 14, Phone: '98765' is not a 10-digit mobile number". She adds the good rows with one tap, fixes the rest and uploads again; nothing is ever added twice. A "Getting ready to go live" checklist walks her through business details, bill numbers continuing from her old book, the price list, staff, imports, a test email, the first backup and the records check, then "We are live". Behind that, the app is made safe to switch on: production refuses to start when misconfigured, deploys migrate indexes and wait for the new worker, the API is hardened (rate limits, headers, cookies, lockout), stored files are checksummed and bill PDFs locked, a restore drill proves the backups work, phone-sized end-to-end tests run in CI, and a go-live runbook lists every step a person must do in AWS, Atlas, DNS and SES.

**Architecture:** Same modular monolith. One new API module **`imports`** (`model.js`, `service.js`, `runner.js`, `sheets.js`, `kinds/*.js`, `jobs.js`, `json.js`, `routes.js`). Parsing and the column rules of every kind are pure in `packages/shared/src/imports/`, so the template, the preview and the import agree. Each kind adapter (`imports/kinds/<kind>.js`) writes **only through the owning module's `service.js`** (customers, vendors, workers, catalog, stock, orders + production, billing); modules gain small lookup/import functions where needed. Runs follow the M8 report pattern: a stored `ImportRun`, claimed atomically by the API (small files, at once) or the worker (`imports-run`, every minute), with per-row results in `importRows` (TTL-purged). Go-live code lands in `core/` (config, db readiness, migrations, rate limits, storage checksums), `modules/setup/` (checklist) and `cli/` (migrate, wait-ready, atlas-role, restore-drill); deploy artefacts in `deploy/`, `.github/workflows/`, `docs/ops/`; end-to-end tests in a new `apps/e2e` workspace.

**Tech Stack:** As M8 (exceljs 4.4.0 — reused here to read XLSX and write templates). New dev dependency **`@playwright/test` 1.49.1** in `apps/e2e` only. CSV is parsed by a small shared parser (no new runtime dependency).

**Spec:** `docs/superpowers/specs/2026-10-22-vastrasanskara-system-design.md` — §13 (all: import tools with dry-run report — inventory → stock items + `opening` movements at cost; customers; open orders at their current stage, stage events marked imported; opening balances: advances held and amounts owed as clearly labelled opening receivables; number series starting points; training and one-week parallel run), §14 item 9, §2.3–2.5 (EC2/nginx/pm2, deploy = "pull, install, migrate, pm2 reload", M0 constraints, insert-only `auditLog` role "verify during build"), §5.2 (gapless GST series — imports never consume one), §5.5 (ledger, advances, ageing derived from documents), §5.7 (audit; integrity check compares stored hashes), §10 (all: cookie, CORS, CSRF header, login rate limit + lockout, helmet/CloudFront headers, presigned uploads, no personal data in logs, secrets in SSM), §11 (error shape, idempotency, failed jobs, health), §12 (Playwright phone E2E; CI gates deploy), §15 "to verify during build" (Atlas custom role; SES production access + SPF/DKIM/DMARC).

**Carried from earlier milestones (binding):**
- M1 ledger `.superpowers/sdd/2026-10-22-m1-foundation/progress.md` "Final: minor (deferred)" and M2 plan "Not in M2" deployment hardening: SSM wait past 100 s; single-quoted `.env` values; `write_env` temp file left on abort; `.gitattributes` LF; nginx `listen 443 ssl http2`; pm2-logrotate; CSP `frame-ancestors 'none'`; `s3:AbortMultipartUpload` on backups; no migration hook in `remote-deploy.sh`; health passing while a new worker crash-loops; logout `clearCookie` without `Secure`; account existence inferable from 423 lockout and reset timing; pino redaction one level deep; no CloudWatch alarm for failed jobs.
- M4 plan "Not in M4" + ledger: opening balances import; number-series continuity at go-live; S3 Object Lock / retention on billing PDFs; `Metadata.sha256` on uploads; CORS `GET` on the files bucket; SES production access; Atlas version ≥ 6 for partial `$in` indexes.
- M5 "Not in M5": Object Lock and sha256 for bill photos so "Check records" can hash them; import of past expenses "if the client wants it" (not in M9, Decision 20).
- M6 "Not in M6": opening stock import. M7: Playwright enquiry → appointment → convert. M8 "Not in M8": S3 lifecycle expiry of `reports/` (90 days); SES attachment size check with real GST packs; Playwright Home → drill-down; opening receivables appear in ageing once imported.
- M8 Decision 10 (background run claimed by API or worker), Global Constraint "cell safety" (`safeCell`), M8 import-boundary test (no module imports `reports`).

## Global Constraints

- Everything in the M1–M8 Global Constraints still applies (integer paise, IST `YYYY-MM-DD` business dates, `branchId`, `version` + 409 `CONFLICT`, strict zod, error shape, no personal data in logs, bundled icons, 390 px screens, sentence case, plain words; quantities in milli-units per M6 Decision 1).
- **This milestone may change `deploy/`, `.github/workflows/`, `docs/ops/`** (overrides the IMPLEMENTER "no deploy/infra" line for M9 only). It never provisions, pushes, deploys or calls AWS/Atlas/DNS: those are human steps listed in `docs/ops/go-live.md`.
- **Layout:** `apps/api/src/modules/imports/` = `model.js` (`ImportRun`, `ImportRow`), `service.js`, `runner.js`, `sheets.js`, `kinds/{index,customers,vendors,workers,catalog,stock,orders,openingBalances}.js`, `jobs.js`, `json.js`, `routes.js`. The imports module never imports another module's `model.js`; kind adapters call only `<module>/service.js`. No other module imports `imports/` (asserted by a test, as M8's).
- **Permission:** new `imports.run` — **admin only** (added to `NOT_OPERATIONS`). Every `/v1/imports` route and the `import_file` purpose require it. Go-live checklist routes use `settings.edit`.
- **Limits:** file ≤ **5 MB** (`IMPORT_MAX_BYTES = 5242880`), ≤ **5,000 data rows** (`IMPORT_MAX_ROWS`), ≤ 60 columns; XLSX (first sheet with data) or CSV (UTF-8, comma; BOM tolerated). Old `.xls` → `IMPORT_FILE_UNREADABLE` "Save the file as Excel Workbook (.xlsx) or CSV and upload again."
- **Imports only add.** They never change or delete an existing record. A row whose natural key already exists is "Already in the system — left as it is".
- **No messages to customers** are sent by any import (no `emit` of customer events). Imported records are audited through their own services; the run itself is audited (`entityType: 'import'`, actions `request`, `confirm`, `finish`).
- **Logs:** an import logs only `{ runId, kind, phase, counts, code }`. Never cell values, names, phones, file names.
- **Opening balances** never take a GST document number and never appear in GSTR-1, GSTR-3B, billed or collected figures; they do appear in the customer ledger, outstanding, ageing and advances held.
- **Words in the UI:** "Bring in old records", "Download template", "Upload filled file", "Checking your file…", "Ready to add", "Already in the system", "Needs fixing", "Download rows to fix", "Add N records", "Adding… N of M", "Continue adding", "Cut-over date (the last day of your old records)", "Getting ready to go live", "Send a test email", "We are live". Never "import run", "dry run", "row key", "TTL", "migration".
- Commit subjects end with `(M9 Task N)`.

## Decisions made in planning

| # | Decision | Why | Cost if wrong |
|---|---|---|---|
| 1 | **Seven import kinds, in a suggested order** shown on the page: Customers → Vendors → Workers → Price list → Stock → Open orders → Opening balances. Later kinds look up earlier ones (orders need customers and designers; balances need customers and optionally orders). Order is advised, not enforced; a missing customer is a row error "No customer with phone … — bring in customers first". | Spec §13 list plus the people/catalog records the other modules need; a non-technical owner follows numbered cards. | — |
| 2 | **Measurements and past expenses are not imported.** | Spec §13 does not list them; paper measurement layouts differ per garment type and are retaken at the next visit; past expenses belong to the old books (M5 "if the client wants it" — not asked). | A `measurements` kind is one adapter + column list. |
| 3 | **Every kind has a natural key**; a row whose key exists is skipped, never updated: customers = phone; vendors, workers, price list = name (case- and space-insensitive); stock = name + brand + colour; orders = old order number (`legacyRef`, unique per branch); opening balances = customer (one live opening balance per customer). | Re-uploading the same or a corrected file can never duplicate, which is what makes "add the good rows now, fix the rest later" safe. | An "update existing" mode is a per-kind `update` function later. |
| 4 | **Add the good rows, leave the bad ones.** Confirm is allowed when at least one row is ready; error rows are listed and downloadable as "Rows to fix" (the original columns plus "What to fix"), to be fixed and uploaded again. | Blocking 480 good customers on 8 typos is the worst experience for a non-technical owner; Decision 3 makes the re-upload safe. | Make confirm require zero errors: one condition. |
| 5 | **Check, then confirm.** Upload → `checking` (parse + validate every row against current data, write nothing) → `checked` (preview) → owner confirms → `importing` → `done`. Confirm re-validates each row through the module service at write time, so data changed in between is handled (a row added meanwhile becomes "Already in the system"). A checked run not confirmed in **7 days** becomes `expired`. | Spec "dry-run validation report before committing". | — |
| 6 | **Background like M8 reports.** Files ≤ **200 data rows** are checked and imported at once in the API process (`setImmediate`, claim-based); larger ones by the worker's `imports-run` job within a minute. The page polls every 2 s and shows progress (`counts` updated every 25 rows). Claims are atomic (`findOneAndUpdate` on status); a run `importing` with a claim older than 10 min is reclaimed and **resumes at `nextRow`**; after 3 attempts it becomes `failed` with "Continue adding". **One importing run per branch** (unique partial index) → 409 `IMPORT_BUSY` "Another import is running. Wait for it to finish." | Bounded memory/time on a 2 GB box; a worker restart never duplicates (resume + Decision 3). | — |
| 7 | **Same file uploaded again**: the run stores the file's SHA-256 (from storage, Task 10, else computed); when a previous run of the same kind had the same hash the preview says "You uploaded this file on 3 November. Rows already added show as 'Already in the system'." It is not refused. | Owners re-upload after fixing; refusing identical files adds nothing (Decision 3 already prevents duplicates). | — |
| 8 | **Row results live in `importRows`** with `expiresAt` (TTL): 30 days after the run finishes, 7 days for an unconfirmed check. The run keeps counts, kind, file hash, who and when forever (audited). The uploaded file sits under `<branchId>/import_file/…`; an S3 lifecycle rule deletes it after 30 days (runbook). | Rows hold personal data; nothing needs them after the owner has fixed and re-uploaded. | Longer retention is one constant. |
| 9 | **Spreadsheet values are read forgivingly, in Indian conventions:** headers match case/space/punctuation-insensitively with aliases ("Mobile", "Phone number" → Phone); phones accept `+91`, `0` prefixes, spaces, dashes and numeric cells (`9876543210` stored as a number, including Excel's `9.87654321E+09`) → 10 digits starting 6–9; dates accept Excel dates/serials, `DD/MM/YYYY`, `DD-MM-YYYY`, `D.M.YY` and `YYYY-MM-DD` — **day first, never month first**; money accepts `₹`, `Rs.`, commas, `1,20,000.50` → paise (more than 2 decimals is an error); yes/no accepts Yes/No/Y/N/True/False/1/0; states accept a name or 2-digit code; choices accept the label or key ("Rush"/"rush"). Formula cells use their cached result; blank rows are ignored; unknown columns are listed as "Not used: Remarks". | The owner's real sheets come from Excel on Windows phones/laptops; every rule is one pure function with tests. | — |
| 10 | **Templates** are generated, not stored: XLSX with a "Fill this in" sheet (bold frozen headers, required columns marked `*`, drop-down lists for choices, text format on Phone/GSTIN/HSN/pincode columns so leading zeros survive) and a "How to fill" sheet (one line per column: what it is, required, example, allowed values). CSV template = header row only. No example row in the data sheet (it would be imported). | A template the owner cannot break is the cheapest validation. | — |
| 11 | **Opening balances are billing documents of their own:** an `opening_balance` document (amount owed before the cut-over date; internal series `OB/<fy>/0001`; due on the cut-over date, so it shows as overdue in ageing) and an **opening advance** = a `receipt` with `opening: true`, `mode: null`, internal series `OA/<fy>/0001`, no receipt voucher, no PDF, optionally on an imported order. Both dated the cut-over date (month must be open). They are payable/applied like bills/receipts; corrections are "Cancel opening balance" (admin, reason, audited) then upload again. | Spec "clearly labelled opening receivables"; ledger, ageing and advances are derived from documents (§5.5), so the balances must be documents; no GST series or GST return is touched. | — |
| 12 | **No GST adjustment on opening advances.** A final invoice that uses an opening advance charges GST as for a goods advance (no receipt-voucher tax deducted). The runbook asks the accountant to confirm; advances on which the old system already paid GST are listed for him by the import ("Advance held" rows). | The old system's vouchers are not in this system; guessing a tax credit is worse than a visible accountant step. | Accountant says otherwise → an optional "GST already paid" column feeding the invoice's advance adjustment. |
| 13 | **Open orders keep their story short:** an imported order gets a **new** order number from today's FY series and keeps the paper number as `legacyRef` ("Old no. 1234", searchable). Each garment is placed at its stage with **one stage event `imported`** (new action, never offered by `allowedActions`) — "Brought in at Tailors". Stage plans are built from the order date to the due date as for new orders; a past pickup date is allowed (the order shows late). Garments at "Ready for pickup" are `ready` with `readyDate` = import day. "Picked up" orders are not open → row error. No materials, no advance (Decision 11 covers money), no customer message. | Spec "open orders at their current stage (stage events marked as imported)"; one event per garment keeps history honest without inventing completion dates. | — |
| 14 | **One row per garment** in the open-orders sheet; rows sharing an old order number form one order (order fields taken from the first row; a conflicting customer/pickup date on a later row is an error on that row); `Quantity` > 1 makes a batch. The whole order is added or skipped together. | Mirrors the paper order form (one line per piece). | — |
| 15 | **Audit actor for imported records** is the admin who confirmed, with `userAgent: 'import:<runId>'` and the confirm request's IP, so every audit entry traces back to its import. | Spec §5.7 "who, when, what" for every covered record. | — |
| 16 | **Production refuses to start when misconfigured** (one plain message listing every problem): local storage or file mail; non-`https` origins; `APP_ORIGIN`/`API_ORIGIN` not sibling subdomains of one domain (§10.1 cookies); the development session secret; a `localhost` database; MongoDB below **7.0** or without transactions (not a replica set). | A misconfigured go-live fails loudly on the first deploy instead of silently losing cookies or files. | — |
| 17 | **Deploy = pull → install → migrate → reload → wait for the new release.** `cli/migrate.js` builds every model's indexes and runs numbered migrations (recorded in `migrations`); production Mongoose has `autoIndex: false`. `cli/wait-ready.js` waits until the worker's heartbeat carries the new `RELEASE_SHA` and `/v1/health` is 200 on `127.0.0.1` (no release id is exposed publicly). A failed wait fails the deploy; `rollback.sh` redeploys the previous release (migrations are forward-only and additive). | Spec §2.4 "migrate"; M1 deferred crash-loop and migration-hook items. | — |
| 18 | **Atlas insert-only audit role is generated, applied by a person:** `cli/atlas-role.js` prints a custom role (`find`, `insert` on `auditLog`; read/write on every other collection the app uses). The runbook applies it if Atlas M0 allows custom roles; otherwise the app's hash chain stands alone until the M10 upgrade, and the runbook records the outcome. | Spec §2.5/§15 "verify during build"; the verification is a console action. | — |
| 19 | **File integrity:** browser uploads send their SHA-256; the presigned PUT carries `x-amz-checksum-sha256`, so S3 refuses different bytes; the stored hash is kept on expense bill photos and checked by "Check records". Server-written billing PDFs get the checksum and **Object Lock retention (compliance, 8 years)** when `FILES_OBJECT_LOCK=true` (the files bucket must be created with Object Lock — human step). | M4/M5 parked items; tampering with a bill photo or PDF is detectable. | — |
| 20 | **API hardening:** a general limit of **300 requests/min per signed-in user (600/min per IP when signed out)** → 429 `RATE_LIMITED` "Too many requests. Wait a minute and try again."; failed logins for **unknown emails** count and lock like known ones and take the same argon2 time; password-reset requests answer identically and send the email from the outbox; logout clears the cookie with the same attributes; every API response carries `Cache-Control: no-store`, HSTS 2 years with subdomains, CSP `default-src 'none'; frame-ancestors 'none'`. | §10 and the M1 deferred items; one API process makes the in-memory limiter correct. | Raise limits: two constants. |
| 21 | **Go-live checklist** (`/go-live`, admin) shows 8 checks with a link each and a Home banner "Getting ready to go live: 5 of 8 done" until "We are live" is pressed (audited `settings.goLive.liveSince`). Bill numbering is confirmed explicitly: "This is our first GST bill this year" or "Continue from INV/2627/0123" (sets `numberSeries`), for invoice, credit note, receipt voucher, refund voucher and payment receipt. | Spec §13 "number series starting points"; a single screen replaces a technical runbook for the owner. | — |
| 22 | **Restore drill** is a CLI run from the operator's machine (the server cannot read backups by design): newest backup → `mongorestore` into `<db>_restore_check` → counts per collection, audit chain of every branch, age of the newest record → plain report → scratch database dropped. | Spec §2.5 "restore procedure documented"; a backup never restored is not a backup. | — |
| 23 | **Playwright phone E2E** lives in `apps/e2e` (not in `npm test`), runs Chromium at 390×844 against a memory replica-set database, the built web app and the API + worker, and is a CI job that gates deploy. Journeys: order → stages → invoice → payment; enquiry → appointment → convert; Home → drill-down; bring in customers. | Spec §12; M7/M8 parked them here. | — |

## Review Focus

1. **The same rows arrive twice** — the owner uploads the same file again, or a corrected file that overlaps, or the worker restarts mid-import. Nothing is ever duplicated and every row ends added, already there or needing a fix. → Task 3 test `uploading the same file twice adds nothing the second time`; Task 4 test `an import interrupted half way resumes without duplicates`.
2. **Real spreadsheet quirks** — phones saved as numbers or with +91, dates as Excel serials or `05/11/2026` (5 November), amounts like `₹1,20,000.50`, formulas, blank trailing rows, renamed headers. Each is read correctly or explained in one plain sentence naming the row and column. → Task 1 tests `phones in every common form`, `dates are read day first`, `rupee amounts with commas and symbols`.
3. **Opening balances touch GST** — they must not take an INV/RV number or appear in GSTR-1, billed or collected, yet must show in outstanding, ageing and advances, and be payable. → Task 6 tests `opening balances never take a GST number or reach GST figures` and `an opening balance is owed, ages and can be paid`.
4. **Personal data leaks** — import files, previews and "rows to fix" are admin-only, logs carry nothing from the file, and a cell like `=HYPERLINK(...)` comes back neutralised. → Task 3 tests `an import logs nothing from the file`, `only admins can upload, see or download import files`, `rows to fix are safe to open in Excel`.
5. **A misconfigured production goes live** — local storage, http origins, cross-site domains, the dev secret, a local or old/non-replica database: the API and worker refuse to start, and a deploy whose new worker never reports fails. → Task 2 tests `production refuses unsafe settings with one plain message`, `the database must be MongoDB 7 or later with transactions`, `waiting for a release fails when the new worker never reports`.

---

## File Structure

```
packages/shared/src/
  imports/values.js          parsePhone, parseRupees, parseDate, parseYesNo, parseState, parseChoice, parseQty, parseText
  imports/csv.js             parseCsv
  imports/kinds.js           IMPORT_KINDS, getImportKind, matchHeaders, parseRow, IMPORT_* limits
  schemas/imports.js         importStartSchema, importConfirmSchema, importRowsQuery
  schemas/settings.js        + goLive
  production.js              + 'imported' action (never allowed)
  permissions.js             + IMPORTS_RUN (admin only)
apps/api/src/
  config.js                  production rules, RELEASE_SHA, FILES_OBJECT_LOCK, rate limits
  core/db.js                 assertDatabaseReady, autoIndex off in production
  core/jobs/service.js       heartbeat release + startedAt; readHeartbeat
  core/migrations.js         runMigrations
  core/dbRole.js             appRole
  core/rateLimit.js          apiRateLimiter
  core/security.js           helmet options, no-store
  core/files/*               checksums, Object Lock, import_file purpose, maxBytes per purpose
  core/backup/backup.js      records last success; lastBackup
  models.js                  every model, for migrate/atlas-role
  migrations/001-billing-receivables-index.js
  cli/{migrate,wait-ready,atlas-role,restore-drill,bootstrap}.js
  core/backup/restoreCheck.js
  modules/imports/*          (see Global Constraints)
  modules/setup/{goLive.js,routes.js}
  modules/{customers,vendors,workers,catalog,stock}/service.js   + find-by-natural-key
  modules/orders/{model.js,imports.js,service.js,json.js}        legacyRef, importOrder, findOrderByLegacyRef
  modules/production/service.js                                  recordImportedStage
  modules/billing/{model.js,opening.js,service.js,ledger.js,payments.js,daily.js,integrity.js,routes.js}
  modules/expenses/{model.js,service.js}                         attachment sha256, listAttachmentHashes
  modules/auth/{routes.js,service.js}, modules/users/passwordReset.js, logger.js
apps/web/src/
  features/imports/{importsApi.js,ImportsPage.jsx,KindCard.jsx,UploadStep.jsx,PreviewPage.jsx,RowList.jsx,ProgressCard.jsx}
  features/goLive/{goLiveApi.js,GoLivePage.jsx,NumberingCheck.jsx,GoLiveBanner.jsx}
  lib/upload.js (sha256), lib/errorMessages.js, layout/navItems.js, App.jsx, test/server.js
apps/e2e/                    package.json, playwright.config.js, global-setup.js, seed.js, tests/*.spec.js
deploy/scripts/{remote-deploy.sh,rollback.sh}, deploy/nginx/api.conf, deploy/ecosystem.config.cjs
.github/workflows/{ci.yml,deploy.yml}, .gitattributes
docs/ops/{go-live.md,infrastructure.md,restore.md}
```

---

### Task 1: Shared — reading spreadsheet values, column rules of every kind, the permission

**Files:**
- Create: `packages/shared/src/imports/{values.js,csv.js,kinds.js}`, `packages/shared/src/schemas/imports.js`
- Modify: `packages/shared/src/permissions.js`, `packages/shared/src/production.js`, `packages/shared/src/index.js`
- Test: `packages/shared/test/import-values.test.js`, `packages/shared/test/import-kinds.test.js`, `packages/shared/test/permissions.test.js`, `packages/shared/test/production.test.js`

**Interfaces:**
- Consumes: `phone`, `gstin`, `stateCode`, `email` (common.js), `STATES` (states.js), `ymd`, `STAGES`, `rupeesToPaise`/`toMilli` (money.js), `customerSchema`, `vendorSchema`, `workerSchema`, `catalogItemSchema`, M6 `stockItemSchema` and `qty`.
- Produces (`permissions.js`): `IMPORTS_RUN: 'imports.run'`, in `NOT_OPERATIONS`; not designers.
- Produces (`production.js`): `'imported'` appended to `ACTIONS`; `allowedActions` never returns it.
- Produces (`imports/values.js`), each `(raw) → { value } | { error }` with `raw` a string, number, boolean, Date or null; messages are complete sentences without the column name (the caller prefixes "Phone: "):
  - `parseText(raw, { max, required })`; `parsePhone(raw)` → 10 digits (Decision 9); `parseEmail`; `parseRupees(raw)` → paise; `parseDate(raw)` → `YYYY-MM-DD` (Excel serial `n` → 1899-12-30 + n days; JS `Date` → its UTC date); `parseYesNo`; `parseState(raw)` → code; `parseChoice(raw, [{ key, label }])` → key ("Choose one of: Normal, Rush"); `parseQty(raw)` → milli-units; `parseList(raw)` (comma/semicolon separated, trimmed, unique).
- Produces (`imports/csv.js`): `parseCsv(text) → string[][]` — RFC 4180 (quotes, doubled quotes, embedded newlines), CRLF/LF, strips BOM, drops trailing empty lines; throws `CsvError` on an unclosed quote.
- Produces (`imports/kinds.js`):
  - `IMPORT_MAX_BYTES = 5242880`, `IMPORT_MAX_ROWS = 5000`, `IMPORT_LIGHT_ROWS = 200`, `IMPORT_MAX_COLUMNS = 60`.
  - `IMPORT_KINDS` (frozen, Decision 1 order): `{ kind, label, help, needsAsOf, columns: [{ key, header, aliases, required, example, help, choices?, parse }] }` for `customers` ("Customers": Name*, Phone*, Email, Customer type [Individual/Business/Film production], GSTIN, State, Address line 1, Address line 2, City, Pincode, How they found us [source labels], Email OK?, WhatsApp OK?, SMS OK?, How consent was given), `vendors` (Name*, Phone, GSTIN, State, Services), `workers` (Name*, Skill, Phone), `catalog` ("Price list": Name*, Kind* [Garment/Stitching service/Material/Extra charge], Goods or service*, HSN or SAC*, Unit, Price, GST rate %*, Higher GST rate %, Higher rate above price, Garment types), `stock` (Name*, Brand, Category, Colour, Unit*, Bought in*, Units in one*, Reorder at, Selling price per unit, Quantity in stock, Cost per unit), `orders` ("Open orders", `needsAsOf: false`: Old order no.*, Customer phone*, Designer*, Order date, Pickup date*, Priority, Garment type*, Description*, Fabric, Price*, Quantity, Due date, Stage* [stage labels except Picked up]), `opening_balances` ("Opening balances", `needsAsOf: true`: Customer phone*, Amount owed, Advance held, Old order no., Note).
  - `getImportKind(kind)`; `matchHeaders(kind, headerRow) → { map: { colIndex: key }, missing: [header], unused: [header] }`.
  - `parseRow(kind, cells, ctx) → { data, errors: [{ column: header, message }] }` — runs each column's `parse`, then the kind's schema (`customerSchema` etc., zod issues mapped back to the column header in plain words). `ctx` carries choices that come from settings (`garmentTypes`, `designers: [{ id, name }]`). Cross-field rules: consent Yes needs "How consent was given"; a GSTIN fixes the state; opening balances need owed or advance > 0; catalog "Higher GST rate %" needs "Higher rate above price" (builds two `gstSlabs`); stock "Cost per unit" required when "Quantity in stock" > 0.
  - `rowKey(kind, data) → string` — Decision 3 (names lower-cased, whitespace collapsed).
- Produces (`schemas/imports.js`): `importStartSchema = { kind: enum, fileKey: string 1–300, fileName: trim 1–120, asOf: ymd optional }` strict, refined: `asOf` required when `needsAsOf`; `importConfirmSchema = {}` (through `versioned`); `importRowsQuery = { status: enum ['ready','exists','error','added','skipped','failed'] optional, cursor ≤ 500, limit 1–100 }`.

- [ ] **Step 1: Write the failing tests** — `import-values.test.js`: `phones in every common form` (`'+91 98765 43210'`, `'098765-43210'`, `9876543210` number, `9.87654321e9` → `'9876543210'`; `'98765'` → error "is not a 10-digit mobile number"); `dates are read day first` (`'05/11/2026'` → `2026-11-05`, `'5-11-26'` → `2026-11-05`, serial `46331` → its date, `'2026-11-05'`, `'31/02/2026'` → error "is not a real date"); `rupee amounts with commas and symbols` (`'₹1,20,000.50'` → 12000050, `'Rs. 500'` → 50000, `'12.345'` → error, `'-5'` → error); `yes and no in common forms`; `states by name or code` (`'Karnataka'`/`'29'` → `'29'`); `choices by label or key`; `quantities keep three decimals` (`'2.5'` → 2500). `csv`: `quoted commas, quotes and new lines`; `a BOM and CRLF are handled`; `an unclosed quote is an error`. `import-kinds.test.js`: `headers match whatever the case, spaces and aliases` (`'Mobile '` → phone; unknown → `unused`; missing required → `missing`); `a customer row becomes a customer` (data passes `customerSchema`); `consent needs a note of how it was given`; `a GSTIN fixes the state`; `a price-list row with two rates makes two slabs`; `a stock row with stock needs a cost`; `an opening balance needs an amount`; `natural keys ignore case and extra spaces`; `every kind's columns have a header, help and example`. `permissions.test.js`: `imports.run is admin only`. `production.test.js`: `imported is never offered as an action`.
- [ ] **Step 2: Run** `npx vitest run --project shared` → FAIL (modules missing).
- [ ] **Step 3: Implement.** If M6's `stockItemSchema`/`qty` are named differently in the built code, follow the code and record a ruling.
- [ ] **Step 4: Run** `npx vitest run --project shared && npm run test:tz && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(shared): spreadsheet value parsing and column rules for every import kind (M9 Task 1)`

---

### Task 2: API — production start-up checks, migrations, release-aware readiness, Atlas role, bootstrap

**Files:**
- Create: `apps/api/src/core/migrations.js`, `apps/api/src/core/dbRole.js`, `apps/api/src/models.js`, `apps/api/src/migrations/index.js`, `apps/api/src/cli/{migrate.js,wait-ready.js,atlas-role.js}`
- Modify: `apps/api/src/config.js`, `apps/api/src/core/db.js`, `apps/api/src/core/jobs/service.js`, `apps/api/src/server.js`, `apps/api/src/worker.js`, `apps/api/src/cli/bootstrap.js`, `.env.example`
- Test: `apps/api/test/config.test.js`, `apps/api/test/db-ready.test.js`, `apps/api/test/migrations.test.js`, `apps/api/test/wait-ready.test.js`, `apps/api/test/atlas-role.test.js`, `apps/api/test/setup.test.js`

**Interfaces:**
- Produces (`config.js`): `loadConfig` collects **all** production problems and throws one `Error('Production settings are not safe:\n- …')` (Decision 16): `STORAGE_ADAPTER` must be `s3`, `MAIL_ADAPTER` `ses`; `APP_ORIGIN`/`API_ORIGIN` start with `https://` and share the parent domain (`new URL(o).hostname` minus its first label equal); `SESSION_SECRET` ≥ 32 chars and not the `.env.example`/dev default; `MONGO_URI` host not `localhost`/`127.0.0.1`/`::1`. New fields: `release: env.RELEASE_SHA ?? 'dev'`, `aws.objectLock: env.FILES_OBJECT_LOCK === 'true'` (Task 10), `rateLimits: { user: 300, anonymous: 600 }` (test env 100000) (Task 9).
- Produces (`core/db.js`): `connectDb(uri, { dnsServers, autoIndex })` (`autoIndex` false when `config.env === 'production'`); `assertDatabaseReady() → { version }` — `buildInfo().version` major < 7 → throws "The database must be MongoDB 7.0 or later (found 6.0.5)"; `hello()` without `setName` and not `msg: 'isdbgrid'` → "The database does not support transactions (it is not a replica set)". `server.js` and `worker.js` call it after connecting and exit 1 with the message.
- Produces (`core/jobs/service.js`): heartbeat stores `{ at, release, startedAt }` (`startedAt` = worker process start); `readHeartbeat() → { at, release, startedAt } | null`; `getWorkerStatus` unchanged.
- Produces (`models.js`): `export const MODELS` — every Mongoose model, imported from each `modules/*/model.js` and `core/**/model(s).js` (infrastructure only; not a business read). `export const EXTRA_COLLECTIONS = ['sessions', 'system', 'agendaJobs', 'migrations', 'idempotencyKeys' /* actual names from code */]`.
- Produces (`core/migrations.js`): `runMigrations({ models, migrations, log }) → { indexes: [modelName], applied: [id] }` — `await m.createIndexes()` for each model (errors name the model and index), then each `{ id, up(db) }` in `migrations/index.js` not yet in `migrations` (`{ _id: id, at }` inserted after `up` succeeds; idempotent `up`s). `migrations/index.js` exports `[]` now (Task 6 adds one).
- Produces (`cli/migrate.js`): `loadConfig` → `connectDb(..., { autoIndex: false })` → `assertDatabaseReady` → `runMigrations` → prints "Indexes ready for N collections; applied: 001-…" → exit 0/1.
- Produces (`cli/wait-ready.js`): `waitReady({ release, timeoutMs = 120000, intervalMs = 3000, readHeartbeat, fetchHealth, now }) → { ok, message }` (exported for tests) — ok when `heartbeat.release === release`, the heartbeat is < 3 min old, and `fetchHealth()` (GET `http://127.0.0.1:<PORT>/v1/health`) is 200; else after timeout `{ ok: false, message: 'The new worker did not report within 120 s' | 'The API health check is failing' }`. CLI: `node apps/api/src/cli/wait-ready.js <sha>`.
- Produces (`core/dbRole.js`): `appRole(collections) → { role: 'vsApp', privileges: [...], roles: [] }` — `auditLog`: `['find', 'insert', 'createIndex', 'listIndexes']`; every other collection: `['find', 'insert', 'update', 'remove', 'createIndex', 'dropIndex', 'listIndexes', 'collStats']`; database resource: `['listCollections', 'dbStats', 'createCollection']`. `cli/atlas-role.js` prints it as JSON for `MODELS` collections + `EXTRA_COLLECTIONS`.
- Produces (`cli/bootstrap.js`): when `BOOTSTRAP_ADMIN_PASSWORD` is empty, reads the password from stdin (`readPassword({ stdin, isTTY })`: hidden prompt "Admin password (10+ characters): " on a TTY, else the first line); input parsing exported as `inputFromEnv` for tests.

- [ ] **Step 1: Write the failing tests** — `config.test.js`: `production refuses unsafe settings with one plain message` (local storage + file mail + http origin + dev secret + localhost Mongo → one error listing all five lines); `production origins must be sibling subdomains` (`https://app.a.in` + `https://api.b.in` refused; `app.a.in`/`api.a.in` accepted); `a safe production config loads with the release id`. `db-ready.test.js`: `the database must be MongoDB 7 or later with transactions` (stub `buildInfo`/`hello`: 6.0 → message; no `setName` → message; memory replica set → ok). `migrations.test.js`: `indexes are built for every model`; `a migration runs once and is recorded`; `a failing migration is not recorded and stops the run`; `every module model is listed for migrations` (glob `modules/*/model.js` and `core/**/model*.js` against `MODELS` model names). `wait-ready.test.js`: `ready when the new worker reports and health is ok`; `waiting for a release fails when the new worker never reports` (heartbeat release stays old → `ok: false` with the worker message, fake clock); `a failing health check fails the wait`. `atlas-role.test.js`: `the app role can only add and read audit entries`; `the app role covers every collection the app uses`. `setup.test.js`: `bootstrap reads the password from standard input when not given`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/config.test.js apps/api/test/db-ready.test.js apps/api/test/migrations.test.js apps/api/test/wait-ready.test.js apps/api/test/atlas-role.test.js apps/api/test/setup.test.js` → FAIL.
- [ ] **Step 3: Implement**; add `RELEASE_SHA=`, `FILES_OBJECT_LOCK=false` to `.env.example` with one-line comments.
- [ ] **Step 4: Run** the same command, then `npx vitest run --project api && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(api): refuse unsafe production settings, migrate indexes, wait for the new release, Atlas audit role (M9 Task 2)`

---

### Task 3: API — the import engine: upload, check, preview, confirm, templates, rows to fix

**Files:**
- Create: `apps/api/src/modules/imports/{model.js,service.js,runner.js,sheets.js,kinds/index.js,kinds/workers.js,jobs.js,json.js,routes.js}`, `apps/api/test/helpers/imports.js`, `apps/api/test/fixtures/imports/` (generated in the helper, not committed binaries)
- Modify: `apps/api/src/core/files/purposes.js`, `apps/api/src/core/files/service.js` (per-purpose `maxBytes`), `apps/api/src/modules/workers/service.js`, `apps/api/src/jobs.js`, `apps/api/src/app.js`
- Test: `apps/api/test/imports-engine.test.js`, `apps/api/test/imports-boundaries.test.js`, `apps/api/test/files.test.js`

**Interfaces:**
- Consumes: Task 1; `withTransaction`, `recordAudit`, `idempotent`, `versioned`, `respondCommitted`, `paginate`, `readSettings`, `listDesigners`, storage `getObject`/`headObject`; `safeCell` (M8 `packages/shared/src/reports/csv.js`; if M8 is not built, add it there with M8's contract); exceljs.
- Produces (`purposes.js`): `ALLOWED_TYPES` + `'text/csv': 'csv'`, `'application/vnd.ms-excel': 'csv'` (Windows browsers label `.csv` so), `'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'`; `registerFilePurpose(name, { allowedTypes, maxBytes = MAX_UPLOAD_BYTES, canWrite, canRead })`; `registerFilePurpose('import_file', { allowedTypes: those three, maxBytes: IMPORT_MAX_BYTES, canWrite: u => u.permissions.has('imports.run'), canRead: u => u.permissions.has('imports.run') })`.
- Produces (`workers/service.js`): `findWorkerByName(branchId, name) → lean | null` (case-insensitive, collation strength 2).
- Produces (`model.js`):
  - `ImportRun` (`importRuns`): `{ branchId, kind, fileKey, fileName, fileSha256, sameFileAs (runId | null), asOf (null), status: 'checking'|'checked'|'importing'|'done'|'failed'|'cancelled'|'expired', phase: 'check'|'commit', rowCount, nextRow (0), counts: { ready, exists, error, added, skipped, failed }, unusedColumns: [String], fileError: { code, message } | null, attempts, claimedAt, requestedBy, confirmedBy, confirmedAt, actor: { userId, ip, userAgent } | null, finishedAt }` + `commonFields` (version). Indexes: `recent (branchId, createdAt, _id)`; `queue (status, claimedAt)` partial `{ status: { $in: ['checking', 'importing'] } }`; `one_importing (branchId)` unique partial `{ status: 'importing' }`; `by_hash (branchId, kind, fileSha256)`.
  - `ImportRow` (`importRows`, `versionKey: false`): `{ runId, branchId, rowNo, key, status: 'ready'|'exists'|'error'|'added'|'skipped'|'failed', errors: [{ column, message, _id: false }], data: Mixed, cells: [Mixed] (original values, for "rows to fix"), label, entityId (null), groupKey (null), expiresAt }`. Indexes `row (runId, rowNo)` unique; `by_status (runId, status, rowNo)`; TTL `expires (expiresAt)` `expireAfterSeconds: 0`.
- Produces (`sheets.js`): `readImportFile(buffer) → { headers: string[], rows: [{ rowNo, cells }] }` — `PK\x03\x04` → exceljs `xlsx.load` (first worksheet with any value; cell value: formula → `result`, rich text → joined text, hyperlink → text, Date kept, error → `''`), else UTF-8 text → `parseCsv`; `rowNo` is the spreadsheet row number (header = 1); blank rows dropped; > `IMPORT_MAX_ROWS` → `ImportFileError('IMPORT_TOO_MANY_ROWS', 'This file has more than 5,000 rows. Split it into smaller files.')`; unreadable → `IMPORT_FILE_UNREADABLE`; no data rows → `IMPORT_FILE_EMPTY` "The file has no rows under the headings.". `templateXlsx(kind) → Buffer`, `templateCsv(kind) → Buffer` (Decision 10); `problemsXlsx(kind, rows) → Buffer` (original headers + "What to fix", every text cell through `safeCell`).
- Produces (`kinds/index.js`): `registerImportKind(kind, { context(branchId) → ctx, check(row, ctx) → { status: 'ready'|'exists', label }, commit(row | group, ctx, actor) → { status: 'added'|'skipped', entityId }, group?: (data) → groupKey })`; `getKindAdapter(kind)`. `kinds/workers.js` is the first adapter (exists: `findWorkerByName`; commit: `createWorker`; a race that finds the name taken → `skipped`). Tasks 4–6 add the rest.
- Produces (`runner.js`): `claimRun({ id } = {}) → run | null` (atomic: `checking`/`importing` with `claimedAt` null or older than 10 min → set `claimedAt`, `attempts + 1`; attempts > 3 → `failed`); `checkRun(run, { storage })` — read file, `matchHeaders` (missing required → `fileError` `IMPORT_COLUMNS_MISSING` "The file has no 'Phone' column. Download the template and copy your data into it.", status `checked` with 0 ready), per row `parseRow` + `check` (duplicate keys within the file → later rows `error` "Same as row 12"), insert `ImportRow`s in batches of 500, counts, `expiresAt = now + 7 days`, status `checked`; `commitRun(run, { storage })` — rows `ready` from `nextRow` in row order (groups together), each through `adapter.commit` (an `AppError` from a service → row `failed` with its plain message; any other error stops the run as `failed` and logs only `{ runId, code }`), `nextRow`/counts saved every 25 rows; finish: `done`, `finishedAt`, rows `expiresAt = finishedAt + 30 days`, audit `import`/`finish` `{ kind, counts }`.
- Produces (`service.js`): `startImport(branchId, { kind, fileKey, fileName, asOf }, actor, { storage }) → run` — key must start `<branchId>/import_file/` and exist (`headObject`, else 400 `ATTACHMENT_NOT_UPLOADED`); `fileSha256` from `headObject().sha256` or hashed while reading; `sameFileAs` = latest run of that kind with that hash; audit `import`/`request`; `rowCount ≤ IMPORT_LIGHT_ROWS` (known after the first read) → checked in-process at once. `getImport(branchId, id)`; `listImports(branchId, { kind, cursor, limit })`; `listImportRows(branchId, id, { status, cursor, limit })`; `confirmImport(branchId, id, { version }, actor)` — `checked` with `counts.ready > 0` (else 422 `NOTHING_TO_IMPORT` "There are no rows ready to add."), not expired; → `importing` (`one_importing` E11000 → 409 `IMPORT_BUSY`), `actor` stored with `userAgent: 'import:<id>'`, audit `confirm`; light → started at once. `cancelImport(branchId, id, { version })` — `checked` only → `cancelled`. `resumeImport(branchId, id, { version }, actor)` — `failed` during commit → `importing`, `attempts 0`. `runPendingImports({ storage, limit = 2, now })` — expires `checked` runs older than 7 days, claims and runs. `importSummary(branchId) → { [kind]: { lastRun: { id, status, counts, finishedAt } | null, added } }` (for Task 8).
- Produces (`jobs.js`): `defineJob('imports-run', { schedule: '1 minute', quiet: true, handler: ({ storage }) => runPendingImports({ storage }) })`.
- Produces (`json.js`): `toImportJson(run, { names }) → { id, kind, label, fileName, status, phase, rowCount, counts, progress: { done, total }, unusedColumns, fileError, sameFileAs: { id, at } | null, asOf, requestedBy: { id, name }, confirmedBy, createdAt, finishedAt, version }`; `toImportRowJson(row) → { rowNo, status, label, errors }` (no `data`).
- Produces (`routes.js`, `importsRouter(storage)` at `/v1/imports`, all `imports.run`): `GET /kinds` → `{ kinds: IMPORT_KINDS without parse fns }`; `GET /templates/:kind?format=xlsx|csv` → file bytes with `Content-Disposition: attachment; filename="<Label> template.xlsx"`; `POST /` (`validate(importStartSchema)`, `idempotent()`) → 202 `{ import }`; `GET /`; `GET /:id`; `GET /:id/rows`; `GET /:id/problems` → XLSX of `error` and `failed` rows; `POST /:id/confirm`, `/cancel`, `/resume` (versioned) → `{ import }`. Static paths before `/:id`.
- Produces (test helper `helpers/imports.js`): `importHelpers(app)` → `{ world() /* admin, operations, designer */, xlsx(kind, rows) / csv(kind, rows) → Buffer, upload(agent, buffer, type) → key, start(agent, kind, key, opts), waitFor(agent, id, status), confirm(agent, id) }`.

- [ ] **Step 1: Write the failing tests** — `imports-engine.test.js` (with the `workers` kind): `a filled template is checked and previewed without adding anything` (3 rows → `checked`, counts `{ ready: 3 }`, no workers yet); `rows that need fixing say which row and column` (row 3 blank name → `errors: [{ column: 'Name', message: … }]`, `rowNo` 3); `confirming adds the ready rows and leaves the rest` (2 ready + 1 error → `done`, 2 workers, `counts.added 2`); `uploading the same file twice adds nothing the second time` (second run: `sameFileAs` set, `exists 3`, confirm → `NOTHING_TO_IMPORT`); `duplicate rows inside one file are flagged`; `a file missing a required column explains which`; `CSV and Excel files are read the same`; `formulas give their value and blank rows are ignored`; `too many rows or an old .xls file is refused in plain words`; `a large file waits for the worker` (201 rows stay `checking` until `runPendingImports`); `one import at a time per branch` (second confirm while one is `importing` → 409 `IMPORT_BUSY`); `an unconfirmed check expires after a week`; `templates download as Excel and CSV with every column` (exceljs reads headers back, "How to fill" sheet present); `rows to fix are safe to open in Excel` (a name `=HYPERLINK("x")` comes back `'=HYPERLINK("x")` with "What to fix"); `an import logs nothing from the file` (capture logs with `helpers/logs.js` across check + commit + a failing row: no fixture name, phone or file name appears); `only admins can upload, see or download import files` (operations/designer: 403 on every route and on `upload-url` purpose `import_file`; `GET /v1/files/url?key=` → 404); `every import step is audited` (`request`, `confirm`, `finish`; created workers' audit entries carry `userAgent: 'import:<id>'`). `imports-boundaries.test.js`: `the imports module reads other modules only through their services` (no `imports/**` file imports a `model.js` outside `imports/`; nothing outside imports imports `modules/imports`). `files.test.js`: `import files accept Excel and CSV up to 5 MB, admin only`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/imports-engine.test.js apps/api/test/imports-boundaries.test.js apps/api/test/files.test.js` → FAIL.
- [ ] **Step 3: Implement**; mount `importsRouter(app.locals.storage)` at `/v1/imports`; import `modules/imports/jobs.js` in `src/jobs.js`. If M8 is not built yet, `npm install exceljs@4.4.0 -w apps/api`.
- [ ] **Step 4: Run** the same command → PASS; then `npx vitest run --project api && npm run lint`.
- [ ] **Step 5: Commit** `feat(api): import engine with checked preview, confirm, templates and rows to fix (M9 Task 3)`

---

### Task 4: API — customers, vendors, price list and stock through their own services

**Files:**
- Create: `apps/api/src/modules/imports/kinds/{customers.js,vendors.js,catalog.js,stock.js}`
- Modify: `apps/api/src/modules/customers/service.js`, `apps/api/src/modules/vendors/service.js`, `apps/api/src/modules/catalog/service.js`, `apps/api/src/modules/stock/service.js`
- Test: `apps/api/test/imports-kinds.test.js`

**Interfaces:**
- Consumes: Task 3 `registerImportKind`; `createCustomer`, `createVendor`, catalog `createItem`, M6 stock `createItem` (with `opening: { quantity, unitCost }` → `opening` movement at cost).
- Produces (owning services; each `(branchId, …, session?) → lean | null`): `customers.findCustomerByPhone(branchId, phone)` (reuse M7's phone lookup if it exists under another name, and record the ruling); `vendors.findVendorByName(branchId, name)`; `catalog.findItemByName(branchId, name)`; `stock.findStockItem(branchId, { name, brand, colour })` (on `searchName` + brand/colour, case-insensitive).
- Produces (adapters): `customers` (exists by phone; commit `createCustomer`; `PHONE_TAKEN` from a race → `skipped`); `vendors`; `catalog` (garment types in the row must be settings garment types; a type already mapped to another item → row `failed` with the service's `CATALOG_MAPPING_TAKEN` message); `stock` (commit `createItem` with `opening` when "Quantity in stock" > 0, cost = "Cost per unit" × quantity via M6 `unitCostToValue`; the movement is type `opening`, audited by the stock service). Each adapter's `context` loads settings choices once per run.

- [ ] **Step 1: Write the failing tests** — `customers are added with consent notes and states`; `a customer whose phone is already in the system is left as it is` (the existing customer's name unchanged); `vendors and price-list items are matched by name whatever the case`; `a price-list row with a garment type already mapped is reported, the rest are added`; `stock comes in with an opening movement at its cost` (2.5 m at ₹400/m → `onHand 2500`, value 100000, one `opening` movement, audit `stock_item`/`create`); `stock without a cost cannot be added with quantity`; `an import interrupted half way resumes without duplicates` (customers: make `createCustomer` throw a plain `Error` on row 30 of 60 once → run `failed` at `nextRow`; `resumeImport` → 60 customers total, each phone once, counts add up to 60); `imported customers get no messages` (outbox empty after a customers import).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/imports-kinds.test.js` → FAIL.
- [ ] **Step 3: Implement.** If M6 is not built, leave `stock` unregistered with a `.skip`ped test and a ruling (the kind card shows "Available after the stock module").
- [ ] **Step 4: Run** `npx vitest run apps/api/test/imports-kinds.test.js apps/api/test/imports-engine.test.js apps/api/test/customers.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): bring in customers, vendors, price list and opening stock through their services (M9 Task 4)`

---

### Task 5: API — open orders at their current stage

**Files:**
- Create: `apps/api/src/modules/orders/imports.js`, `apps/api/src/modules/imports/kinds/orders.js`
- Modify: `apps/api/src/modules/orders/{model.js,service.js,json.js}` (and `listOrders` search), `apps/api/src/modules/production/service.js`, `apps/web/src/features/orders/` order header + list row (show "Old no.")
- Test: `apps/api/test/orders-import.test.js`, `apps/web/src/features/orders/orders.test.jsx`

**Interfaces:**
- Consumes: `stagePlanFor`, `buildGarments`, `checkGarmentInputs`, `nextDocumentNumber`, `readSettings`, `getBranch`, `listDesigners`, `findCustomerByPhone`.
- Produces (`orders/model.js`): `legacyRef: { type: String, default: null }` on orders; index `legacy_ref (branchId, legacyRef)` unique partial `{ legacyRef: { $type: 'string' } }`.
- Produces (`production/service.js`): `recordImportedStage(branchId, { orderId, garmentId, stage }, actor, session)` — inserts one event `{ action: 'imported', stage, remarks: 'Brought in from earlier records', by, at }`; requires `session`.
- Produces (`orders/imports.js`, re-exported by `service.js`):
  - `findOrderByLegacyRef(branchId, legacyRef) → lean | null`.
  - `importOrder(branchId, { legacyRef, customerId, designerId, priority, orderDate, pickupDate, notes, garments: [{ type, description, fabric, agreedPrice, quantity, dueDate, stage }] }, actor) → { order, garments }` — `orderDate ≤ today` (else 422 `ORDER_DATE_IN_FUTURE`), `pickupDate ≥ orderDate`, may be past (Decision 13); `checkGarmentInputs` with the past-pickup rule relaxed; one transaction: `legacyRef` taken → 409 `ORDER_EXISTS` "An order with this old number is already in the system"; number from today's FY series (as `createOrder`); garments via `buildGarments` from `orderDate`; then per garment `currentStage = stage`, `stageState 'pending'`, `stage === 'ready_for_pickup'` → `status 'ready'`, `readyDate = today`; `stage === 'picked_up'` → 400 on that garment; `recordImportedStage`; audit `order`/`import` `{ orderNo, legacyRef, garments }`. No `emit`.
- Produces (`json.js`/list): order JSON gains `legacyRef`; `listOrders({ q })` matches `legacyRef` exactly.
- Produces (adapter `orders`): `group = data => data.legacyRef` (Decision 14); `context` loads designers (matched by name, case-insensitive; two designers with one name → row error "Two designers are called Asha — use their email"; email also accepted) and garment types; check: customer by phone exists (else "No customer with phone … — bring in customers first"), legacyRef exists → `exists`; commit the group through `importOrder`.
- Web: order page header and order list rows show "Old no. 1234" when `legacyRef` is set.

- [ ] **Step 1: Write the failing tests** — `orders-import.test.js`: `an open order comes in with each garment at its stage` (3 rows, one old number → one order, 3 garments at Tailors/Finishing/Ready for pickup; the ready one `status 'ready'`; one `imported` stage event each; plan built from the order date); `an imported order gets a new number and keeps the old one` (searchable by old number); `the same old order number is never brought in twice` (second file → `exists`; direct `importOrder` → 409 `ORDER_EXISTS`); `rows of one order must agree` (second row with another customer → error on that row; the order is not added); `a past pickup date is allowed and shows late`; `picked-up garments are not open orders`; `designers are matched by name or email`; `quantity makes a batch`; `imported orders send no messages and reserve no materials`; `imported is never an allowed next action`. `orders.test.jsx`: `the old order number is shown on the order`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/orders-import.test.js && npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/orders-import.test.js apps/api/test/orders-create.test.js apps/api/test/production-actions.test.js && npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(api): bring in open orders at their current stage with the old order number (M9 Task 5)`

---

### Task 6: API — opening balances: owed and advances held, outside GST

**Files:**
- Create: `apps/api/src/modules/billing/opening.js`, `apps/api/src/modules/imports/kinds/openingBalances.js`, `apps/api/src/migrations/001-billing-receivables-index.js`
- Modify: `apps/api/src/modules/billing/{model.js,service.js,ledger.js,payments.js,daily.js,routes.js,json.js}` (and M8 `billing/reports.js` if built), `apps/api/src/migrations/index.js`, `apps/web/src/features/billing/` ledger rows + `apps/web/src/lib/errorMessages.js`
- Test: `apps/api/test/billing-opening.test.js`, `apps/web/src/features/customers/ledger.test.jsx` (or the existing customer-ledger web test)

**Interfaces:**
- Consumes: `nextDocumentNumber`, `assertPeriodOpen`, `recordAudit`, `getCustomer`, `findOrderByLegacyRef`, `financialYear`.
- Produces (`model.js`): discriminator `opening_balance` `{ amount, dueDate, settlement: { paid, balance }, note, legacyRef }` (issued on creation; no `pdf`); `Receipt` gains `opening: { type: Boolean, default: false }` and `mode` required unless `opening`; index `receivables_v2 (branchId, type, status, dueDate)` partial `{ 'settlement.balance': { $gt: 0 } }` replacing `receivables`.
- Produces (`migrations/001-billing-receivables-index.js`): `{ id: '001-billing-receivables-index', up: db => drop index 'receivables' on billingDocuments if present }`; listed in `migrations/index.js`.
- Produces (`opening.js`, re-exported):
  - `recordOpeningBalance(branchId, { customerId, owed, advance, asOf, note, orderId }, actor) → { openingBalance | null, receipt | null }` — one transaction: `assertPeriodOpen(asOf)`; `asOf > today` → 422 `DATE_IN_FUTURE`; an issued opening balance or opening receipt for the customer → 409 `OPENING_EXISTS` "This customer already has an opening balance"; `owed > 0` → `opening_balance` numbered `OB/<fy of asOf>/<0001>` (`docType 'opening_balance'`), `dueDate = asOf`, `settlement { paid: 0, balance: owed }`; `advance > 0` → `Receipt { opening: true, mode: null, amount: advance, date: asOf, orderId }` numbered `OA/<fy>/<0001>` (`docType 'opening_advance'`), no receipt voucher, no PDF; audit `opening_balance`/`create` `{ customerId, owed, advance, asOf, numbers }`.
  - `hasOpeningBalance(branchId, customerId) → boolean`.
  - `cancelOpeningBalance(branchId, id, { reason }, actor)` — the `opening_balance` or opening receipt; month open; nothing paid/allocated (else 422 `OPENING_IN_USE` "Payments are already set against this balance"); → `cancelled`, audited.
- Produces (behaviour in existing files): ledger labels "Owed before <D MMM YYYY> (opening balance)" (debit) and "Advance held before <date> (opening balance)" (credit); `ledgerTypes` includes `opening_balance`; `receivablesFilter` → `type: { $in: ['invoice', 'opening_balance'] }`; `recordPayment` allocations accept an issued `opening_balance` like an invoice (settlement updated identically); advance application to a final invoice draws on opening receipts like any receipt, with no tax deducted (Decision 12); `listReceipts`, the daily collections summary and (if M8 built) `periodMoney`/`monthlyMoney`/collections register exclude `opening: true`; GSTR-1 and document summary are by GST types and so already exclude them (asserted). Route `POST /v1/billing/opening-balances/:id/cancel` (`billing.cancel`, `versioned` reason).
- Produces (adapter `opening_balances`): `context` loads `asOf` from the run; check: customer by phone (else row error), `hasOpeningBalance` → `exists`, "Old no." → `findOrderByLegacyRef` (must be that customer's, else error); commit `recordOpeningBalance`.
- Web: ledger rows show the labels; an admin "Cancel opening balance" action on those rows (reason dialog); `errorMessages`: `OPENING_EXISTS`, `OPENING_IN_USE`, `IMPORT_BUSY`, `NOTHING_TO_IMPORT`, `ORDER_EXISTS`, `ORDER_DATE_IN_FUTURE`, `IMPORT_COLUMNS_MISSING`, `IMPORT_TOO_MANY_ROWS`, `IMPORT_FILE_UNREADABLE`, `IMPORT_FILE_EMPTY`, `RATE_LIMITED`.

- [ ] **Step 1: Write the failing tests** — `billing-opening.test.js`: `opening balances never take a GST number or reach GST figures` (after importing owed ₹5,000 + advance ₹2,000: invoice/RV/receipt counters unchanged; GSTR-1 rows and document summary (if M8) contain neither; `listReceipts` and the daily collections summary exclude the advance); `an opening balance is owed, ages and can be paid` (`customerMoneySummary.outstanding 500000`, `listReceivables({ bucket: 'overdue' })` includes it after the cut-over date; a ₹3,000 payment allocated to it → balance 200000); `an opening advance is held and used by the next bill` (`advanceHeld 200000`; issue a bill on the order → advance applied, no tax deducted); `the ledger labels opening balances plainly`; `one opening balance per customer` (second import row → `exists`; direct call → 409); `opening balances respect month locks and are dated the cut-over day`; `a mistaken opening balance is cancelled and brought in again` (cancel with reason → audited; re-import adds it); `an opening balance with payments cannot be cancelled`; `the receivables index is used and the old one is dropped by the migration` (`explain` no `COLLSCAN`; `runMigrations` drops `receivables`). Web: `opening balance rows show their label and admins can cancel them`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/billing-opening.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/billing-opening.test.js apps/api/test/billing-ledger.test.js apps/api/test/billing-payments.test.js apps/api/test/billing-e2e.test.js && npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(api): opening balances owed and advances held, outside the GST series (M9 Task 6)`

---

### Task 7: Web — "Bring in old records": template, upload, preview, add, progress

**Files:**
- Create: `apps/web/src/features/imports/{importsApi.js,ImportsPage.jsx,KindCard.jsx,UploadStep.jsx,PreviewPage.jsx,RowList.jsx,ProgressCard.jsx}`, `apps/web/src/test/imports.js`
- Modify: `apps/web/src/App.jsx`, `apps/web/src/layout/navItems.js`, `apps/web/src/test/server.js`
- Test: `apps/web/src/features/imports/imports.test.jsx`

**Interfaces:**
- Consumes: Task 3 routes; `uploadFile(file, 'import_file')`; `apiFetch`; `DateLabel`, `EmptyState`, `LoadMore`.
- Produces:
  - `importsApi.js`: `IMPORTS_KEY`; `useImportKinds()`, `useImports()`, `useImport(id)` (refetch every 2 s while `checking`/`importing`), `useImportRows(id, status)` (infinite), `useStartImport()` (Idempotency-Key made per upload), `useConfirmImport(id)`, `useCancelImport(id)`, `useResumeImport(id)`; `downloadTemplate(kind, format)` and `downloadProblems(id)` (fetch with credentials → blob → save with the server's filename).
  - `/imports` → `ImportsPage` behind `imports.run`: intro "Bring your old records into the system. Do them in this order." Numbered `KindCard`s (Decision 1): label, one-line help, last result ("Done: 412 added on 3 Nov" / "Not started" / "Checking…"), buttons "Download template" (Excel; "CSV instead" link) and "Upload filled file".
  - `UploadStep`: file input `accept=".xlsx,.csv"`; for `needsAsOf` kinds first "Cut-over date (the last day of your old records)" (default yesterday, max today); upload progress; then navigates to `/imports/:id`.
  - `/imports/:id` → `PreviewPage`: while `checking`: "Checking your file…" spinner. `checked`: summary chips "480 ready to add · 12 already in the system · 8 need fixing" (each filters `RowList`); `fileError` → its message with "Download template"; `unusedColumns` → "These columns were not used: Remarks"; `sameFileAs` banner; `RowList` rows "Row 14 · Priya S — Phone: '98765' is not a 10-digit mobile number"; "Download rows to fix" when errors > 0; sticky bottom "Add 480 customers" → confirm dialog "Rows that need fixing are left out. Fix them in the downloaded file and upload it again — rows already added will be skipped." and "Cancel this upload". `importing`: `ProgressCard` "Adding… 120 of 480" (bar). `done`: "Added 478 · 2 were already in the system · 0 could not be added" with a link to the records ("View customers" → `/customers`) and "Download rows to fix" when any failed. `failed`: "Adding stopped part way. Nothing was added twice." + "Continue adding". `expired`/`cancelled`: "Upload the file again".
  - Nav: `{ label: 'Bring in records', path: '/imports', permission: 'imports.run', icon: IconFileImport, phone: 'more' }` after Settings.

- [ ] **Step 1: Write the failing tests** — `the kinds are listed in order with their last result`; `a template downloads as Excel`; `uploading a filled file shows the check, then the preview` (MSW: `checking` → `checked`); `rows needing fixes say the row, column and problem`; `opening balances ask for the cut-over date first`; `adding confirms first and then shows progress`; `a stopped import offers to continue`; `a file with a missing column explains what to do`; `operations and designers have no Bring in records menu and are sent away`.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Visual check** at 390 and 1280 px (kind list, preview with errors, progress, done) with the M4 visual harness seeded with a 30-row customers file containing 3 errors.
- [ ] **Step 6: Commit** `feat(web): bring in old records with templates, a plain preview and progress (M9 Task 7)`

---

### Task 8: API + Web — "Getting ready to go live" checklist

**Files:**
- Create: `apps/api/src/modules/setup/{goLive.js,routes.js}`, `apps/web/src/features/goLive/{goLiveApi.js,GoLivePage.jsx,NumberingCheck.jsx,GoLiveBanner.jsx}`
- Modify: `packages/shared/src/schemas/settings.js` (`goLive`), `apps/api/src/core/backup/backup.js`, `apps/api/src/modules/catalog/service.js`, `apps/api/src/app.js`, `apps/web/src/App.jsx`, `apps/web/src/features/home/HomePage.jsx` (or M8 `DashboardPage`), `apps/web/src/layout/navItems.js`, `apps/web/src/test/server.js`
- Test: `apps/api/test/go-live.test.js`, `apps/api/test/backup.test.js`, `apps/web/src/features/goLive/goLive.test.jsx`

**Interfaces:**
- Consumes: `getBranch`, `readSettings`, `updateSettings`, `seriesUsed`/`holdSeries`, `listUsers`, `importSummary`, `latestIntegrityCheck`, notify mail adapter (`sendMail` via the registered `email` adapter), `recordAudit`.
- Produces (`schemas/settings.js`): `goLive: strictObject({ numbersConfirmedFy: string | null, testEmailAt: Date-string | null, liveSince: ymd | null })` default all null (not editable through `PUT /v1/settings`; written by `goLive.js` only).
- Produces (`core/backup/backup.js`): on success `system` doc `last-backup` `{ at, key }`; `lastBackup() → { at, key } | null`.
- Produces (`catalog/service.js`): `garmentTypesWithoutItem(branchId) → [key]` (active settings garment types with no active catalog item mapping).
- Produces (`goLive.js`): `goLiveChecklist(branchId) → { checks: [{ key, label, status: 'done'|'todo'|'warning', detail, link }], done, total, liveSince }` with checks, in order: `business` (legal name, GSTIN, address line 1, city, pincode, phone; logo → `warning` only) → `/settings`; `numbers` (`numbersConfirmedFy === current FY code`; detail "Next bill: INV/2627/0124") → `/go-live#numbers`; `price_list` (`garmentTypesWithoutItem` empty) → `/catalog`; `staff` (≥ 1 active operations and ≥ 1 active designer) → `/users`; `imports` (`done` when the customers kind has a `done` run; any other kind never run → `warning` "Not brought in: Stock, Open orders" — optional, since a boutique may have none) → `/imports`; `email` (`testEmailAt` set) → button; `backup` (`lastBackup().at` within 7 h → done; never → todo "The first backup runs within 6 hours of going online") ; `records` (latest integrity check `ok`) → `/accounts`. `confirmNumbers(branchId, { series: { invoice, credit_note, receipt_voucher, refund, receipt: lastUsedNumber | 0 } }, actor)` — for each type sets `numberSeries['<type>:<fy>'] = last + 1` through `updateSettings` (refused by the existing `holdSeries` rule when a number is already used: 422 `SERIES_IN_USE`), sets `numbersConfirmedFy`; `sendTestEmail(branchId, actor)` — sends "Your boutique system can send email" to the actor's email, sets `testEmailAt`; a send error → 422 `EMAIL_NOT_SENT` "The email could not be sent. Check the email set-up step in the go-live guide." (no address in logs); `markLive(branchId, actor)` → `liveSince = today`, audit `settings`/`go_live`.
- Produces (routes, `setupRouter()` at `/v1/go-live`, `settings.edit`): `GET /` → checklist; `POST /numbers` (strict schema: each value int 0–999999) → checklist; `POST /test-email` (5 per hour per branch → 429 `RATE_LIMITED`) → checklist; `POST /live` → checklist.
- Web: `/go-live` → `GoLivePage` (admin): "Getting ready to go live", "5 of 8 done" bar, one row per check (icon + label + detail + "Open" link or action button), `NumberingCheck` per series: "This is our first … this year" / "Continue after number [ ]" with the formatted next number previewed; "Send a test email"; sticky "We are live" (enabled when all `done`, with "Go live anyway" for warnings) → confirm "Staff will use the system from today. Keep the paper form for one more week as a backup." `GoLiveBanner` on Home for admins while `liveSince` is null: "Getting ready to go live: 5 of 8 done" → `/go-live`. Nav item `{ label: 'Go live', path: '/go-live', permission: 'settings.edit', icon: IconRocket, phone: 'more' }` shown only while not live.

- [ ] **Step 1: Write the failing tests** — `go-live.test.js`: `a new branch has everything still to do`; `bill numbers continue from the old book` (invoice last 123 → next issued bill `INV/2627/0124`; credit notes "first this year" → `/0001`); `numbers cannot be changed once a bill is issued` (422 `SERIES_IN_USE`); `the test email is sent and remembered` (file mail adapter receives it); `a failing email says what to check`; `the backup check uses the last successful backup`; `going live is recorded and audited`; `only admins see the checklist`. `backup.test.js`: `a successful backup is remembered`. `goLive.test.jsx`: `the checklist shows what is done and links to each place`; `continuing bill numbers shows the next number`; `we are live asks for confirmation and hides the banner`; `the banner shows on Home for admins until live`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/go-live.test.js apps/api/test/backup.test.js && npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same + `npm run lint` → PASS.
- [ ] **Step 5: Visual check** at 390 and 1280 px (checklist half done, numbering, banner on Home).
- [ ] **Step 6: Commit** `feat: go-live checklist with bill number continuity, test email and backup status (M9 Task 8)`

---

### Task 9: API — rate limits, headers, cookies, lockout and logs hardened

**Files:**
- Create: `apps/api/src/core/rateLimit.js`
- Modify: `apps/api/src/core/security.js`, `apps/api/src/app.js`, `apps/api/src/modules/auth/{routes.js,service.js}`, `apps/api/src/modules/users/passwordReset.js`, `apps/api/src/logger.js`, `apps/api/src/core/auth/rateLimit.js`
- Test: `apps/api/test/security.test.js`, `apps/api/test/auth.test.js`, `apps/api/test/logger.test.js`

**Interfaces:**
- Produces (`core/rateLimit.js`): `apiRateLimiter(config)` — express-rate-limit, window 60 s, key `user:<id>` when signed in (mounted after `loadUser`) else `ip:<ip>`, limits `config.rateLimits.user` / `.anonymous`, `/v1/health` exempt, 429 `RATE_LIMITED` "Too many requests. Wait a minute and try again." with `RateLimit-*` headers.
- Produces (`security.js`): `helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true }, crossOriginResourcePolicy: { policy: 'same-site' } })`; middleware `noStore` setting `Cache-Control: no-store` on every `/v1` response (file bytes from `/v1/dev-files` and template downloads keep it too).
- Produces (auth): `logout` clears with `{ path: '/', httpOnly: true, secure: config.cookie.secure, sameSite: 'strict' }`; `login` with an unknown email runs `verifyPassword` against a fixed dummy argon2 hash and counts failures per lower-cased email in the same store as known accounts (10 → 423 `ACCOUNT_LOCKED` for unknown emails too); password-reset request answers 202 with the same body immediately and looks up/sends through the outbox after the response (`setImmediate`), never revealing existence.
- Produces (`logger.js`): redaction adds `*.*.*.<field>` and `gstin`, `token`, `rawBody`, `req.body` (bodies are never logged).

- [ ] **Step 1: Write the failing tests** — `security.test.js`: `too many requests are slowed with a plain message` (config limit 5: 6th request → 429 `RATE_LIMITED`; health exempt; another user unaffected); `API responses are never cached and cannot be framed` (`Cache-Control: no-store`, `Content-Security-Policy` contains `frame-ancestors 'none'`, HSTS `max-age=63072000; includeSubDomains`); `only the app origin may call with credentials` (other origin: no `Access-Control-Allow-Origin`; app origin: allowed with credentials; preflight `Access-Control-Max-Age: 7200`); `state changes need the app header` (existing, kept). `auth.test.js`: `logging out clears a secure cookie in production` (production-shaped config over supertest with `X-Forwarded-Proto: https`: `Set-Cookie` has `__Host-sid=;`, `Secure`, `HttpOnly`, `SameSite=Strict`); `unknown emails lock exactly like real ones` (11 attempts each: same statuses and codes); `asking to reset a password answers the same for any email`. `logger.test.js`: `deeply nested personal fields are hidden`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/security.test.js apps/api/test/auth.test.js apps/api/test/logger.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project api && npm run lint` → PASS (the rate limit is generous in tests per Task 2 config).
- [ ] **Step 5: Commit** `feat(api): request limits, strict headers, secure logout and lockout that reveals nothing (M9 Task 9)`

---

### Task 10: Files — checksummed uploads, locked bill PDFs, bill photos in "Check records"

**Files:**
- Modify: `apps/api/src/core/files/{storage-s3.js,storage-local.js,service.js,routes.js}`, `packages/shared/src/schemas/` (upload-url schema), `apps/web/src/lib/upload.js`, `apps/api/src/modules/billing/{pdfs.js,integrity.js}`, `apps/api/src/modules/expenses/{model.js,service.js}`
- Test: `apps/api/test/files.test.js`, `apps/api/test/storage-s3.test.js`, `apps/api/test/billing-integrity.test.js`, `apps/api/test/expenses-create.test.js`, `apps/web/src/lib/upload.test.js`

**Interfaces:**
- Produces (upload): `POST /v1/files/upload-url` body gains `sha256` (64 lowercase hex, optional); S3 `presignPut({ key, contentType, size, sha256 })` adds `ChecksumSHA256: base64(sha256)` to the signed command (header `x-amz-checksum-sha256` returned in `headers`); local adapter rejects a PUT whose bytes do not match (400) and stores it. `headObject` (S3 with `ChecksumMode: 'ENABLED'`) returns `sha256` from `ChecksumSHA256` (hex) or `Metadata.sha256`.
- Produces (server writes): `putObject({ key, body, contentType, contentDisposition?, retainYears? })` — computes SHA-256 for Buffers, sends `ChecksumSHA256` + `Metadata.sha256`; `retainYears` with `config.aws.objectLock` → `ObjectLockMode: 'COMPLIANCE'`, `ObjectLockRetainUntilDate = now + years`. Billing PDFs pass `retainYears: 8`.
- Produces (web `upload.js`): `sha256Hex(file) → Promise<string>` (`crypto.subtle.digest`); `uploadFile` sends it and the returned headers.
- Produces (expenses): attachments gain `sha256` (from `headObject`; null when absent); `listAttachmentHashes(branchId, { after, limit = 500 }) → [{ expenseId, number, key, sha256 }]` (non-null only).
- Produces (integrity): "Check records" also re-hashes expense bill photos with a stored hash; problems reported like PDFs with `kind: 'expense_photo'`, label "Bill photo of EXP/2627/0012" (`missing` / `hash_mismatch`).

- [ ] **Step 1: Write the failing tests** — `storage-s3.test.js` (aws-sdk-client-mock): `uploads are signed with their checksum`; `server-written files carry their checksum`; `bill PDFs are locked for 8 years when Object Lock is on` (and not when off). `files.test.js`: `a file whose bytes do not match its checksum is refused` (local adapter). `expenses-create.test.js`: `a bill photo's checksum is kept with the expense`. `billing-integrity.test.js`: `check records finds a changed bill photo`. `upload.test.js`: `uploads send the file's SHA-256`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/storage-s3.test.js apps/api/test/files.test.js apps/api/test/billing-integrity.test.js apps/api/test/expenses-create.test.js && npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same + `npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat: checksummed uploads, locked bill PDFs and bill photos in check records (M9 Task 10)`

---

### Task 11: Restore drill — prove a backup restores and its records verify

**Files:**
- Create: `apps/api/src/core/backup/restoreCheck.js`, `apps/api/src/cli/restore-drill.js`
- Modify: `docs/ops/restore.md`
- Test: `apps/api/test/restore-drill.test.js`

**Interfaces:**
- Consumes: `verifyAuditChain`, `mongodumpStream`'s private-config-file pattern, `@aws-sdk/client-s3` (`ListObjectsV2`, `GetObject`).
- Produces (`restoreCheck.js`): `checkRestoredDatabase(connection) → { ok, collections: [{ name, count }], branches: [{ branchId, auditEntries, chainOk, firstBreak }], newestRecordAt, problems: [string] }` — counts every collection, runs the audit chain verification for each branch against `connection` (models bound with `connection.model(name, schema)` — no default-connection side effects), newest `auditLog.at`; problems in plain words ("Audit chain broken at entry 42 of branch …", "No users in the backup").
- Produces (`cli/restore-drill.js`): `runDrill({ listBackups, download, restore, connect, dropDatabase, now, out }) → report` (exported; CLI wires S3 + `mongorestore --config=<0600 temp file> --archive --gzip --nsFrom='<db>.*' --nsTo='<db>_restore_check.*'`) — newest key under `mongodump/`, restore into `<db>_restore_check`, `checkRestoredDatabase`, backup age vs `now` ("Backup is 3 h old"), drops the scratch database unless `--keep`, prints the report; exit 1 on any problem. Reads `MONGO_URI` and `BACKUPS_BUCKET` from the operator's environment; the URI never appears in output or arguments.
- `docs/ops/restore.md` gains "Restore drill (do before go-live and every 3 months)" with the one command, the expected report and what to do on a failure.

- [ ] **Step 1: Write the failing tests** — `a restored backup passes the drill` (seed memory DB with a branch, users, audit entries; fake `restore` copies collections into `<db>_restore_check`; report `ok`, counts equal, scratch DB dropped afterwards); `a tampered audit entry fails the drill`; `the newest backup is chosen`; `the database password never appears in the drill output or command line` (fake `spawn` records argv; output captured).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/restore-drill.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/restore-drill.test.js apps/api/test/backup.test.js && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(ops): restore drill that restores the newest backup and verifies its records (M9 Task 11)`

---

### Task 12: End-to-end — phone-sized journeys in a real browser

**Files:**
- Create: `apps/e2e/{package.json,playwright.config.js,global-setup.js,global-teardown.js,seed.js,tests/order-to-payment.spec.js,tests/enquiry-to-order.spec.js,tests/home-drilldown.spec.js,tests/bring-in-customers.spec.js}`
- Modify: root `package.json` (script `"e2e": "playwright test -c apps/e2e/playwright.config.js"`), `.gitignore` (`apps/e2e/test-results`, `playwright-report`), `eslint.config.js` (e2e globals)
- Test: the specs themselves

**Interfaces:**
- `apps/e2e/package.json`: `@vs/e2e`, private, devDependency `@playwright/test: 1.49.1`.
- `global-setup.js`: starts `MongoMemoryReplSet` (1 node), writes `MONGO_URI` to the env of the API (`node apps/api/src/server.js`, port 4100) and worker processes, local storage/mail under a temp dir, `APP_ORIGIN=http://localhost:4173`; runs `seed.js` (bootstrap branch + admin, an operations user and a designer, garment types, a catalog item mapped to "Blouse" at 5 %); builds and serves the web (`vite preview --port 4173` with `VITE_API_URL=http://localhost:4100`); waits for `/v1/health` 200. Teardown stops everything.
- `playwright.config.js`: Chromium only, `viewport 390×844`, `isMobile: true`, `hasTouch: true`, `retries: 1` in CI, `trace: 'retain-on-failure'`, `workers: 1` (one database).
- Journeys (each logs in through the UI):
  - `order-to-payment`: operations creates a customer → takes an order (one Blouse) → designer moves it through every stage to Ready for pickup → operations issues the bill → takes a full payment → the bill shows "Paid" and the PDF link appears.
  - `enquiry-to-order` (M7): new enquiry → book an appointment → convert → the order form opens pre-filled.
  - `home-drilldown` (M8): admin taps "Billed" on Home → the list sums to the figure.
  - `bring-in-customers`: admin downloads the customers template, uploads a generated 5-row file with one bad phone → preview "4 ready · 1 needs fixing" → adds → customers list shows 4.
  - Specs for unbuilt modules (M7/M8) are `test.skip` with the reason, and become active when the module exists.

- [ ] **Step 1: Write the specs** as above (they fail until set-up exists).
- [ ] **Step 2: Run** `npm install && npx playwright install chromium && npm run e2e` → FAIL (no setup).
- [ ] **Step 3: Implement** setup, seed and teardown.
- [ ] **Step 4: Run** `npm run e2e` → PASS (skips only for unbuilt modules); `npm run lint` → PASS.
- [ ] **Step 5: Commit** `test(e2e): phone-sized journeys from order to payment, enquiry, home and imports (M9 Task 12)`

---

### Task 13: Deploy scripts, CI and the go-live runbook

**Files:**
- Create: `deploy/scripts/rollback.sh`, `.gitattributes`, `docs/ops/go-live.md`, `apps/api/test/deploy-scripts.test.js`
- Modify: `deploy/scripts/remote-deploy.sh`, `deploy/nginx/api.conf`, `deploy/ecosystem.config.cjs`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `docs/ops/infrastructure.md`, `README.md` (links only)
- Test: `apps/api/test/deploy-scripts.test.js`

**Interfaces:**
- `remote-deploy.sh <sha> <api-host>` — steps: record current release in `.release-previous`; fetch + reset; `npm ci --omit=dev`; `write_env` (values written **single-quoted**; a value containing `'` is refused naming the parameter; `trap` removes the temp file on any exit; `RELEASE_SHA=<sha>` appended); `node apps/api/src/cli/migrate.js`; ensure `pm2-logrotate` (`pm2 describe pm2-logrotate >/dev/null || pm2 install pm2-logrotate`; `max_size 10M`, `retain 14`, `compress true`); `pm2 startOrReload … --update-env && pm2 save`; `node apps/api/src/cli/wait-ready.js <sha>`; finally `curl -fsS https://<api-host>/v1/health`. The file ends with `if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; exit $?; fi` on one line (sourcing it in tests defines functions only).
- `rollback.sh` — runs `remote-deploy.sh "$(cat .release-previous)" <api-host>`; refuses when the file is missing ("No previous release recorded").
- `api.conf` — `listen 443 ssl http2;` / `listen [::]:443 ssl http2;` (Amazon Linux 2023 nginx 1.24; no `http2 on;`), `server_tokens off;`.
- `ecosystem.config.cjs` — unchanged apps; `kill_timeout` 10 s for the API; `merge_logs: true`.
- `deploy.yml` — SSM: poll `get-command-invocation` every 10 s up to 15 min until `Success`/`Failed`/`Cancelled`/`TimedOut` (no `aws ssm wait`); `needs: [ci]` where `ci.yml` now has jobs `test` and `e2e`.
- `ci.yml` — job `test` adds `shellcheck deploy/scripts/*.sh`; new job `e2e` (`npx playwright install --with-deps chromium`, `npm run e2e`, upload `playwright-report` on failure).
- `.gitattributes` — `* text=auto`; `*.sh text eol=lf`; `*.conf text eol=lf`; `*.cjs text eol=lf`.
- `docs/ops/infrastructure.md` updates: files bucket **created with Object Lock** (no default retention; app sets retention on PDFs) and lifecycle rules (`*/reports/` expire 90 days; `*/import_file/` expire 30 days; noncurrent versions 90 days); files CORS adds `x-amz-checksum-sha256` to `AllowedHeaders`; IAM instance role adds `s3:PutObjectRetention` (files) and `s3:AbortMultipartUpload` (backups); CloudFront headers policy CSP adds `frame-ancestors 'none'`; SSM parameters add `FILES_OBJECT_LOCK=true` (and note `RELEASE_SHA` is written by the deploy); CloudWatch metric filter on `"job failed"` log lines → alarm to the owner; Atlas: confirm cluster version ≥ 7.0, apply `node apps/api/src/cli/atlas-role.js` output as a custom role if available.
- `docs/ops/go-live.md` — the runbook, three parts, each step a checkbox with who does it:
  1. **Operator (AWS/Atlas/DNS — never done by the app or an agent):** domain DNS records; ACM; S3 web/files (Object Lock)/backups buckets with lifecycle; CloudFront + headers policy; EC2 + Elastic IP + IAM role + security group; Atlas M0 cluster, user, IP list, version check, custom audit role (record "available / not available on M0"); SES domain identity, DKIM/SPF/DMARC, **production access request**; SSM parameters; GitHub OIDC role, `production` environment, variables and secret; CloudWatch agent, health check alarm, failed-job metric alarm, EC2 auto-recovery, DLM snapshots; merge to `main` and watch the Deploy workflow; run `bootstrap.js` once over Session Manager; run the restore drill from the operator's machine once the first backup exists and record the result.
  2. **Owner (in the app):** the go-live checklist (business details, bill numbers continuing from the old book, price list with the accountant's HSN/SAC and slabs, staff invited, bring in records in order with one cut-over date, compare opening balances with the paper ledger total, test email, first backup, check records); accountant confirms Decision 12 (opening advances and GST) and the open spec §15 items.
  3. **Switching over:** train staff (a 30-minute script per role: front desk, designer, admin); one week running alongside the paper form; daily: compare the day's bills and payments with paper; after the week: "We are live", retire the paper form; first month-end: GST pack, file, lock the month.
  Plus "If something goes wrong": rollback, restore (link), who to call.

- [ ] **Step 1: Write the failing tests** — `deploy-scripts.test.js` (skipped where `bash` is unavailable): `deploy scripts parse` (`bash -n` both); `env values are single-quoted and a quote is refused` (source the script with a fake `aws` on `PATH` printing two parameters; `.env` lines `KEY='value'`; a value with `'` → non-zero, names the parameter, no `.env.*` temp file left); `env is not written without the database address`; `the release id is written to env`; `the deploy migrates and waits for the new release` (script text contains `cli/migrate.js` before `startOrReload`, and `cli/wait-ready.js` after); `nginx uses the http2 listen form and hides its version`; `the deploy workflow polls SSM instead of waiting 100 seconds` (`deploy.yml` has no `aws ssm wait`); `shell scripts keep LF line endings` (`.gitattributes` rule present; files contain no `\r`); `the process file loads` (`require('deploy/ecosystem.config.cjs')`).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/deploy-scripts.test.js` → FAIL.
- [ ] **Step 3: Implement** scripts, workflows, `.gitattributes`, and write `docs/ops/go-live.md` and the `infrastructure.md` updates.
- [ ] **Step 4: Run** `npm test && npm run test:tz && npm run lint && npm run build -w @vs/web && npm run e2e` → PASS (whole suite).
- [ ] **Step 5: Commit** `chore(deploy): migrate and wait for the release on deploy, CI e2e and the go-live runbook (M9 Task 13)`

---

## Not in M9 (later)

- Importing measurements, past expenses, past (closed) orders, past invoices or enquiries (Decision 2) — one adapter each if the owner asks.
- An "update existing records" import mode (Decision 3).
- GST credit for opening advances already taxed in the old system (Decision 12, pending the accountant).
- Staging environment (spec §1.1: after the trial), the Accountant role, WhatsApp/SMS adapters, Google Calendar.
- Remaining non-go-live minors from the M1–M5 ledgers (quiet hours on delivery retries, the outbox attempts cap, dev-only logo CORP, UI polish items) — a clean-up milestone.
