# M3 Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move garments through production: designers record stage events (start, complete, skip, QC pass/fail with rework, vendor work, alteration, pickup, rejection), alone or in bulk; the house keeps its workers and vendors; late, at-risk, vendor-overdue and uncollected garments are detected and reported; the web gets stage actions, garment history, a production board and a workshop page.

**Architecture:** Same modular monolith. The production rules (which action is allowed in which state, and what state follows) are one pure module in `packages/shared/src/production.js`, used by the API to decide and by the web to offer only allowed actions. New API modules `workers`, `vendors` and `production` (`model.js` / `service.js` / `routes.js` / `jobs.js`). The garment documents stay owned by the `orders` module: production loads and saves them only through functions the orders module exports. `stageEvents` is append-only; each event and the garment's denormalised state are written in one transaction.

**Tech Stack:** As M2. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-vastrasanskara-system-design.md` — §3.1 (workers, vendors, `uncollectedFlagDays`, `dailyJobTime`), §3.3 garments (current state fields), §3.4, §4 (all), §8.1, §8.3 production rows, §8.4 daily jobs, §9.1 production board (data only; the dashboard itself is M8), §10.2, §10.3 uploads, §11 (`STAGE_ORDER_VIOLATION`, 409). M2 ledger rulings carried: `.superpowers/sdd/2026-10-24-m2-customers-orders/progress.md` lines 32 and 57 (late rule; server-side late filter).

## Global Constraints

- Everything in the M1 and M2 Global Constraints still applies (paise, UTC + IST business-date strings, `branchId`, optimistic concurrency with `version` in bodies and responses, strict zod, error shape, designer scoping in services, money stripping by key absence, no personal data in logs, bundled fonts/icons, 390 px screens, sentence case).
- Layout rule (user directive): each module keeps `model.js`, `service.js`, `routes.js`, `jobs.js` in its own folder; one module never reads another module's models — production touches garments and orders only through `apps/api/src/modules/orders/garments.js` / `service.js` exports.
- **Only designers and admin update production stages** (`production.update`). Two exceptions decided here: recording a pickup is also allowed with `orders.write` (the counter hands it over); rejecting a garment needs `orders.write` (the owner's decision, it changes what is billed).
- Stage order is fixed by `STAGE_KEYS`. Every action names the `stage` it acts on; if that is not the garment's working stage the request fails with 422 `STAGE_ORDER_VIOLATION`.
- "Working stage" = `currentStage`, except a garment still at `order_taken` works towards `materials_ready` (M2 ledger line 32 — Order taken is complete once the order exists).
- Late (spec §4, unchanged rule): the working stage is past its planned date (not skipped), or the garment's due date (`dueDate ?? order.pickupDate`) has passed and it is not ready; never late while the order is not `active` or the garment is `ready`/`picked_up`/`rejected`/`cancelled`.
- Nearly ready = working stage at or after `final_qc` (index ≥ `stageIndex('final_qc')`), or status `ready`/`picked_up`.
- `stageEvents` are never updated or deleted (model pre-hooks refuse, as `auditLog`).
- Charges for rework/alteration: an event may carry `chargeable` (boolean) and `chargeAmount` (paise or null). `chargeAmount` is accepted only from users with `money.view` (403 otherwise) and stripped from responses without it. Billing reads them in M4.
- Daily checks run when the IST clock has reached the branch's `settings.dailyJobTime`, at most once per branch per IST day per message (outbox `dedupeKey`).
- Commit subjects end with `(M3 Task N)`.

## Review Focus

1. **Two people act on the same garment at once** (double tap, two phones) — exactly one succeeds; the other gets 409 `CONFLICT`; exactly one stage event exists. → Task 3 test `a stale version is refused and records no event`.
2. **A bulk action where one selected garment is at a different stage or was changed meanwhile** — nothing changes for any of them, no events written. → Task 3 test `bulk is all or nothing`.
3. **An order on hold** — stage actions refused with 422 `INVALID_STATUS`, its garments never appear in the late digest, pickup-risk or the late filter. → Task 3 test `actions are refused while the order is on hold`; Task 7 test `held orders are left out of every check`.
4. **The worker restarts and re-runs the daily checks** (every 15 minutes, all day) — each digest reaches each person once per IST day, and nothing is sent before `dailyJobTime` IST. → Task 7 tests `re-running the checks queues nothing new` and `waits for the daily job time in IST`.
5. **A designer records a chargeable rework** — may flag it chargeable but cannot set an amount (403), and no response they receive contains `chargeAmount`. → Task 3 test `designers cannot price a rework and never see charges`.

---

## File Structure

```
packages/shared/src/
  production.js                 workingStage, nextStage, isGarmentLate, isNearlyReady,
                                allowedActions, applyStageAction, ProductionRuleError
  schemas/production.js         stageActionSchema
  schemas/workshop.js           workerSchema/workerPatchSchema, vendorSchema/vendorPatchSchema
  permissions.js                + WORKSHOP_MANAGE 'workshop.manage'
  index.js                      + exports
apps/api/src/
  modules/workers/{model.js,service.js,routes.js}
  modules/vendors/{model.js,service.js,routes.js}
  modules/production/{model.js,service.js,routes.js,notifications.js,daily.js,jobs.js}
  modules/orders/{model.js,garments.js,service.js,routes.js}   (production-facing exports, late filter)
  modules/branches/service.js   + listBranchIds() if missing
  core/files/purposes.js        + 'stage_photo'
  app.js, jobs.js               mount routers, register jobs
apps/web/src/
  features/workshop/{WorkshopPage.jsx,WorkersTab.jsx,VendorsTab.jsx,workshopApi.js}
  features/production/{ProductionPage.jsx,BulkBar.jsx,productionApi.js}
  features/orders/{StageActions.jsx,StageActionDialog.jsx,GarmentHistory.jsx}  + GarmentPanel/OrdersPage/orderStatus changes
  App.jsx, layout/navItems.js, lib/errorMessages.js, test/server.js, test/orders.js
```

---

### Task 1: Shared — production rules, schemas, permission

**Files:**
- Create: `packages/shared/src/production.js`, `packages/shared/src/schemas/production.js`, `packages/shared/src/schemas/workshop.js`
- Modify: `packages/shared/src/permissions.js`, `packages/shared/src/index.js`
- Test: `packages/shared/test/production.test.js`, `packages/shared/test/m3-schemas.test.js`, `packages/shared/test/permissions.test.js`

**Interfaces:**
- Produces (`production.js`), all pure, `garment` = `{ currentStage, stageState, status, alterationOpen, stagePlan, dueDate }`, `order` = `{ status, pickupDate }`:
  - `QC_STAGES = ['quality_check', 'final_qc']`; `ACTIONS` = the 11 spec actions `start, complete, skip, qc_pass, qc_fail, sent_to_vendor, returned_from_vendor, rework, alteration, rejected, picked_up`.
  - `workingStage(garment) → stageKey`.
  - `nextStage(garment, fromStage) → stageKey` — the first later stage whose plan entry is not `skipped` (`ready_for_pickup` is never skipped).
  - `isGarmentLate(garment, order, today) → boolean`, `isNearlyReady(garment) → boolean` (rules in Global Constraints).
  - `class ProductionRuleError extends Error { code }` — codes `STAGE_ORDER_VIOLATION`, `ACTION_NOT_ALLOWED`, `WITH_VENDOR`, `REWORK_TARGET_INVALID`.
  - `allowedActions(garment) → action[]` — what `applyStageAction` would accept for the garment's working stage (ignores order status and permissions).
  - `applyStageAction(garment, input, { today }) → { changes, event }`; `input` = parsed `stageActionSchema` minus `garments`; `changes` ⊆ `{ currentStage, stageState, status, alterationOpen, readyDate, vendorWork, skip: { stage, reason } }`; `event` = `{ stage, action, reworkStage?, vendorId?, dueBackDate? }`. Throws `ProductionRuleError`.
- Transition table (`W` = working stage; every action except `alteration`/`picked_up`/`rejected` needs status `in_progress`; while `stageState === 'with_vendor'` only `returned_from_vendor` is allowed → else `WITH_VENDOR`; `input.stage !== W` → `STAGE_ORDER_VIOLATION`, except for `alteration`, `picked_up`, `rejected` where `stage` must equal `currentStage`):

| action | allowed when | changes |
|---|---|---|
| `start` | stageState `pending`, W in WORK_STAGES | stageState `in_progress`, currentStage W |
| `complete` | W in WORK_STAGES and not a QC stage | → advance |
| `qc_pass` | W is a QC stage | → advance |
| `skip` | W in WORK_STAGES; `reason` required | `skip: { stage: W, reason }`, → advance |
| advance | — | currentStage `nextStage`, stageState `pending`; if that is `ready_for_pickup`: status `ready`, `readyDate: today` |
| `qc_fail` / `rework` | `qc_fail`: W is QC; `rework`: W in WORK_STAGES, also allowed when status `ready` (then W = `ready_for_pickup`); `reworkStage` in WORK_STAGES, before W, not skipped → else `REWORK_TARGET_INVALID` | currentStage `reworkStage`, stageState `pending`, status `in_progress`, `readyDate: null` |
| `sent_to_vendor` | stageState `pending`/`in_progress`; `dueBackDate ≥ today` (else `ACTION_NOT_ALLOWED`) | stageState `with_vendor`, currentStage W, `vendorWork: { vendorId, dueBackDate, sentOn: today }` |
| `returned_from_vendor` | stageState `with_vendor` | stageState `in_progress`, `vendorWork: null` |
| `alteration` | status `ready` or `picked_up`, or `in_progress` with W after `tailors` | currentStage `tailors`, stageState `pending`, status `in_progress`, `readyDate: null`, `alterationOpen: true` if it was `picked_up` |
| `picked_up` | status `ready` | currentStage `picked_up`, status `picked_up`, `alterationOpen: false` |
| `rejected` | status `in_progress` or `ready` | status `rejected` |

- Produces (`schemas/production.js`): `stageActionSchema` — strict object: `action` (enum ACTIONS), `stage` (stage key), `garments: [{ id: objectId, version: int ≥ 0 }]` 1–50 with unique ids, optional `workerIds` (objectId[] ≤ 10), `remarks` (trim ≤ 1000, default ''), `photoKeys` (string[] ≤ 10), `reason` (trim 1–300), `reworkStage`, `vendorId`, `dueBackDate` (ymd), `resolution` (`refund`|`remake`|`write_off`), `chargeable` (boolean, default false), `chargeAmount` (paise, nullable). A `superRefine` requires: `reason` for `skip` and `rejected`; `reworkStage` for `qc_fail`/`rework`; `vendorId` + `dueBackDate` for `sent_to_vendor`; `resolution` for `rejected`; `chargeable`/`chargeAmount` only on `qc_fail`, `rework`, `alteration`; `rejected` and `alteration` with exactly one garment.
- Produces (`schemas/workshop.js`): `workerSchema { name 1–100, skill ≤ 100 default '', phone (common `phone`) nullable default null, active default true }`; `vendorSchema { name 1–100, phone nullable default null, gstin nullable default null, stateCode optional, services string[] ≤ 20 (each 1–60) default [], active default true }` with the customer GSTIN/state rule; patch schemas = defaults-free `.partial()` refusing an empty patch (M2 Task 4 ruling pattern).
- Produces (`permissions.js`): `WORKSHOP_MANAGE: 'workshop.manage'` — admin and operations (not in `NOT_OPERATIONS`), not designers.

- [ ] **Step 1: Write the failing tests** in `production.test.js`: `a new garment works towards materials ready`; `complete advances past skipped stages`; `completing packaging makes the garment ready`; `complete is refused at a QC stage and qc_pass is refused elsewhere`; `acting on another stage is a stage order violation`; `qc_fail sends the garment back to the chosen earlier stage` (and `REWORK_TARGET_INVALID` for a later, the same, or a skipped stage); `only return is allowed while with a vendor`; `a vendor due-back date in the past is refused`; `alteration after pickup reopens with alterationOpen`; `alteration before trials is refused`; `pickup needs a ready garment and clears alterationOpen`; `allowedActions matches what applyStageAction accepts` (for every action × a fixture set of garment states, `allowedActions(g).includes(a)` iff `applyStageAction` with a valid input does not throw); `isGarmentLate keeps the M2 rule` (port the cases of `apps/web/src/features/orders/orderStatus.js` and the API `late is suspended while on hold`); `nearly ready from final QC on`. In `m3-schemas.test.js`: `skip needs a reason`, `sent_to_vendor needs vendor and due-back date`, `charges only on rework, QC fail and alteration`, `rejection acts on one garment`, `garments are unique and at most 50`, `vendor GSTIN fixes the state code`. In `permissions.test.js`: `workshop.manage for admin and operations only`.
- [ ] **Step 2: Run** `npx vitest run --project shared` → FAIL (modules missing).
- [ ] **Step 3: Implement** the three files and exports. Then switch `isGarmentLate` callers to the shared one: delete the copy in `apps/api/src/modules/orders/routes.js` (import from `@vs/shared/production.js`) and in `apps/web/src/features/orders/orderStatus.js` (re-export the shared one so web imports keep working).
- [ ] **Step 4: Run** `npx vitest run --project shared && npx vitest run apps/api/test/orders-read.test.js --project api && npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(shared): production stage rules, action and workshop schemas (M3 Task 1)`

---

### Task 2: API — workers and vendors

**Files:**
- Create: `apps/api/src/modules/workers/{model.js,service.js,routes.js}`, `apps/api/src/modules/vendors/{model.js,service.js,routes.js}`
- Modify: `apps/api/src/app.js`
- Test: `apps/api/test/workshop.test.js`

**Interfaces:**
- Consumes: `workerSchema`, `vendorSchema` + patches, `versioned`, `paginate` not needed (lists are small, sorted by name).
- Produces:
  - Models: `Worker { branchId, name, searchName, skill, phone, active }`, `Vendor { branchId, name, searchName, phone, gstin, stateCode, services[], active }`, both with `commonFields`, index `(branchId, searchName)`.
  - Services: `listWorkers(branchId, { active })`, `createWorker(branchId, input, actor)`, `updateWorker(branchId, id, { version, patch }, actor)` (404/409), `getWorkerNames(branchId, ids) → Map`, `areActiveWorkers(branchId, ids) → boolean`; vendors the same with `Vendor` names plus `isActiveVendor(branchId, id)`. Vendor `stateCode` defaults to the branch's (as customers). Vendor create/update writes an audit entry (GSTIN/state are tax fields); workers do not.
  - Routes: `GET /v1/workers`, `GET /v1/vendors` (`requireAnyPermission('workshop.manage', 'production.update')`, query `active=true|false` optional); `POST /`, `PATCH /:id` (`workshop.manage`). JSON: `{ id, name, skill, phone, active, version }` / `{ id, name, phone, gstin, stateCode, services, active, version }`.

- [ ] **Step 1: Write the failing tests** — `operations adds, edits and deactivates a worker`; `designers can list active workers and vendors but not change them` (403 on POST/PATCH); `a stale version is a conflict`; `vendor GSTIN must match the state code`; `vendor changes are audited`; `lists are per branch and sorted by name`; `phone numbers are not logged` (capture logger on a validation failure, as M2 Task 8).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/workshop.test.js` → FAIL.
- [ ] **Step 3: Implement** both modules; mount `/v1/workers` and `/v1/vendors` in `app.js`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(api): workers and vendors (M3 Task 2)`

---

### Task 3: API — stage events and the production action endpoint

**Files:**
- Create: `apps/api/src/modules/production/{model.js,service.js,routes.js}`
- Modify: `apps/api/src/modules/orders/{model.js,garments.js,routes.js}`, `apps/api/src/core/files/purposes.js`, `apps/api/src/app.js`
- Test: `apps/api/test/production-actions.test.js`

**Interfaces:**
- Consumes: `applyStageAction`, `ProductionRuleError`, `stageActionSchema` (Task 1); `areActiveWorkers`, `isActiveVendor`, `getWorkerNames`, `getVendorNames` (Task 2).
- Produces:
  - Garment model gains `vendorWork: { vendorId, dueBackDate, sentOn } | null` (default null), `readyDate: String | null`, `rejection: { resolution, reason, remakeGarmentId, at, by } | null`, `remakeOf: ObjectId | null`. `toGarmentJson` adds `vendorWork` (`{ vendorId, dueBackDate, sentOn }` or null), `readyDate`, `alterationOpen`, `rejection` (without `by`), `remakeOf`.
  - `orders/garments.js` exports for production:
    - `loadGarmentsForStageAction(branchId, user, refs, session) → [{ garment, order }]` (Mongoose documents) — every id must exist in the user's order scope (404), every version must match (409 `CONFLICT`), every order must be `active` (422 `INVALID_STATUS`), checked for all before any change.
    - `saveStageChange({ garment, order }, changes, actor, session)` — applies `changes` (a `skip` entry marks that `stagePlan` entry `skipped` + `skipReason`), increments and saves the garment.
  - `StageEvent` model (`stageEvents`): `branchId, orderId, garmentId, stage, action, workerIds[], vendorId, dueBackDate, reworkStage, reason, resolution, chargeable, chargeAmount, remarks, photoKeys[], by, at, bulkId` (ObjectId shared by one request's events, null when one garment); indexes `(garmentId, at)`, `(branchId, action, at)`, `(branchId, photoKeys)`; `pre` hooks refuse every update/delete/replace operation (copy the `auditLog` model's list).
  - `production/service.js`: `recordStageAction(branchId, user, input, actor) → garments (lean)` — rejects `chargeAmount` without `money.view` (403) before the transaction; checks `workerIds` (all active workers, else 400 on `workerIds`), `vendorId` (active vendor, else 400), `photoKeys` (start with `${branchId}/stage_photo/`, else 400); in one `withTransaction`: load, `applyStageAction` per garment (a `ProductionRuleError` → `businessRule(code, message)`), `saveStageChange`, insert one `StageEvent` per garment. Returns the saved garments. `listGarmentEvents(branchId, user, garmentId)` → events oldest first with `by`, worker and vendor names (404 out of scope). `canReadStagePhoto(user, key)`.
  - Route `POST /v1/production/actions` — permission `production.update`; for `picked_up` `requireAnyPermission('production.update', 'orders.write')`; for `rejected` `orders.write` (check inside the handler on the parsed `action`). Answers 200 `{ garments: [GarmentJson] }` (reuse `toGarmentJson` from `orders/routes.js`). `GET /v1/production/garments/:id/events` (`orders.read.own`) → `{ items: [{ id, stage, action, workerIds, workers: [{ id, name }], vendor: { id, name } | null, dueBackDate, reworkStage, reason, resolution, chargeable, chargeAmount?, remarks, photoKeys, by: { id, name }, at }] }`.
  - File purpose `stage_photo`: write with `production.update` or `orders.write`; read via `canReadStagePhoto` (an event carries the key and its garment is in the user's scope; an unattached key → `production.update` or `orders.write`, as `garment_reference`).
- This task covers `start`, `complete`, `skip`, `qc_pass`, `qc_fail`, `rework`, `sent_to_vendor`, `returned_from_vendor`. `alteration`, `picked_up`, `rejected` answer 422 `ACTION_NOT_ALLOWED` until Task 4 replaces that guard.

- [ ] **Step 1: Write the failing tests** — helper `world()` as in `orders-read.test.js` plus a worker and a vendor; `a designer starts and completes a stage with workers and a photo` (garment moves on, one `start` and one `complete` event with worker names in history); `skip records the reason on the plan`; `QC fail sends the garment back for rework`; `vendor work out and back` (`with_vendor`, `vendorWork` set then cleared); `completing packaging makes the garment ready with today's readyDate`; `operations cannot record stage actions` (403); `designers act only on their own orders' garments` (404); `acting on another stage is a stage order violation` (422 `STAGE_ORDER_VIOLATION`); `a stale version is refused and records no event` (two requests at the same version, `Promise.all` → one 200, one 409, `StageEvent.countDocuments() === 1`); `bulk is all or nothing` (three garments of a batch, one already advanced → 422, none changed, no events; all at the same stage → three events sharing a `bulkId`); `actions are refused while the order is on hold` (422 `INVALID_STATUS`); `inactive workers and unknown vendors are refused`; `designers cannot price a rework and never see charges` (designer `chargeAmount` → 403; admin sets 50000 on a `qc_fail`; the designer's history has no `chargeAmount` key, admin's does); `stage events cannot be changed` (`StageEvent.updateOne` and `deleteOne` throw); `stage photos are readable only within scope`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/production-actions.test.js` → FAIL.
- [ ] **Step 3: Implement** the model fields, orders exports, production model/service/routes, file purpose; mount `/v1/production` in `app.js`.
- [ ] **Step 4: Run** `npx vitest run apps/api/test/production-actions.test.js apps/api/test/orders-read.test.js apps/api/test/garments.test.js apps/api/test/files.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): stage events with QC rework, vendor work and bulk actions (M3 Task 3)`

---

### Task 4: API — alteration, pickup, rejection and order completion

**Files:**
- Modify: `apps/api/src/modules/production/service.js`, `apps/api/src/modules/orders/{garments.js,lifecycle.js}`
- Test: `apps/api/test/production-finish.test.js`

**Interfaces:**
- Consumes: Task 3 service and orders exports.
- Produces:
  - `orders/garments.js`: `remakeGarment({ garment, order }, actor, session) → garmentDoc` — a new garment on the same order, next index/number, copying `type, description, fabric, designNotes, agreedPrice, catalogItemId, referenceKeys, measurementId, dueDate`, `remakeOf` = the rejected garment, stage plan from today to its due date (`stagePlanFor`); audited as order `add_garments`.
  - `orders/lifecycle.js`: `settleOrderAfterStageChange(order, actor, session)` — every garment `picked_up`/`rejected`/`cancelled` and at least one `picked_up` → order `completed` (audited `complete`); an `alteration` on a `completed` order's picked-up garment sets it back to `active` (audited `reopen`).
  - `loadGarmentsForStageAction` accepts a `completed` order only for `alteration` (pass the action).
  - `rejected`: sets `garment.rejection = { resolution, reason, remakeGarmentId, at, by }`, audits the garment (`reject`, before/after status and resolution); `resolution: 'remake'` calls `remakeGarment` in the same transaction. Rejected garments are never charged — billing (M4) excludes `status: 'rejected'`.
  - The Task 3 `ACTION_NOT_ALLOWED` guard for these three actions is removed.

- [ ] **Step 1: Write the failing tests** — `a garment goes from order taken to picked up` (walk every stage with `complete`/`qc_pass`/`start`, then `picked_up`; event actions in order; order becomes `completed`); `alteration at trials returns the garment to tailors`; `alteration after pickup reopens the garment and the order` (`alterationOpen: true`, order `active`; picking up again clears it and completes the order); `operations can record a pickup but not a stage`; `rejecting needs orders.write and a resolution`; `remake adds a new garment linked to the rejected one` (new garment number, `remakeOf`, plan due on the old due date, rejection audited); `refund and write-off leave no new garment`; `a rejected garment does not hold the order open` (other garment picked up → order completed).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/production-finish.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/production-finish.test.js apps/api/test/production-actions.test.js apps/api/test/orders-lifecycle.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): alterations, pickup, rejection with remake, and order completion (M3 Task 4)`

---

### Task 5: API — production notifications

**Files:**
- Create: `apps/api/src/modules/production/notifications.js`
- Modify: `apps/api/src/modules/production/service.js`
- Test: `apps/api/test/production-notify.test.js`

**Interfaces:**
- Consumes: `defineEvent`, `registerRecipientResolver`, `emit` (core/notify), `userRecipient` (core/notify/recipients.js).
- Produces (`notifications.js`, imported by `production/service.js` so API and worker both load it):
  - Recipient role `designer`: `data.designerId` → that active user (else none).
  - Events (channels `['in_app', 'email']` for staff, `['email']` for client; every in-app template passes `{link}` = `/orders/<orderId>` or `/production`):

| event | recipients | when |
|---|---|---|
| `garment.fitting_reached` | designer, owner | an action makes `trials_fittings` the working stage |
| `qc.failed` | designer, owner | `qc_fail` |
| `garment.ready_for_pickup` | client | status becomes `ready` |
| `stage.late_digest` | designer | Task 7 |
| `pickup.at_risk` | owner, designer | Task 7 |
| `vendor.overdue` | designer, operations | Task 7 |
| `garment.uncollected` | operations | Task 7 |

  - Template vars: immediate events `{garmentNo}`, `{description}`, `{customerName}`, `{orderNo}`, `{link}`, plus `{stage}` (label) for `qc.failed` and `{remarks}`; client `garment.ready_for_pickup` email: subject `Your garment is ready for pickup`, body names `{customerName}`, `{description}`, `{orderNo}` and no prices. Digests: `{count}`, `{list}` (one line per garment: `<garmentNo> <description> — <stage label>, <detail>`), `{link}`.
  - `recordStageAction` emits inside its transaction with `refId` = the stage event's id (so a later return to the same stage notifies again) and `data: { designerId: order.designerId, customerId: order.customerId }`; customer name via `getCustomerNames`.

- [ ] **Step 1: Write the failing tests** — `reaching trials notifies the designer and owner`; `QC fail notifies the designer and owner with the remarks`; `a ready garment emails a consenting client and skips one without consent` (outbox `skipped` / `no_consent`); `a failed action queues nothing` (409 → zero outbox rows); `the client message contains no price`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/production-notify.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/production-notify.test.js apps/api/test/notify-emit.test.js apps/api/test/notify-routes.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): fitting, QC failure and ready-for-pickup notifications (M3 Task 5)`

---

### Task 6: API — production board, garment list and the server-side late filter

**Files:**
- Modify: `apps/api/src/modules/orders/{service.js,routes.js}`, `apps/api/src/modules/production/{service.js,routes.js}`
- Test: `apps/api/test/production-board.test.js`, `apps/api/test/orders-read.test.js`

**Interfaces:**
- Consumes: `isGarmentLate`, `workingStage`, `isNearlyReady` (Task 1).
- Produces:
  - `orders/service.js`: `listOpenGarments(branchId, user, { designerId } = {}) → [{ garment, order, customerName, designerName }]` — garments with status `in_progress` or `ready` of `active` orders in the user's scope, lean, capped at 1000 (log a warning when reached). `listOrders` gains `late: boolean` — when true, restricts to active orders in scope having a late garment today.
  - `GET /v1/orders` query gains `late=true`.
  - `production/service.js`: `productionBoard(branchId, user) → { stages: [{ stage, inHouse, withVendor, late }] }` over `listOpenGarments` (stage = working stage; `ready` garments count under `ready_for_pickup`); `listProductionGarments(branchId, user, { stage, late, withVendor, vendorId, designerId }) → items` sorted by due date then garment number.
  - Routes (`orders.read.own`): `GET /v1/production/board`; `GET /v1/production/garments` → `{ items: [{ garment: GarmentJson, order: { id, orderNo, pickupDate, priority }, customer: { id, name }, designer: { id, name }, workingStage, late, nearlyReady, vendor: { id, name } | null }], truncated }`.

- [ ] **Step 1: Write the failing tests** — `board counts garments per working stage, in house and with vendors`; `designers see only their own garments on the board`; `garment list filters by stage, late, vendor and designer`; `ready garments wait under ready for pickup`; `held orders are left off the board`; in `orders-read.test.js`: `late filter returns only orders with a late garment` (three orders, one late, one held with a late garment → only the first).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/production-board.test.js apps/api/test/orders-read.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(api): production board, garment list and server-side late filter (M3 Task 6)`

---

### Task 7: API — daily production checks

**Files:**
- Create: `apps/api/src/modules/production/{daily.js,jobs.js}`
- Modify: `apps/api/src/jobs.js`, `apps/api/src/modules/branches/service.js` (only if `listBranchIds` is missing)
- Test: `apps/api/test/production-daily.test.js`

**Interfaces:**
- Consumes: `listOpenGarments` (Task 6), events and `designer` resolver (Task 5), `readSettings`, `emit`, `istDate`, `istTime`, `addDaysYmd`.
- Produces:
  - `runDailyProductionChecks({ now = clock.now() } = {}) → { branches, queued }` in `daily.js`: for each branch whose `istTime(now) ≥ settings.dailyJobTime`, with `day = istDate(now)`:
    - `stage.late_digest` — one per designer with late garments; `refId` `<designerId>:<day>`; detail = `planned <plannedDate>` or `due <dueDate>`.
    - `pickup.at_risk` — one per order with a garment due within `day … day+3` that is not nearly ready; `refId` `<orderId>:<day>`.
    - `vendor.overdue` — garments `with_vendor` whose `vendorWork.dueBackDate < day`, one per designer; `refId` `<designerId>:<day>`; detail = vendor name and due-back date.
    - `garment.uncollected` — garments `ready` with `readyDate ≤ day − uncollectedFlagDays`, one per branch; `refId` `uncollected:<day>`.
  - Each `emit` runs in its own short transaction (`withTransaction`).
  - `jobs.js`: `defineJob('production-daily', { schedule: '*/15 * * * *', handler: () => runDailyProductionChecks() })`; `src/jobs.js` imports it.

- [ ] **Step 1: Write the failing tests** (`vi.spyOn(clock, 'now')`) — `late garments reach their designer in one morning digest`; `pickup in three days not nearly ready alerts owner and designer` (a garment at `final_qc` is not reported); `vendor past due-back date is reported`; `ready garments uncollected past the flag days are reported`; `waits for the daily job time in IST` (07:59 IST → nothing; 08:00 IST → queued; `dailyJobTime` 09:30 respected); `re-running the checks queues nothing new` (second run same day → `queued === 0`; next day → new digests); `held orders are left out of every check`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/production-daily.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/production-daily.test.js apps/api/test/jobs.test.js apps/api/test/worker-log.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): daily late digest, pickup risk, vendor overdue and uncollected checks (M3 Task 7)`

---

### Task 8: Web — workshop page (workers and vendors)

**Files:**
- Create: `apps/web/src/features/workshop/{WorkshopPage.jsx,WorkersTab.jsx,VendorsTab.jsx,workshopApi.js}`
- Modify: `apps/web/src/App.jsx`, `apps/web/src/layout/navItems.js`, `apps/web/src/test/server.js`
- Test: `apps/web/src/features/workshop/workshop.test.jsx`

**Interfaces:**
- Consumes: Task 2 routes; `workerSchema`/`vendorSchema` for inline validation; `ResponsiveTable`, `PageHeader`, `EmptyState`.
- Produces: `/workshop` behind `workshop.manage` (nav item "Workshop", `IconTool`, phone `more`) with tabs Workers and Vendors: list (name, skill/services, phone, Active/Inactive badge), "Add worker"/"Add vendor" drawer, edit drawer sending only changed fields with `version`, Active switch; 409 → reload banner. `workshopApi.js` exports `useWorkers({ active })`, `useVendors({ active })` (also used by Tasks 9–10), `useSaveWorker`, `useSaveVendor`.

- [ ] **Step 1: Write the failing tests** — `adds a worker`; `edits a vendor sending only what changed`; `deactivating keeps the vendor in the list as inactive`; `designers do not see Workshop in the menu`.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(web): workshop page for workers and vendors (M3 Task 8)`

---

### Task 9: Web — stage actions and garment history on the order page

**Files:**
- Create: `apps/web/src/features/orders/{StageActions.jsx,StageActionDialog.jsx,GarmentHistory.jsx}`
- Modify: `apps/web/src/features/orders/{GarmentPanel.jsx,ordersApi.js}`, `apps/web/src/lib/errorMessages.js`, `apps/web/src/test/{server.js,orders.js}`
- Test: `apps/web/src/features/orders/stageActions.test.jsx`

**Interfaces:**
- Consumes: `allowedActions`, `workingStage`, `STAGES` (Task 1); `POST /v1/production/actions`, `GET /v1/production/garments/:id/events` (Tasks 3–4); `useWorkers`, `useVendors` (Task 8); `upload.js` with purpose `stage_photo`.
- Produces:
  - `StageActions({ order, garment })` — shown on an active order (and on a completed one for a picked-up garment's alteration) to users with `production.update` (pickup also `orders.write`, reject only `orders.write`); one primary button for the natural next step (`complete`/`qc_pass` → "Mark <stage> done", `returned_from_vendor` → "Back from vendor", `picked_up` → "Hand over to client") and a "More" menu with the other allowed actions, labelled: Start <stage>, Skip <stage>, QC failed, Send to vendor, Rework, Alteration, Client rejected.
  - `StageActionDialog({ action, order, garments, onClose })` — the fields the action needs: workers (multi-select of active workers), remarks, photos, reason (skip/reject), rework stage (Select of earlier, unskipped work stages), vendor + due-back date (native date input), resolution (refund/remake/write-off, radio), "Charge the client" switch + amount (amount only with `money.view`). Sends `{ action, stage: workingStage(g), garments: [{ id, version }], … }`. Used by Task 10 for bulk too (`garments` may be several).
  - `useStageAction()` in `ordersApi.js` — on success invalidates `['orders']` and `['production']`.
  - `GarmentHistory({ garmentId })` — collapsed "History" under each garment: events newest first ("Pattern making done · Ravi, Sita · Meera · Fri 14 Nov 10:42", rework target, vendor and due back, remarks, photo links).
  - `errorMessages`: `STAGE_ORDER_VIOLATION` (shared by the plan editor and stage actions) becomes 'This does not follow the stage order. Reload and try again.'; add `ACTION_NOT_ALLOWED` 'That step is not possible for this garment right now.', `WITH_VENDOR` 'This garment is with a vendor. Record it as back first.', `REWORK_TARGET_INVALID` 'Choose an earlier stage that was not skipped.'.

- [ ] **Step 1: Write the failing tests** — `designer marks the current stage done with workers`; `QC failed asks for the stage to rework`; `send to vendor needs a vendor and a due-back date`; `operations sees hand over for a ready garment but no stage buttons`; `designers cannot enter a charge amount`; `a conflict offers reload`; `history lists events newest first`.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.** The `StageThread` already reads `currentStage`/`status`; check it shows `with_vendor` (add a small "With vendor" `StatusBadge` beside the garment when `stageState === 'with_vendor'`).
- [ ] **Step 4: Run** `npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Visual check** at 390 and 1280 px (order page with actions, dialog, history) using the M2 workspace harness (`.superpowers/sdd/2026-10-24-m2-customers-orders/visual.mjs`, `seed.mjs`) copied into this plan's workspace.
- [ ] **Step 6: Commit** `feat(web): stage actions and garment history on the order page (M3 Task 9)`

---

### Task 10: Web — production board with bulk actions, server-side late filter

**Files:**
- Create: `apps/web/src/features/production/{ProductionPage.jsx,BulkBar.jsx,productionApi.js}`
- Modify: `apps/web/src/App.jsx`, `apps/web/src/layout/navItems.js`, `apps/web/src/features/orders/OrdersPage.jsx`, `apps/web/src/test/server.js`
- Test: `apps/web/src/features/production/production.test.jsx`, `apps/web/src/features/orders/orders.test.jsx`

**Interfaces:**
- Consumes: Task 6 routes; `StageActionDialog` (Task 9); `allowedActions`, `STAGES`.
- Produces:
  - `/production` behind `orders.read.own`; nav item "Production" (`IconLayoutKanban`, phone `bar`, placed after Orders).
  - Board strip: one chip per stage with its count (with-vendor count and a kumkum late count beside it); tapping a chip filters the list; filter chips All / Late / With vendor.
  - Garment rows (`ResponsiveTable`): checkbox (only with `production.update`), garment number + description, customer, designer, working stage, due `DateLabel`, Late/Tight/With vendor badges, link to the order.
  - `BulkBar` — appears when garments are selected; offers only actions allowed for every selected garment **and** only when all share one working stage (otherwise says "Pick garments at the same stage"); opens `StageActionDialog` with all of them.
  - `OrdersPage` Late chip queries `{ status: 'active', late: true }` from the server and drops the client-side `keep` filter (closes M2 ledger line 57).

- [ ] **Step 1: Write the failing tests** — `board counts filter the garment list`; `bulk complete sends every selected garment once`; `bulk offers nothing for garments at different stages`; `operations sees the board without checkboxes`; in `orders.test.jsx`: `late filter asks the server` (MSW asserts `late=true` in the query).
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS (whole suite).
- [ ] **Step 5: Visual check** at 390 and 1280 px (production page, bulk bar, bottom bar with Production).
- [ ] **Step 6: Commit** `feat(web): production board with bulk stage actions and server late filter (M3 Task 10)`

---

## Not in M3 (later milestones)

- Extra-charge bill lines from chargeable rework/alteration, refunds for rejected garments, excluding rejected garments from bills (M4 billing reads `stageEvents.chargeAmount` and `garment.status`).
- On-time rate figures and the dashboard tiles (M8) — M3 stores what they need (`readyDate`, `originalDueDate`, `stageEvents`).
- Stock consumption on garments (M6), appointments/fittings calendar (M7).
- WhatsApp/SMS adapters (designed for; not shipped per spec §1.2).
- Deferred M1/M2 minors not named above; deployment hardening (M9).
