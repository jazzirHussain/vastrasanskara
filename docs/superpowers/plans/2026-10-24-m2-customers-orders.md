# M2 Customers and Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the M1 review findings, then let staff record customers and their measurements, take orders with garments and batches whose production stages are planned automatically, and manage those orders — in a web app with its own distinct visual identity instead of stock component styling.

**Architecture:** Same modular monolith as M1. New API modules `customers`, `measurements`, `orders` (orders + garments), each with `model.js` / `service.js` / `routes.js` (+ `jobs.js` when needed); modules call each other only through `service.js`. Stage back-scheduling is a pure function in `packages/shared` used by the API (and later by the web for previews). The web gets a small design system (tokens, fonts, icons, a handful of shared components including the signature `StageThread`) before the new screens are built on it.

**Tech Stack:** As M1, plus web: `@tabler/icons-react`, `@fontsource/figtree`, `@fontsource/young-serif`, `@mantine/dates` + `dayjs`, `@mantine/notifications`, `@mantine/dropzone` (all Mantine packages pinned to the installed `@mantine/core` 7.x minor).

**Spec:** `docs/superpowers/specs/2026-10-22-vastrasanskara-system-design.md` (sections 2.6, 3.1 settings, 3.2, 3.3, 4 "Stage planning" and "Pickup date changes", 5.7 covered fields, 10.2, 10.3, 12). M1 review findings: `.superpowers/sdd/2026-10-22-m1-foundation/progress.md` (lines starting `Final:`).

## Global Constraints

- Everything in the M1 plan's Global Constraints still applies (paise, UTC storage + IST business dates, `branchId` on every document, optimistic concurrency, strict zod, error shape, logging redaction, CORS/CSRF, sessions).
- Business dates without a time (`pickupDate`, `originalPickupDate`, `occasionDate`, garment `dueDate`, `plannedDate`) are stored as IST calendar strings `'YYYY-MM-DD'` and compared as strings; "today" is `istDate(clock.now())`.
- Layout rule (user directive): each module keeps `model.js`, `service.js`, `routes.js` (HTTP only, including response shapes) and `jobs.js` in its own folder; one module never reads another module's models.
- Designer scoping: a user without `orders.read.all` sees only orders whose `designerId` is theirs — enforced in the orders service, never only in the UI.
- Money stripping: responses to users without `money.view` contain no `agreedPrice`, `expectedBudget` or any other paise field (the key is absent, not null).
- Measurement values, phone numbers and emails are never logged.
- Order numbers: `<branch.prefixes.order>/<fy.code>/<4-digit seq>` (e.g. `VS/ORD/2627/0001`); garment numbers `<orderNo>-<2-digit index>` (e.g. `VS/ORD/2627/0001-02`); gapless per branch per financial year; `settings.numberSeries['order:<fyCode>']` sets the first number.
- `POST /v1/orders` requires an `Idempotency-Key` (a double tap must never create two orders).
- Web: fonts and icons are bundled (CloudFront CSP is `default-src 'self'`, so no font CDNs); every screen works at 390 px wide; visible keyboard focus; `prefers-reduced-motion` respected; sentence case everywhere; no ALL-CAPS labels.
- Commit subjects end with `(M2 Task N)`.

## Review Focus

1. **Two staff save new orders at the same moment** — both succeed with consecutive, distinct order numbers, no gap. → Task 9 test `concurrent orders get consecutive numbers`.
2. **Rush order: pickup in a few days, far less than the stage durations** — every stage still gets a planned date between the order date and the pickup date, the garment is flagged as a tight schedule, nothing is planned in the past. → Task 6 tests `compresses proportionally when the plan does not fit` and `pickup on the order date plans everything that day`.
3. **The same customer typed with a different phone format** (`+91 98765 43210` vs `9876543210`) — recognised as the existing customer, never a duplicate. → Task 7 test `same phone in another format is a duplicate`.
4. **A designer opens the orders list or an order** — sees only their own orders and no price or budget anywhere in the response. → Task 10 test `designer sees only own orders and no money fields`.
5. **An order taken at 23:59 IST on 31 March** — numbered in the financial year that is ending (`…/2627/…`), and one taken a minute later in the new year (`…/2728/0001`). → Task 9 test `order number follows the IST financial year`.

## Design direction (web)

The product is the working tool of a bespoke couture house (bridal wear, film costumes) used at the counter, at the cutting table and on the move. The look borrows from the workshop: dyed thread, tailor's chalk, pattern paper — not from SaaS dashboards.

| Token | Value | Use |
|---|---|---|
| `indigo` | `#2E336B` (shades 0–9 generated around it) | primary actions, sidebar, links |
| `ink` | `#1C1F3A` | body text, headings |
| `chalk` | `#F4F5F9` | app background (cool, not cream) |
| `kumkum` | `#B8324A` | late, rush, destructive, errors |
| `haldi` | `#C98A12` | tight schedule, on hold, warnings |
| `neem` | `#3C7A56` | ready, completed, success |

- **Type:** Figtree (UI and body, tabular figures for money, dates and numbers) and Young Serif (page titles and the order number on the order page only). Scale 13 / 15 / 18 / 24 / 32 px; body 15/1.55.
- **Shape:** radius 6 px on controls, 10 px on panels; one soft shadow for floating layers only (menus, drawers); panels separated by a 1 px `#DADCE8` rule, not shadows.
- **Signature element — `StageThread`:** the 14 production stages drawn as a running stitch (dashed SVG line) with a knot per stage: filled knots for stages done, an open ring for the current stage, empty for future ones; a kumkum knot when the current stage is past its planned date, haldi outline when the plan is tight. Compact (single line) in lists, expanded (labels and planned dates) on the order page. On the order page the thread draws once on load (300 ms stroke animation, skipped under reduced motion) — the only non-interactive motion in the app.
- **Layout:** desktop — a narrow indigo sidebar (icons + labels) and a content column max 1200 px, page header = title left, primary action right. Phone (< 768 px) — sidebar replaced by a bottom bar: Home, Orders, New order (raised centre button), Customers, More. Lists are tables on desktop and stacked rows on phones (same component). Dates show as "Fri 14 Nov" with "in 3 days" / "2 days late" beside them; money as `formatINR`.
- **Words:** actions name the outcome ("Save customer", "Take order", "Put on hold"); empty states say what to do next ("No orders yet. Take the first order."); errors say what happened and how to fix it.

## File Structure

```
packages/shared/src/
  planning.js                      planStages() — back-scheduling + compression (pure)
  schemas/settings.js              + garmentTypes
  schemas/customers.js  schemas/measurements.js  schemas/orders.js
apps/api/src/
  core/numbering.js                nextDocumentNumber() on top of counters
  core/pagination.js               cursor pagination helper
  core/notify/{models.js,catalog.js,service.js,routes.js,deliver.js,emit.js}   (Task 1 changes)
  core/idempotency.js              (Task 2 lease)
  modules/customers/{model.js,service.js,routes.js}
  modules/measurements/{model.js,service.js,routes.js}
  modules/orders/{model.js,service.js,lifecycle.js,garments.js,routes.js}
apps/web/src/
  theme.js  styles/fonts.js
  components/{PageHeader.jsx,EmptyState.jsx,StatusBadge.jsx,StageThread.jsx,Money.jsx,DateLabel.jsx,ResponsiveTable.jsx,LoadMore.jsx}
  layout/{AppLayout.jsx,Sidebar.jsx,BottomBar.jsx,navItems.js}
  features/customers/{CustomersPage.jsx,CustomerPage.jsx,CustomerForm.jsx,MeasurementForm.jsx,MeasurementHistory.jsx,customersApi.js}
  features/orders/{OrdersPage.jsx,OrderPage.jsx,NewOrderPage.jsx,new/{CustomerStep.jsx,GarmentsStep.jsx,DatesStep.jsx,ReviewStep.jsx},GarmentPanel.jsx,PlanEditor.jsx,OrderActions.jsx,ordersApi.js}
  features/settings/GarmentTypesTab.jsx
  features/home/HomePage.jsx       (upcoming pickups)
```

---

### Task 1: Close M1 review — reset links leak, invite email

**Files:**
- Modify: `apps/api/src/core/notify/catalog.js`, `emit.js`, `deliver.js`, `service.js`, `routes.js`; `apps/api/src/modules/users/passwordReset.js`
- Test: `apps/api/test/notify-secrets.test.js`, `apps/api/test/users.test.js`

**Interfaces:**
- Produces: `defineEvent(name, { …, secretVars = [] })` — names of `vars` that must never be stored after the message is final nor returned by any API. New event `auth.invite` (recipients `['user']`, channels `['email']`, `secretVars: ['resetUrl']`, email subject `Set up your Vastrasanskara account`, body inviting `{name}` to set a password via `{resetUrl}`, link valid `{expiresIn}`); `auth.password_reset` gets `secretVars: ['resetUrl']`. `issuePasswordLink(user, { purpose: 'invite' })` emits `auth.invite`. Admin outbox JSON is an explicit field list: `{ id, event, channel, recipient: { kind, id, name }, status, skipReason, attempts, lastError, scheduledFor, sentAt, deliveredAt, isFallback, createdAt }` (no `vars`, no address).

- [ ] **Step 1: Write the failing tests**

```js
// notify-secrets.test.js (uses useTestDb, loginAs, deliverDue, a fake email adapter)
test('admin outbox never returns vars or addresses', async () => {
  // emit auth.password_reset for a user; GET /v1/admin/outbox as admin
  expect(JSON.stringify(body)).not.toMatch(/token=|resetUrl|@/);
});
test('secret vars are removed once a message is final', async () => {
  // emit reset, deliverDue (fake email sends) → Outbox entry vars has no resetUrl, keeps name
});
test('a skipped message never stores secret vars', async () => {
  // user without email → entry skipped, vars.resetUrl undefined
});
// users.test.js
test('new users get an invite email, not a reset email', async () => {
  // POST /v1/users → Outbox event 'auth.invite', vars.expiresIn '3 days';
  // rendered subject (deliverDue + fake adapter) is 'Set up your Vastrasanskara account'
});
```

- [ ] **Step 2: Run** `npx vitest run apps/api/test/notify-secrets.test.js apps/api/test/users.test.js` → FAIL.
- [ ] **Step 3: Implement.** `emit` drops `secretVars` from `vars` when the entry is created as `skipped`; `deliverDue` `$unset`s `vars.<secret>` in the same update that sets `sent`/`delivered`/`failed`; the admin outbox route maps through the explicit field list. Update the users test helper `tokenFromOutbox` to read events `auth.password_reset` and `auth.invite`.
- [ ] **Step 4: Run** `npx vitest run apps/api` → PASS.
- [ ] **Step 5: Commit** `fix(api): keep reset links out of the outbox API and stored entries; invite email (M2 Task 1)`

---

### Task 2: Idempotency keys recover from a crashed request

**Files:**
- Modify: `apps/api/src/core/idempotency.js`
- Test: `apps/api/test/idempotency.test.js`

**Interfaces:**
- Produces: `in_progress` records carry `lockedAt`; a claim may take over an `in_progress` record whose `lockedAt` is older than `IDEMPOTENCY_LEASE_MS = 120000` (atomic `findOneAndUpdate` on `{ _id, state: 'in_progress', lockedAt: { $lt: now - lease } }`). Records also store `bodyHash` (sha256 of the canonical JSON body); same key with a different body → 422 `IDEMPOTENCY_KEY_REUSED`.

- [ ] **Step 1: Write the failing tests** — `stale in-progress key is taken over after the lease` (insert an `in_progress` record with `lockedAt` 3 minutes ago, request with that key → handler runs, 201); `fresh in-progress key still answers 409`; `same key with a different body is refused` (422).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/idempotency.test.js` → the three new tests FAIL.
- [ ] **Step 3: Implement** the lease and body hash in `idempotent()`; time from `clock.now()`.
- [ ] **Step 4: Run** → PASS (all idempotency tests, including the M1 ones).
- [ ] **Step 5: Commit** `fix(api): idempotency lease for crashed requests and body check (M2 Task 2)`

---

### Task 3: Deployment hardening — moved to go-live (M9)

Dropped from M2: deployment is set up once, at the end, when the whole app is built. The items are listed under "Not in M2". Task numbers are kept so commit subjects and the ledger stay aligned.

---

### Task 4: Shared — garment types and request schemas

**Files:**
- Modify: `packages/shared/src/schemas/settings.js`, `packages/shared/src/index.js`
- Create: `packages/shared/src/schemas/customers.js`, `measurements.js`, `orders.js`
- Test: `packages/shared/test/m2-schemas.test.js`

**Interfaces:**
- Produces:
  - Settings key `garmentTypes: Array<{ key: /^[a-z0-9_]{1,50}$/, label: string 1–60, measurementFields: string[] (labels, ≤ 40) }>`, keys unique. `DEFAULT_SETTINGS.garmentTypes`: `blouse` Blouse [Bust, Under bust, Waist, Shoulder, Armhole, Sleeve length, Sleeve round, Front neck depth, Back neck depth, Blouse length]; `lehenga` Lehenga [Waist, Hip, Length]; `kurta` Kurta [Chest, Waist, Hip, Shoulder, Sleeve length, Neck, Length]; `gown` Gown [Bust, Waist, Hip, Shoulder, Sleeve length, Length]; `sherwani` Sherwani [Chest, Waist, Hip, Shoulder, Sleeve length, Neck, Length]; `pants` Pants [Waist, Hip, Thigh, Knee, Ankle, Length]; `other` Other [].
  - `customerSchema` (create) / `customerPatchSchema`: `name` 1–100, `phone` (common), `email?` nullable, `type` enum `individual|business|film_production` (default `individual`), `gstin?` nullable, `stateCode` (default branch state is applied by the service when absent), `billingAddress { line1, line2, city, pincode }` (defaults ''), `source` enum `instagram|referral|walk_in|website|film_industry|other` (default `walk_in`), `consent { email: boolean, whatsapp: boolean, sms: boolean }` (defaults false), `consentNote` string ≤ 300 (required when any consent is true), `preferredChannel` enum `email|whatsapp|sms` nullable. GSTIN present → `stateCode` must equal its first two digits (zod refine, path `stateCode`).
  - `measurementSchema`: `{ garmentType: key, values: [{ name 1–40, value: number > 0 ≤ 500, unit: 'in'|'cm' }] (1–40, names unique), notes ≤ 500 }`.
  - `orderCreateSchema`: `{ customerId: objectId, designerId: objectId, priority: 'normal'|'rush' (default normal), expectedBudget: paise nullable, pickupDate: ymd, occasionDate: ymd nullable, notes ≤ 2000, garments: [{ type: key, description 1–500, fabric ≤ 300, designNotes ≤ 2000, agreedPrice: paise, quantity: int 1–200 (a batch when > 1), dueDate: ymd nullable, referenceKeys: string[] ≤ 10, measurementId: objectId nullable }] (1–50) }`. `ymd` = `/^\d{4}-\d{2}-\d{2}$/` that is a real date.

- [ ] **Step 1: Write the failing tests** — defaults parse; duplicate garment-type keys rejected; consent true without note rejected; GSTIN/state mismatch rejected on `stateCode`; `pickupDate: '2026-02-30'` rejected; garments empty rejected; quantity 0 rejected.
- [ ] **Step 2: Run** `npx vitest run --project shared` → FAIL.
- [ ] **Step 3: Implement** the schemas; export them from `index.js`.
- [ ] **Step 4: Run** → PASS (and `npm run test:tz`).
- [ ] **Step 5: Commit** `feat(shared): garment types and customer, measurement, order schemas (M2 Task 4)`

---

### Task 5: Settings page saves only what changed

**Files:**
- Modify: `apps/web/src/features/settings/SettingsPage.jsx`
- Test: `apps/web/src/features/settings/SettingsPage.test.jsx`

**Interfaces:**
- Produces: the settings Save sends only top-level keys whose value differs from the settings last loaded or saved (deep compare); nothing changed → no request and "No changes to save."

- [ ] **Step 1: Write the failing test** `saves only changed settings` — change Bill due days only → PUT body is exactly `{ billDueDays: 5 }`; Save with no change → no request.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.** (The server already merges partial updates.)
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(web): settings save sends only changed fields (M2 Task 5)`

---

### Task 6: Shared — stage planner

**Files:**
- Create: `packages/shared/src/planning.js`
- Test: `packages/shared/test/planning.test.js`

**Interfaces:**
- Consumes: `STAGES`, `addDaysYmd`, `allocateProRata` (integer allocation, reused for days).
- Produces: `WORK_STAGES` (the 11 stages from `materials_ready` to `packaging`); `durationsFor(settings, garmentType) → { [stageKey]: days }` (`stageDurations.default` overlaid with `byGarmentType[garmentType]`, missing = 0); `planStages({ orderDate: ymd, dueDate: ymd, durations }) → { stagePlan: Array<{ stage, plannedDate: ymd | null }>, tightSchedule: boolean }` — 14 entries in stage order; `order_taken` = orderDate; `ready_for_pickup` and `packaging` = dueDate; each earlier work stage = the next stage's date minus the next stage's duration (back-scheduled, slack at the start); `picked_up` = null. When the sum of work durations exceeds the days between orderDate and dueDate, the available days are split over the stages in proportion to their durations (largest remainder, ties to the earlier stage) and `tightSchedule` is true. `dueDate < orderDate` throws `RangeError`.

- [ ] **Step 1: Write the failing tests** (default durations: materials 2, pattern 1, handwork 7, QC 1, masters 1, tailors 4, trials 2, finishing 2, branding 1, final QC 1, packaging 1)

```js
test('back-schedules from the due date when the plan fits', () => {
  const { stagePlan, tightSchedule } = planStages({ orderDate: '2026-10-01', dueDate: '2026-11-15', durations: DEFAULTS });
  const at = Object.fromEntries(stagePlan.map((s) => [s.stage, s.plannedDate]));
  expect(tightSchedule).toBe(false);
  expect(at).toMatchObject({ order_taken: '2026-10-01', materials_ready: '2026-10-25', pattern_making: '2026-10-26', handwork: '2026-11-02',
    quality_check: '2026-11-03', masters_cutting: '2026-11-04', tailors: '2026-11-08', trials_fittings: '2026-11-10', finishing: '2026-11-12',
    branding: '2026-11-13', final_qc: '2026-11-14', packaging: '2026-11-15', ready_for_pickup: '2026-11-15', picked_up: null });
});
test('compresses proportionally when the plan does not fit', () => {
  const { stagePlan, tightSchedule } = planStages({ orderDate: '2026-10-01', dueDate: '2026-10-11', durations: DEFAULTS });
  const at = Object.fromEntries(stagePlan.map((s) => [s.stage, s.plannedDate]));
  expect(tightSchedule).toBe(true);
  expect(at).toMatchObject({ materials_ready: '2026-10-02', pattern_making: '2026-10-03', handwork: '2026-10-06', quality_check: '2026-10-07',
    masters_cutting: '2026-10-07', tailors: '2026-10-09', trials_fittings: '2026-10-10', finishing: '2026-10-11', packaging: '2026-10-11' });
  for (const s of stagePlan.filter((s) => s.plannedDate)) expect(s.plannedDate >= '2026-10-01' && s.plannedDate <= '2026-10-11').toBe(true);
});
test('pickup on the order date plans everything that day', () => { /* every non-null plannedDate === orderDate, tight */ });
test('garment-type overrides replace the default per stage', () => { /* durationsFor with byGarmentType.lehenga.handwork = 12 */ });
test('due date before order date throws', () => { expect(() => planStages({ orderDate: '2026-10-02', dueDate: '2026-10-01', durations: DEFAULTS })).toThrow(RangeError); });
```

- [ ] **Step 2: Run** `npx vitest run packages/shared/test/planning.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** `planning.js`; export from `index.js`.
- [ ] **Step 4: Run** `npx vitest run --project shared && npm run test:tz` → PASS.
- [ ] **Step 5: Commit** `feat(shared): stage back-scheduling and compression (M2 Task 6)`

---

### Task 7: Customers API

**Files:**
- Create: `apps/api/src/core/pagination.js`, `apps/api/src/modules/customers/{model.js,service.js,routes.js}`
- Modify: `apps/api/src/app.js`, `apps/api/src/core/notify/recipients.js` (register `client`)
- Test: `apps/api/test/customers.test.js`, `apps/api/test/pagination.test.js`

**Interfaces:**
- Consumes: `customerSchema`, `customerPatchSchema` (Task 4), `recordAudit`, `withTransaction`, `getBranch`.
- Produces:
  - `paginate(Model, filter, { sort: [field, 1|-1], limit = 25 (max 100), cursor }) → { items, nextCursor }` — cursor is base64url JSON `{ v, id }` of the last item; stable with ties via `_id`.
  - `Customer` model: fields from Task 4 plus `branchId`, `searchName` (lower-case name), common fields; unique index `{ branchId: 1, phone: 1 }`; index `{ branchId: 1, searchName: 1 }`.
  - Service: `createCustomer(branchId, input, actor)`, `updateCustomer(branchId, id, patch, actor)` (audited: `name`, `gstin`, `stateCode`, `billingAddress`, `consent`), `getCustomer(branchId, id)`, `findCustomers(branchId, { q, cursor, limit })` (q: digits → phone contains the digits; otherwise name prefix, case-insensitive), `getCustomerForNotification(customerId) → Recipient | null`.
  - Routes (`customers.read` for GET, `customers.write` for POST/PATCH): `GET /v1/customers?q=&cursor=`, `POST /v1/customers` → 201, `GET /v1/customers/:id`, `PATCH /v1/customers/:id`. Duplicate phone → 409 `PHONE_TAKEN` with `details: { customerId }`.
  - Recipient resolver `client`: `data.customerId` → `{ kind: 'client', id, name, addresses: { email, phone }, consent }`.

- [ ] **Step 1: Write the failing tests** — `creates a customer with the branch state by default`; `same phone in another format is a duplicate` (create `9876543210`, then `+91 98765 43210` → 409 `PHONE_TAKEN`, `details.customerId` = first id); `search by name prefix and by phone digits`; `pages through 30 customers with a cursor` (25 + 5, no repeats); `GSTIN change is audited`; `designers can read but not create` (403); `client recipient resolver uses consent` (emit an event for a client without email consent → `skipped no_consent`).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/customers.test.js apps/api/test/pagination.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api` → PASS.
- [ ] **Step 5: Commit** `feat(api): customers with phone dedupe, search and consent (M2 Task 7)`

---

### Task 8: Measurements API

**Files:**
- Create: `apps/api/src/modules/measurements/{model.js,service.js,routes.js}`
- Modify: `apps/api/src/app.js`
- Test: `apps/api/test/measurements.test.js`

**Interfaces:**
- Consumes: `measurementSchema` (Task 4), `getCustomer` (Task 7).
- Produces:
  - `Measurement` model — `branchId, customerId, garmentType, values [{ name, value, unit }], notes, takenBy, takenAt`; append-only (Mongoose update/delete hooks throw, as in the audit model); index `{ customerId: 1, garmentType: 1, takenAt: -1 }`.
  - Service: `recordMeasurement(branchId, customerId, input, actor)`, `listMeasurements(branchId, customerId) → newest first`, `latestMeasurements(branchId, customerId) → { [garmentType]: Measurement }`, `getMeasurement(branchId, id)`.
  - Routes: `GET /v1/customers/:id/measurements` (`customers.read`), `GET /v1/customers/:id/measurements/latest` (`customers.read`), `POST /v1/customers/:id/measurements` (`measurements.write`) → 201. Unknown garment type (not in `settings.garmentTypes`) → 400 `VALIDATION_FAILED` on `garmentType`.

- [ ] **Step 1: Write the failing tests** — `records a new set every time, never overwrites` (two POSTs → two documents; latest = second); `latest per garment type`; `designers can record measurements`; `unknown garment type is rejected`; `measurement values never reach the logs` (capture logger, POST, logs contain no value numbers or names).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/measurements.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(api): append-only measurements per garment type (M2 Task 8)`

---

### Task 9: Orders — model and taking an order

**Files:**
- Create: `apps/api/src/core/numbering.js`, `apps/api/src/modules/orders/{model.js,service.js,routes.js}`
- Modify: `apps/api/src/app.js`, `apps/api/src/core/files/purposes.js` (purpose `garment_reference`), `apps/api/src/modules/users/{service.js,routes.js}`
- Test: `apps/api/test/numbering.test.js`, `apps/api/test/orders-create.test.js`

**Interfaces:**
- Consumes: `nextSequence`, `financialYear`, `istDate`, `planStages`, `durationsFor` (Task 6), `orderCreateSchema` (Task 4), `getCustomer`, `getMeasurement`, `getSettings`, `getBranch`, `idempotent()`.
- Produces:
  - `nextDocumentNumber({ branchId, docType, now, start = 1 }, session) → { number, fy }` — counter `doc:<branchId>:<docType>:<fy.code>`; `number = start - 1 + seq`.
  - `Order` model: `branchId, orderNo (unique per branch), customerId, designerId, priority, expectedBudget, notes, orderDate, pickupDate, originalPickupDate, occasionDate, status ('active'|'on_hold'|'completed'|'cancelled'), holdHistory [{ from, to, reason, by }], cancellation { reason, furthestStage, refundPercent, at, by } | null` + common fields.
  - `Garment` model: `branchId, orderId, garmentNo (unique per branch), index, type, description, fabric, designNotes, quantity 1, agreedPrice, catalogItemId null, dueDate, originalDueDate, batchId, referenceKeys, measurementId, stagePlan [{ stage, plannedDate, originalPlannedDate, skipped false, skipReason null }], currentStage 'order_taken', stageState 'pending', status 'in_progress', alterationOpen false, tightSchedule, materials []` + common fields; indexes `{ orderId: 1, index: 1 }`, `{ branchId: 1, status: 1, dueDate: 1 }`.
  - `createOrder(branchId, input, actor) → { order, garments }` — one transaction: number from `nextDocumentNumber` with `start = settings.numberSeries['order:<fyCode>'] ?? 1`; a garment input with `quantity N` becomes N garments sharing a new `batchId` (`ObjectId`), numbered consecutively; each garment's plan = `planStages({ orderDate: today, dueDate: garment.dueDate ?? pickupDate, durations: durationsFor(settings, type) })`; `originalPickupDate = pickupDate`, `originalDueDate = dueDate`; audits `entityType 'order'`, action `create`. Rejects: unknown customer/designer/measurement → 400 `VALIDATION_FAILED`; designer without the `designer` role → 400; `pickupDate < today` → 422 `PICKUP_IN_PAST`; a garment `dueDate > pickupDate` → 422 `DUE_AFTER_PICKUP`.
  - Route `POST /v1/orders` (`orders.write`, `idempotent()`) → 201 `OrderDetail` (Task 10 serializer).
  - Users service additions: `listDesigners(branchId) → [{ id, name }]` (active users with role `designer`, by name) and `getUserNames(ids) → Map<id, name>`; route `GET /v1/designers` (`orders.write` or `orders.read.all`) → `{ items: [{ id, name }] }` (operations staff cannot use `/v1/users`, which needs `users.manage`).
  - File purpose `garment_reference` — write: `orders.write` or `production.update`; read: users who can read the owning order (`canReadGarmentFile(user, key)` from the orders service).

- [ ] **Step 1: Write the failing tests**

```js
test('order number follows the IST financial year', async () => {
  vi.spyOn(clock, 'now').mockReturnValue(new Date('2027-03-31T18:29:00Z')); // 23:59 IST
  expect((await take()).body.orderNo).toBe('VS/ORD/2627/0001');
  vi.spyOn(clock, 'now').mockReturnValue(new Date('2027-03-31T18:31:00Z')); // 00:01 IST, new FY
  expect((await take()).body.orderNo).toBe('VS/ORD/2728/0001');
});
test('concurrent orders get consecutive numbers', async () => { /* 5 parallel POSTs with distinct keys → 0001..0005 */ });
test('number series start from settings', async () => { /* numberSeries['order:2627'] = 101 → VS/ORD/2627/0101 */ });
test('a batch of 3 becomes 3 garments with one batchId and consecutive numbers', async () => { /* -01,-02,-03 */ });
test('each garment gets a stage plan from its due date and type', async () => { /* plan matches planStages for that type */ });
test('rush pickup marks the garment tight', async () => { /* pickup in 3 days → tightSchedule true */ });
test('double tap creates one order', async () => { /* same Idempotency-Key twice → same orderNo, one Order */ });
test('rejects pickup in the past, due after pickup, non-designer designer', async () => { /* 422, 422, 400 */ });
```

- [ ] **Step 2: Run** `npx vitest run apps/api/test/numbering.test.js apps/api/test/orders-create.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(api): take orders with numbered garments, batches and stage plans (M2 Task 9)`

---

### Task 10: Orders — reading, designer scoping, money stripping

**Files:**
- Modify: `apps/api/src/modules/orders/{service.js,routes.js}`
- Test: `apps/api/test/orders-read.test.js`

**Interfaces:**
- Consumes: `paginate` (Task 7).
- Produces:
  - `listOrders(branchId, user, { status, designerId, priority, pickupFrom, pickupTo, q, cursor, limit }) → { items, nextCursor }` — sorted by `pickupDate` then `_id`; `q` matches the order number suffix or the customer name prefix; designer scoping applied for users without `orders.read.all`.
  - `getOrder(branchId, user, orderId) → { order, garments, customer }` — 404 when out of scope.
  - Serializers in `routes.js`: `OrderSummary { id, orderNo, status, priority, pickupDate, originalPickupDate, customer: { id, name }, designer: { id, name }, garmentCount, tight: boolean, late: boolean, expectedBudget? }`; `OrderDetail { …OrderSummary, notes, occasionDate, orderDate, holdHistory, cancellation, garments: [{ id, garmentNo, type, description, fabric, designNotes, batchId, dueDate, originalDueDate, currentStage, stageState, status, tightSchedule, stagePlan, referenceKeys, measurementId, agreedPrice? }] }`. `late` = any garment whose current stage's plannedDate < today, or whose dueDate < today and status is not `ready`/`picked_up` (false while the order is `on_hold`). Money fields only with `money.view`.
  - Routes: `GET /v1/orders` (`orders.read.own`), `GET /v1/orders/:id` (`orders.read.own`).

- [ ] **Step 1: Write the failing tests** — `designer sees only own orders and no money fields` (two designers' orders; designer list/detail contains only theirs; `JSON.stringify(body)` has no `agreedPrice` / `expectedBudget` keys; another designer's order → 404); `operations sees all with money`; `filters by status, pickup range and search`; `late is suspended while on hold`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/orders-read.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(api): order list and detail with designer scoping and money stripping (M2 Task 10)`

---

### Task 11: Orders — dates, hold and cancellation

**Files:**
- Create: `apps/api/src/modules/orders/lifecycle.js`
- Modify: `apps/api/src/modules/orders/routes.js`
- Test: `apps/api/test/orders-lifecycle.test.js`

**Interfaces:**
- Consumes: `planStages`, `durationsFor`, `getSettings`, `recordAudit`, `stageIndex`.
- Produces (all audited, all optimistic-concurrency checked: the body carries `version`, mismatch → 409 `CONFLICT`):
  - `PATCH /v1/orders/:id { version, designerId?, priority?, expectedBudget?, notes?, occasionDate?, pickupDate? }` (`orders.write`) — a new `pickupDate` keeps `originalPickupDate`, and replans every garment without its own `dueDate` for stages after its current stage (`originalPlannedDate` kept); 422 `PICKUP_IN_PAST`.
  - `POST /v1/orders/:id/hold { version, reason }` → status `on_hold`, `holdHistory` gets `{ from: today, to: null, reason, by }`; `POST /v1/orders/:id/resume { version }` closes the open entry (`to: today`) → `active`. Only `active` → hold, only `on_hold` → resume; otherwise 422 `INVALID_STATUS`.
  - `POST /v1/orders/:id/cancel { version, reason }` (`orders.write`) — from `active` or `on_hold`; `furthestStage` = the latest `currentStage` across the order's garments; `refundPercent` = the `refundPercent` of the first `cancellationRefundSchedule` row (ordered by stage) whose `uptoStage` is at or after `furthestStage`, else 0; garments → status `cancelled`. (The refund amount is computed against payments in M4.)

- [ ] **Step 1: Write the failing tests** — `moving pickup keeps the original and replans`; `hold then resume records history`; `cannot hold a cancelled order` (422); `cancel uses the refund schedule` (schedule `[{ uptoStage: 'pattern_making', refundPercent: 80 }, { uptoStage: 'tailors', refundPercent: 40 }]`, garments at `order_taken` → 80); `stale version is a conflict` (409).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/orders-lifecycle.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(api): pickup changes, hold/resume and cancellation (M2 Task 11)`

---

### Task 12: Garments — edits, planned dates, more garments

**Files:**
- Create: `apps/api/src/modules/orders/garments.js`
- Modify: `apps/api/src/modules/orders/routes.js`
- Test: `apps/api/test/garments.test.js`

**Interfaces:**
- Produces (audited; `version` checked):
  - `PATCH /v1/garments/:id { version, description?, fabric?, designNotes?, agreedPrice?, dueDate?, referenceKeys?, measurementId? }` (`orders.write`; designers may change only `designNotes` and `referenceKeys` via `production.update`) — a new `dueDate` keeps `originalDueDate`, must be ≤ the order's pickup date, and replans like Task 11.
  - `PUT /v1/garments/:id/plan { version, changes: [{ stage, plannedDate }] }` (`production.update` or `orders.write`) — sets planned dates, keeps each `originalPlannedDate`, rejects a date before the order date or after the due date (422 `PLAN_OUT_OF_RANGE`) or out of stage order (422 `STAGE_ORDER_VIOLATION`); recalculates `tightSchedule` = false once the edited plan is in order and in range.
  - `POST /v1/orders/:id/garments { garments: [...same shape as order create] }` (`orders.write`, `idempotent()`) — appends garments with the next indexes; only for `active` / `on_hold` orders.

- [ ] **Step 1: Write the failing tests** — `due date change keeps the original and replans`; `designer can edit design notes but not price` (403 on `agreedPrice`); `planned date edits keep originals and reject out-of-order dates`; `adding garments continues the numbering` (`-03` after `-01`, `-02`).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/garments.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api` → PASS.
- [ ] **Step 5: Commit** `feat(api): garment edits, plan adjustments and added garments (M2 Task 12)`

---

### Task 13: Web design system and app shell

**Files:**
- Create: `apps/web/src/styles/fonts.js`, `apps/web/src/components/{PageHeader.jsx,EmptyState.jsx,StatusBadge.jsx,StageThread.jsx,Money.jsx,DateLabel.jsx,ResponsiveTable.jsx,LoadMore.jsx}`, `apps/web/src/layout/{Sidebar.jsx,BottomBar.jsx}`
- Modify: `apps/web/src/theme.js`, `apps/web/src/main.jsx`, `apps/web/src/layout/{AppLayout.jsx,navItems.js}`, `apps/web/src/auth/LoginPage.jsx`, `apps/web/src/features/users/UsersPage.jsx`, `apps/web/src/features/settings/SettingsPage.jsx`, `apps/web/package.json`
- Test: `apps/web/src/components/components.test.jsx`, `apps/web/src/layout/AppLayout.test.jsx`

**Interfaces:**
- Produces:
  - `theme.js`: the Design direction tokens as Mantine colors (`indigo`, `kumkum`, `haldi`, `neem` 10-shade tuples), `primaryColor: 'indigo'`, fonts Figtree / Young Serif, radius `sm` 6 / `md` 10, `fontSizes` 13/15/18/24/32, `other.chalk`, `other.rule`; `@mantine/notifications` mounted in `main.jsx`.
  - `<StageThread stagePlan currentStage status tight late variant="compact"|"full" />` — renders one knot per stage with `aria-label` `"<Stage label>: done|current|upcoming[, late]"`; `role="img"` and `aria-label="Stage N of 14: <current label>"` on the whole thread; `full` adds labels and planned dates and draws once on mount unless reduced motion.
  - `<Money paise />` (renders nothing when the value is absent — stripped by the server), `<DateLabel ymd />` ("Fri 14 Nov" + "in 3 days" / "today" / "2 days late"; IST-based), `<StatusBadge status />` (order and garment statuses, colours per tokens), `<PageHeader title action? />`, `<EmptyState title body action? />`, `<ResponsiveTable columns rows rowKey onRowClick />` (table ≥ 768 px, stacked rows below), `<LoadMore query />`.
  - Shell: `Sidebar` (desktop) and `BottomBar` (phone, with the raised New order button linking to `/orders/new`); `navItems` gains Orders `/orders` (`orders.read.own`), Customers `/customers` (`customers.read`), New order `/orders/new` (`orders.write`).
  - Restyle Login (split layout: brand panel with the stage thread motif on desktop, form only on phone), Users and Settings onto `PageHeader` / `ResponsiveTable`.

- [ ] **Step 1: Write the failing tests** — `StageThread marks done, current and late stages accessibly`; `Money renders nothing without a value`; `DateLabel says today, in 3 days and 2 days late` (fake clock); `phone width shows the bottom bar with New order for operations, not for designers` (`window.matchMedia` stub returns mobile).
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement**; install the new web dependencies.
- [ ] **Step 4: Run** `npx vitest run --project web && npm run build -w @vs/web && npm run lint` → PASS.
- [ ] **Step 5: Visual check** — run `npm run dev:db`, `dev:api`, `dev:web`; screenshot Login, Users and Settings at 390 × 844 and 1280 × 800 (browser tool); compare against the Design direction; fix anything that reads as stock Mantine (default blue, default radius, unstyled tables). Note the screenshots' findings in the commit body.
- [ ] **Step 6: Commit** `feat(web): design system, stage thread and new app shell (M2 Task 13)`

---

### Task 14: Web customers and measurements

**Files:**
- Create: `apps/web/src/features/customers/{CustomersPage.jsx,CustomerPage.jsx,CustomerForm.jsx,MeasurementForm.jsx,MeasurementHistory.jsx,customersApi.js}`, `apps/web/src/features/settings/GarmentTypesTab.jsx`
- Modify: `apps/web/src/App.jsx`, `apps/web/src/features/settings/{SettingsPage.jsx,ProductionTab.jsx}` (garment-type overrides pick from `garmentTypes`), `apps/web/src/test/server.js`
- Test: `apps/web/src/features/customers/customers.test.jsx`, `apps/web/src/features/settings/GarmentTypesTab.test.jsx`

**Interfaces:**
- Consumes: customer and measurement routes (Tasks 7–8), `customerSchema` for inline validation, `garmentTypes` from settings.
- Produces: `/customers` (search box, debounced 250 ms; `ResponsiveTable`; Add customer in a drawer), `/customers/:id` (details, consent with note, measurement history grouped by garment type, "Take measurements" drawer with the garment type's fields as number inputs and an in/cm switch, orders list placeholder until Task 16), Settings → Garment types tab (add, rename, edit measurement fields).

- [ ] **Step 1: Write the failing tests** — `adds a customer and opens their page`; `duplicate phone links to the existing customer` (409 `PHONE_TAKEN` → message "A customer with this phone already exists." with a link to them); `measurement form shows the garment type's fields and sends numbers`; `consent requires a note`; `garment types tab adds a type with fields`.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.** Add `PHONE_TAKEN` to `errorMessages`.
- [ ] **Step 4: Run** `npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Visual check** at 390 and 1280 px (customer list, customer page, measurement drawer).
- [ ] **Step 6: Commit** `feat(web): customers, measurements and garment types (M2 Task 14)`

---

### Task 15: Web — take an order

**Files:**
- Create: `apps/web/src/features/orders/{NewOrderPage.jsx,new/CustomerStep.jsx,new/GarmentsStep.jsx,new/DatesStep.jsx,new/ReviewStep.jsx,ordersApi.js}`
- Modify: `apps/web/src/App.jsx`, `apps/web/src/lib/errorMessages.js`
- Test: `apps/web/src/features/orders/NewOrderPage.test.jsx`

**Interfaces:**
- Consumes: `POST /v1/orders`, customers search, measurements latest, `GET /v1/designers` (Task 9), `planStages` + `durationsFor` from `@vs/shared` for the live plan preview, `uploadFile(file, 'garment_reference')`.
- Produces: `/orders/new` — a four-step flow (the content is a sequence, so the steps are numbered): 1 Customer (search or create inline; pick designer), 2 Garments (garment cards: type, description, fabric, price, quantity ("3 identical pieces" creates a batch), optional own due date, reference photos via dropzone, measurements pre-filled from the customer's latest set for that type with "Take new measurements"), 3 Dates (pickup and occasion dates; per garment a preview `StageThread` from `planStages`, tight plans called out in haldi with the stages that were compressed), 4 Review (summary, total of agreed prices, Take order). The `Idempotency-Key` is created once when the page opens and reused on every retry. On success → toast "Order VS/ORD/… taken" and navigate to the order page. Draft kept in `sessionStorage` until submitted.
- Error messages: `PICKUP_IN_PAST: 'Pickup date cannot be in the past.'`, `DUE_AFTER_PICKUP: 'A garment cannot be due after the pickup date.'`.

- [ ] **Step 1: Write the failing tests** — `takes an order with a batch and a tight plan` (walk the four steps; the request body has `garments[0].quantity` 3; the preview shows "Tight schedule"); `retrying after a network error reuses the idempotency key`; `measurements pre-fill from the latest set`; `designers cannot open new order` (no access message).
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Visual check** of all four steps at 390 and 1280 px.
- [ ] **Step 6: Commit** `feat(web): take-an-order flow with live stage plan preview (M2 Task 15)`

---

### Task 16: Web — orders list, order page, home pickups

**Files:**
- Create: `apps/web/src/features/orders/{OrdersPage.jsx,OrderPage.jsx,GarmentPanel.jsx,PlanEditor.jsx,OrderActions.jsx}`
- Modify: `apps/web/src/features/home/HomePage.jsx`, `apps/web/src/features/customers/CustomerPage.jsx` (orders list), `apps/web/src/App.jsx`
- Test: `apps/web/src/features/orders/orders.test.jsx`, `apps/web/src/features/home/HomePage.test.jsx`

**Interfaces:**
- Consumes: Tasks 10–12 routes; `StageThread`, `Money`, `DateLabel`, `StatusBadge`, `ResponsiveTable`, `LoadMore`.
- Produces:
  - `/orders` — filter chips (Active, On hold, Rush, Late, Pickup this week), search, list rows: order number, customer, designer, pickup `DateLabel`, compact `StageThread` of the least advanced garment, badges for rush / late / tight.
  - `/orders/:id` — header (order number in Young Serif, customer, status, pickup `DateLabel` with original date when moved); one `GarmentPanel` per garment with the full `StageThread`, details, reference photos and "Adjust plan" (`PlanEditor`: date inputs per stage, originals shown struck through when changed); `OrderActions`: Change pickup date, Put on hold / Resume, Cancel order (dialog shows the refund percent from settings), Add garment — each shown only with permission; a 409 shows "Someone else changed this order. Reload to see their changes." with a Reload button.
  - Home — "Upcoming pickups" (next 14 days, `GET /v1/orders?pickupFrom&pickupTo&status=active`) and "On hold" lists, greeting with the user's name; empty states with the next action.
- Error messages: `INVALID_STATUS: 'This order cannot be changed in its current status.'`, `PLAN_OUT_OF_RANGE: 'Planned dates must fall between the order date and the due date.'`, `STAGE_ORDER_VIOLATION: 'Planned dates must follow the stage order.'`.

- [ ] **Step 1: Write the failing tests** — `orders list filters and opens an order`; `designer sees no prices on the order page`; `moving the pickup date shows the original`; `cancel dialog shows the refund percent`; `conflict offers a reload`; `home shows upcoming pickups`.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build -w @vs/web` → PASS.
- [ ] **Step 5: Visual check** of orders list, an order with three garments (one tight, one late), home — at 390 and 1280 px; walk the whole flow once in the browser against `dev:api`: create customer → measurements → take order → change pickup → hold → resume.
- [ ] **Step 6: Commit** `feat(web): orders list, order page and upcoming pickups (M2 Task 16)`

---

## Not in M2 (later milestones)

- Stage events, vendors, workers, QC/rework/alteration, late digest and pickup-risk jobs (M3) — M2 garments stay at `order_taken`; `late` in M2 comes from planned dates only.
- "Order confirmed + advance paid" notification, advances and refunds as money (M4) — M2 records the refund percent only.
- Garment `materials[]` and catalog items (M4/M6) — fields exist, unused.
- Deferred M1 minors (ledger `Final: minor (deferred)` lines) other than those folded into Tasks 1–2.
- Deployment hardening (M9 go-live, from M1 review): wait for SSM commands past 100 s instead of `aws ssm wait`; single-quoted `.env` values in `remote-deploy.sh`; `.gitattributes` LF line endings; nginx `listen 443 ssl http2`; pm2-logrotate; CSP `frame-ancestors 'none'`; `s3:AbortMultipartUpload` on the backups bucket.
