# Vastrasanskara Business System — Technical Design

- **Date:** 2026-10-22
- **Status:** Draft for review
- **Requirements source:** `Vastrasanskara Business System – Proposal.pdf` (2026-10-11), plus decisions made during design review (recorded below)

---

## 1. Purpose and intent

One web system that runs the boutique day to day: enquiries, appointments, customers, orders, per-garment production tracking, stock, billing, expenses and a dashboard that shows the whole business on one screen. Data is entered once; the dashboard and reports derive from it.

Billing is also the accountant's tool for GST filing, so billing records must be sequential, immutable once issued, fully audited and exportable as GST-ready reports.

**Success looks like:**
- Staff run the boutique from the system on phone, tablet or laptop and retire the paper order form after a one-week parallel run.
- The owner sees late garments, pickup risks and money owed before they become problems.
- The admin can file GSTR-1 and GSTR-3B from the system's monthly reports without re-keying data.
- Any change to a billing or expense record can be traced to who, when, and what changed, and tampering is detectable.

### 1.1 What was stated vs assumed

| Stated by the developer / client | Assumed in this design (correct if wrong) |
|---|---|
| Deliver one complete product; phases are internal build order only | Developer builds and maintains the system alone |
| JavaScript on frontend and backend | Node.js + Express backend, React + Vite frontend |
| AWS: CloudFront (React), EC2 (backend); MongoDB | MongoDB Atlas M0 hosted on AWS ap-south-1 |
| Production environment only; staging planned after trial | Annual turnover below ₹5 crore, so no e-invoicing |
| Regular GST, mostly B2C with some B2B (GSTIN) customers | Section 9 client questions are still open → modelled as settings |
| Billing like Zoho/BillBook but lean; used by accountant; frequent reports | Admin performs the accountant's tasks for now |
| Expense module = expense log with optional link to a garment | Custom domain for both `app.` and `api.` subdomains |
| Garment cost = materials used + linked expenses | |
| Notifications must allow adding WhatsApp or any third-party provider | |
| No ALB; small downtime acceptable; M0 (free) Atlas tier | |
| Client and API on separate subdomains of one domain; no TOTP for now | |

### 1.2 Scope changes from the proposal

- **Added:** expense module; Zoho-style billing (catalog, number series, credit notes, vouchers, ledger, period locks); GST-grade audit trail; accountant reports; per-garment and per-order costing and margin; channel-agnostic notifications.
- **Unchanged exclusions (proposal §8):** marketing tracking, Instagram tracking, vendor payables and tailor wages as a payables module (vendor work is still recordable as an expense), online payment links, WhatsApp (designed for, not shipped), home delivery, offcut/wastage tracking, accounting software export, GST return filing itself, GSTR-2B reconciliation.

---

## 2. Architecture

### 2.1 Shape

A **modular monolith** in one repository, run as two processes:

- **api** — Express HTTP server.
- **worker** — scheduled and background jobs (Agenda, MongoDB-backed): reminders, late/overdue checks, notification delivery, PDF rendering, backups.

Rejected alternatives: a separate billing service (deployment and cross-service consistency overhead for one developer), and an event-sourced billing ledger (harder to build and report from in plain JS + MongoDB; transactional hash-chained audit gives equivalent guarantees).

### 2.2 Repository layout (npm workspaces)

```
apps/
  web/                React + Vite (JavaScript)
    src/features/<module>/   pages, components, hooks per module
    src/lib/                 api client, auth, formatting
  api/
    src/server.js            api entry
    src/worker.js            worker entry
    src/core/                db, transactions, audit, events, notify, auth, permissions, errors, jobs, files, pdf
    src/modules/<module>/    model.js, service.js, routes.js, (policies.js)
packages/
  shared/             used by web and api
    src/schemas/      zod schemas for every request body
    src/stages.js     ordered production stage list
    src/gst.js        tax calculation, slab selection, place-of-supply logic
    src/money.js      paise arithmetic, rounding, amount-in-words
    src/fy.js         financial year and IST date helpers
    src/permissions.js permission names and role map
```

**Module boundaries:** modules are `customers`, `orders` (orders + garments + measurements), `production`, `catalog`, `billing`, `expenses`, `stock`, `enquiries`, `appointments`, `notifications`, `reports`, `dashboard`, `settings`, `users`. A module accesses another module only through its `service.js`, never its models. Every service function that writes takes an optional MongoDB session so callers can compose writes into one transaction.

### 2.3 Technology

| Concern | Choice |
|---|---|
| Frontend | React, Vite, React Router, TanStack Query, Mantine (mobile-friendly components) |
| Backend | Node 22 LTS, Express, Mongoose, zod, pino logging, helmet |
| Jobs | Agenda (MongoDB-backed) in the worker process |
| PDFs | pdfmake (pure JS, low memory) |
| Excel | exceljs |
| Database | MongoDB Atlas M0, AWS ap-south-1 (replica set → transactions supported) |
| Files | S3 (private), presigned URLs |
| Email | Amazon SES |
| Secrets | SSM Parameter Store |
| Logs/alarms | CloudWatch agent + alarms |
| CI/CD | GitHub Actions |

### 2.4 Deployment (production only)

```
Browser ── https://app.<domain> ──> CloudFront ──> S3 (React build, private, OAC)
        └─ https://api.<domain> ──> Elastic IP ──> EC2 t4g.small
                                                   nginx (TLS, Let's Encrypt) → pm2: api, worker
                                                   │
                                                   ├─> MongoDB Atlas M0 (ap-south-1), IP access list = Elastic IP
                                                   ├─> S3: files bucket (photos, attachments, locked PDFs)
                                                   ├─> S3: backups bucket (Object Lock, lifecycle → Glacier, 8 years)
                                                   └─> SES, SSM, CloudWatch (via instance IAM role)
```

- **EC2:** t4g.small (2 vCPU, 2 GB, Graviton/arm64), Amazon Linux 2023, 30 GB gp3. Upgrade to t4g.medium only if needed (e.g. switching to HTML-rendered PDFs).
- **Security group:** 443 open; 80 open only for the Let's Encrypt HTTP challenge and redirect. No SSH; shell access via SSM Session Manager.
- **Resilience:** CloudWatch EC2 auto-recovery alarm; daily EBS snapshots via Data Lifecycle Manager. No data lives on the instance.
- **Domains:** both `app.` and `api.` must be on the boutique's own domain (see §10.1 — required for cookies).
- **Deploy:** GitHub Actions on `main`: lint + full test suite → build web → `aws s3 sync` + CloudFront invalidation → SSM Run Command on EC2 to pull, install, migrate, `pm2 reload`.
- **Local development:** local MongoDB started as a single-node replica set (needed for transactions), local S3/SES replaced by adapters writing to disk.
- **Staging:** not now; planned after development and trial.

### 2.5 MongoDB M0 constraints and mitigations

| Constraint | Mitigation |
|---|---|
| No Atlas backups | Worker runs `mongodump` every 6 h → backups bucket (versioned, Object Lock, Glacier after 30 days, retained 8 years). Worst-case loss: 6 h. Restore procedure documented in the repo. |
| 512 MB storage | Files kept in S3; weekly job alerts admin at 70% of quota. Estimated growth 50–100 MB/year. |
| Shared, throttled, no SLA | Acceptable at ~10 users. |
| Custom database roles may be unavailable | Audit append-only is enforced in the app and by hash chain; a DB-level insert-only role on `auditLog` is added if M0 supports it, otherwise on upgrade. Verify during build. |
| Upgrade path | In-place M0 → M10 in Atlas UI, short outage, no code change. Expected within 2–3 years. |

### 2.6 Conventions used everywhere

- **Money:** integer paise. Never floats. Formatting and rounding only in `packages/shared/src/money.js`.
- **Time:** stored in UTC; business dates (pickup date, invoice date, period, financial year) computed in **Asia/Kolkata**. Financial year runs 1 April – 31 March.
- **Branch:** every business document carries `branchId` (one branch now; multi-branch under the same GSTIN later without migration).
- **Versioning:** every editable document has a version field (Mongoose optimistic concurrency).
- **Common fields:** `createdAt`, `createdBy`, `updatedAt`, `updatedBy`.
- **API:** REST + JSON under `/v1`. List endpoints support filters, sort and cursor pagination.

---

## 3. Data model

Collections are grouped by module. Fields listed are the important ones, not exhaustive.

### 3.1 Setup and people

- **branches** — name, legal name, GSTIN, state code, address, phone, email, logo key, document prefixes.
- **users** — name, email (unique), passwordHash (argon2id), `roles[]` (`admin`, `operations`, `designer`), branchId, active.
- **sessions** — server-side session store (see §10.1).
- **settings** (one per branch):
  - `advancePercent` (default 100)
  - `billDueDays`
  - `cancellationRefundSchedule` — refund % by the furthest stage reached
  - `uncollectedFlagDays`
  - `stageDurations` — default days per stage, with optional overrides per garment type
  - `appointmentDurations` — minutes per appointment type
  - `quietHours` per channel (client default 21:00–09:00)
  - `b2clThreshold` (default ₹1,00,000; inter-state B2C invoices above this are B2CL)
  - `numberSeries` — starting numbers per document type per financial year
  - `dailyJobTime` (default 08:00), `closingTime` (default 20:00)
- **workers** — tailors, masters, artisans (no login): name, skill, active.
- **vendors** — outside workshops and suppliers: name, phone, GSTIN, state, services offered, active.

### 3.2 Customers and measurements

- **customers** — name, phone (unique per branch), email, type (`individual`, `business`, `film_production`), GSTIN (optional), state code, billing address, source (`instagram`, `referral`, `walk_in`, …), notification consent per channel, preferred channel.
- **measurements** — customerId, garment type, values (map of name → number + unit), notes, takenBy, takenAt. **A new document every time**; never updated. The latest set for a garment type pre-fills new orders.

### 3.3 Orders and garments

- **orders**
  - orderNo `VS/ORD/2627/0001` (internal, not a GST document)
  - customerId, designerId, priority (`normal`, `rush`), expected budget, notes
  - `pickupDate`, `originalPickupDate`, `occasionDate`
  - status: `active`, `on_hold`, `completed`, `cancelled`; `holdHistory[]` (from, to, reason)
  - cancellation: reason, furthest stage reached, refund computed from the schedule
- **garments** (one per order item)
  - garmentNo `…/0001-02`, orderId, type, description, fabric, design notes, quantity 1
  - agreed price (paise), catalog itemId for billing
  - optional own `dueDate` + `originalDueDate`
  - `batchId` for bulk film orders (N identical garments created at once)
  - reference photos/sketches (S3 keys)
  - `stagePlan[]` — stage, plannedDate, originalPlannedDate, skipped + reason
  - current state (denormalised from stage events): `currentStage`, `stageState` (`pending`, `in_progress`, `with_vendor`), status (`in_progress`, `ready`, `picked_up`, `rejected`, `cancelled`), `alterationOpen`, `tightSchedule`
  - `materials[]` — stockItemId, planned quantity (see §6)

### 3.4 Production

- **Stage list** (fixed, in `packages/shared/src/stages.js`, in order): Order taken + advance → Materials ready → Pattern making → Handwork → Quality check → Masters cutting table → Tailors → Trials and fittings → Finishing → Branding → Final quality check → Packaging → Ready for pickup → Picked up.
- **stageEvents** — append-only: garmentId, stage, action (`start`, `complete`, `skip`, `qc_pass`, `qc_fail`, `sent_to_vendor`, `returned_from_vendor`, `rework`, `alteration`, `rejected`, `picked_up`), workerIds, vendorId, dueBackDate, remarks, photo keys, by, at. The garment's current state is updated in the same transaction as each event.

---

## 4. Production rules

- Every garment follows the stage order. A designer can skip a stage with a short reason.
- **Only designers** (and admin) update production stages.
- **Bulk updates:** designers can apply a stage action to selected garments together (typically a batch).
- **Vendor work:** any stage can be sent to a vendor with a due-back date; returning it records the return.
- **Quality checks:** pass continues; **fail = rework** — the garment returns to the stage that caused the failure (chosen by the designer).
- **Alteration:** client asks for a change after a trial or after pickup → garment returns to Tailors; if already picked up it reopens with `alterationOpen`.
- **Rejected:** client refuses the garment; never charged; owner chooses refund, remake (new garment on the same order) or write-off.
- Rework and alteration can be charged or free, decided per case; a charge becomes an extra-charge line on the bill.
- **Stage planning:** when an order is taken, each garment's `stagePlan` is back-scheduled from its due date (garment due date, else order pickup date) using `stageDurations` (garment-type override, else default). If the plan does not fit, durations are compressed proportionally and the garment is flagged `tightSchedule`. Designers can edit any planned date; the original is kept and the change is logged.
- **Late:** a garment is late when its current stage is not completed by that stage's planned date, or its due date has passed and it is not ready. Late checks are suspended while the order is `on_hold`.
- **Pickup date changes** keep `originalPickupDate` / `originalDueDate`; on-time figures use the originals.
- **On-time rate** = garments reaching Ready for pickup on or before their original due date ÷ garments that reached Ready for pickup in the period.
- **Nearly ready** (for pickup-risk alerts) = has reached Final quality check or later.
- Garments are collected from the boutique; there is no delivery.

---

## 5. Billing and GST

### 5.1 Catalog

- **items** — name, kind (`garment`, `stitching_service`, `material`, `extra_charge`), supply type (`goods` or `service`), HSN/SAC, unit, default price, optional stockItemId, `gstSlabs[]` = `{ upToUnitPrice | null, rate }`.
- The applicable rate is chosen by the line's unit price at invoice time (e.g. apparel currently 5% up to ₹2,500 per piece, 18% above). Slabs and HSN/SAC are entered and confirmed by the accountant; rate changes are data changes, not code changes.

### 5.2 Documents and numbering

| Document | Series example | Purpose |
|---|---|---|
| Tax invoice | `INV/2627/0001` | Sale |
| Credit note | `CN/2627/0001` | Reduce/reverse an issued invoice |
| Receipt voucher | `RV/2627/0001` | Advance received against a service (GST payable on advance) |
| Payment receipt | `RCPT/2627/0001` | Any money received |
| Refund voucher | `RF/2627/0001` | Money returned (advance refund, rejection) |

- GST document numbers are at most 16 characters, unique per financial year, consecutive.
- **counters** collection: one document per (branch, document type, financial year). The number is taken by `findOneAndUpdate($inc)` **inside the issuing transaction**, so an aborted issue never consumes a number → no gaps.
- Starting numbers come from `settings.numberSeries` (continuity with any invoices already issued this financial year elsewhere).
- Drafts have no number.

### 5.3 Document lifecycle

1. **Draft** — editable; no number; not in reports.
2. **Issued** — in one transaction: number assigned, totals computed, a full **snapshot** stored (seller, customer, place of supply, lines, tax, totals), audit entry written, outbox entries written. The worker then renders the PDF from the snapshot, stores it in S3 under the locked prefix, and records its SHA-256 on the document. **Issued documents are immutable.**
3. **Cancelled** — only while the document date's month is not locked; reason required; number retained and reported as cancelled in the document summary; allocated payments become unallocated advance.

After the month is locked, corrections are made only with a **credit note** referencing the original invoice. The system warns when a credit note is raised for a financial year whose deadline (30 November following the FY end) is approaching or passed.

### 5.4 Invoice content and calculation

- All Rule 46 fields: supplier name, address, GSTIN; invoice number and date; customer name; customer GSTIN and address when registered; address and place of supply for unregistered customers when invoice value ≥ ₹50,000; place of supply (state name + code); per line HSN/SAC, description, quantity, unit, rate, discount, taxable value, tax rate, CGST/SGST or IGST amounts; totals; round-off; amount in words; authorised signatory.
- **Place of supply:** customer's state for registered customers; for unregistered customers, the customer's state if known, else the branch state. Same state as branch → CGST + SGST; otherwise IGST.
- **Discounts:** line discounts and invoice-level discounts. Invoice-level discounts are allocated across lines pro rata by taxable value **before** tax. Every discount needs a reason and is audited.
- **Extra charges:** rush, alteration, rework — catalog items of kind `extra_charge` with their own tax treatment.
- **Lines** can be one line per garment, or garment plus separate material lines; both are supported (open client question).
- **Rounding:** tax computed per line in paise; invoice total rounded to the nearest rupee with an explicit round-off line.

### 5.5 Money flow

- **payments** — customerId, amount, mode (`cash`, `upi`, `card`, `bank_transfer`), reference, date, receipt number, `allocations[]` = `{ invoiceId, amount }`. Unallocated amounts are the customer's advance balance.
- **Advances:**
  - Advance required = `advancePercent` × order value (agreed garment prices).
  - Advance against goods lines → payment receipt only.
  - Advance against service lines → receipt voucher with GST on the advance; adjusted when the final invoice is issued (tax already paid is deducted).
  - On the final invoice, the advance is applied as an allocation; the invoice shows advance received and balance due.
- **Refunds:** cancellation refund (per schedule) or rejection refund → refund voucher; a credit note as well when an invoice exists.
- **Due dates:** invoice due date = issue date + `billDueDays`. No credit period beyond that.
- **Customer ledger** and **receivables ageing** are derived from invoices, credit notes, payments and refunds. No stored running balances.

### 5.6 Period locks

- **periodLocks** — branch, month (`2026-10`), lockedBy, lockedAt, note.
- Admin marks a month as filed after GSTR-1 is filed. After locking, no billing document or expense can be created, cancelled, edited, voided or dated in that month. Unlocking is admin-only, requires a reason, and is audited.

### 5.7 Audit log

- **auditLog** — append-only: `seq` (monotonic per branch), entity type, entityId, action, field-level diff (before → after), userId, at, IP, user agent, `prevHash`, `hash` = SHA-256(prevHash + canonical JSON of the entry).
- **Covered:** billing documents, payments, refunds, expenses, catalog tax fields (HSN/SAC, slabs), customer GSTIN/state/name/address, settings, period locks, users and roles, logins and failed logins, stock adjustments.
- Written by `core/audit` in the **same transaction** as the change. The app exposes no update or delete for audit entries.
- The `seq` is taken from a counter inside the transaction, so entries chain in commit order.
- **Verify audit trail** (admin): recomputes the hash chain and compares stored PDF hashes against S3 objects; reports the first break, if any.
- Retention: never deleted (exceeds the 72-month GST requirement).

---

## 6. Expenses, stock and garment costing

### 6.1 Expenses

- **expenses** — expenseNo `EXP/2627/0001` (internal series), date, category (admin-editable list: rent, electricity, salaries, material purchase, vendor work, courier, …), payee (vendorId or free text), payee GSTIN, supplier bill number and date, taxable amount, GST rate, CGST/SGST/IGST, `itcEligible`, total, payment mode, attachment keys, optional link (`garmentId` or `batchId`), status (`active`, `voided` + reason).
- Editable until the expense date's month is locked; every change audited. Never deleted — voided with a reason.
- A batch-linked expense is split equally across the batch's garments for costing.
- Feeds the expense register and the input-tax side of the GSTR-3B summary.

### 6.2 Stock

- **stockItems** — name, brand, category, colour, purchase unit, usage unit, conversion factor (e.g. packet = 144 pieces), reorder level, selling price per usage unit, and cached `onHand`, `reserved`, `avgCost`.
- **stockMovements** — append-only: type (`opening`, `purchase_in`, `reserve`, `release`, `consume`, `adjust`, `sale`), quantity in usage units, unit cost, reference (garmentId, purchaseRequestId, expenseId, invoiceId), reason, by, at.
- Cached balances are updated in the same transaction as each movement. **free = onHand − reserved.** A transaction that would make `onHand` or `free` negative is rejected (`STOCK_INSUFFICIENT`). Miscounts are fixed with `adjust` + reason (audited).
- **Costing method: weighted average.** Each `purchase_in` recalculates `avgCost`; `consume` and `sale` are costed at the current `avgCost`.
- **purchaseRequests** — stockItemId, quantity, reason (shortfall for garment X, low stock, manual), status (`requested`, `ordered`, `received`, `cancelled`), vendorId.

**Order flow:**
1. When an order is taken, materials are listed per garment and **reserved** from free stock.
2. Any shortfall creates a purchase request.
3. **Receiving** a purchase request records `purchase_in` and creates the matching `material purchase` expense in one transaction (never entered twice).
4. When a garment completes **Materials ready**, its reservation becomes `consume`; the designer can correct to actual quantities; any remainder is released.
5. Cancelling an order releases everything not yet consumed.
6. Low stock (free below reorder level) raises an alert.

**Profit per stock item** = (selling price − avgCost) × quantity consumed or sold.

### 6.3 Garment and order costing

- **Material cost** = Σ consumed quantity × unit cost.
- **Expense cost** = Σ linked expenses at taxable value, plus their GST when `itcEligible` is false.
- **Garment margin** = invoiced taxable value attributable to the garment (net of credit notes) − material cost − expense cost.
- **Order profit** = Σ garment margins.
- Designers enter material quantities but never see costs, prices or margins.

---

## 7. Front office

### 7.1 Enquiries

- **enquiries** — name, phone, interest, rough budget, source, status (`new`, `contacted`, `appointment_booked`, `converted`, `lost` + reason), follow-up date, notes, `convertedCustomerId`, `convertedOrderId`.
- **Convert:** match an existing customer by phone or create one, then open a new order pre-filled from the enquiry.

### 7.2 Appointments

- **appointments** — type (`consultation`, `measurement`, `fitting`, `pickup`), designerId, customerId or enquiryId, start, end (default length from settings), status (`booked`, `completed`, `no_show`, `cancelled`), garmentIds (fittings).
- **No double-booking:** the booking transaction updates a lock document per (designer, IST date), forcing concurrent bookings for the same designer and day to conflict; the overlap check runs inside that transaction. The loser gets a 409 and retries against fresh data.
- Google Calendar sync is out of scope until the client answers; can be added as a one-way export.

---

## 8. Notifications

### 8.1 Flow

```
module service ──emit(event, data, session)──> routing rules ──> outbox (per recipient × channel)
                                                                         │
                                         worker: delivery job ──> channel adapter ──> provider
                                                                         │
                                         /v1/webhooks/:provider ──> adapter.parseWebhook ──> status
```

- **Events** are named (`appointment.booked`, `order.confirmed`, `garment.fitting_reached`, `garment.ready_for_pickup`, `qc.failed`, `vendor.overdue`, `stage.late_digest`, `pickup.at_risk`, `stock.low`, `invoice.issued`, `invoice.overdue`, …). Modules know nothing about channels.
- **notificationRules** (settings) — per event: recipient roles (`client`, `designer`, `owner`, `operations`), ordered channels, enabled flag, fallback channel.
- **notificationTemplates** — per event × channel, written with named variables (`{customerName}`, `{invoiceNo}`, `{amount}`, `{pickupDate}`). Email wraps them in a branded layout; this structure maps directly to WhatsApp pre-approved templates.
- **outbox** — recipient, channel, event, rendered variables, attachments (S3 keys), scheduledFor, status (`pending`, `sent`, `delivered`, `failed`, `skipped`), attempts, provider message id, `dedupeKey` (unique index: event + record + sequence + channel + recipient).
- Outbox entries are written **in the same transaction** as the business change. The worker delivers them with exponential backoff; after the final failure, the fallback channel is tried, then the entry is marked failed and visible to admin.

### 8.2 Channel adapters

Each adapter in `core/notify/adapters/` implements:

```js
// capabilities: { attachments: bool, templatesOnly: bool, maxLength?: number }
async send(message)          // → { providerMessageId, status }
parseWebhook(req)            // optional → [{ providerMessageId, status, at }]
```

Shipped: `email-ses`, `in-app`. Adding WhatsApp (Meta Cloud API, Gupshup, Twilio, …) or SMS = one adapter + settings + credentials in SSM.

- **Consent:** client messages go only to channels the customer has consented to; WhatsApp requires explicit opt-in.
- **Quiet hours** and rate limits are per channel. Client messages falling in quiet hours are held until the window ends. Staff messages are not held.
- **In-app:** `notifications` collection (userId, type, link, message, read). The web app polls every 60 s and shows an unread count.

### 8.3 Events, recipients and timing

| When | Who | Timing |
|---|---|---|
| Appointment booked / changed / cancelled | Client, designer | Immediate |
| Appointment reminder | Client, designer | 24 h before; 2 h before (skipped if it falls in client quiet hours) |
| Order confirmed + advance paid | Client (receipt attached) | Immediate |
| Garment reaches Trials and fittings | Designer, owner | Immediate |
| Stage running late | Designer (morning digest) | Daily at `dailyJobTime` |
| Pickup in ≤ 3 days, not nearly ready | Owner, designer | Daily |
| QC failed | Designer, owner | Immediate |
| Vendor past due-back date | Designer, operations | Daily |
| Stock below reorder level | Operations | Immediate |
| Invoice issued | Client (invoice PDF) | Immediate |
| Invoice overdue | Client; operations | Day after due, then every 7 days, max 4 reminders; skipped if owner paused reminders for that invoice |
| Garment ready for pickup | Client | Immediate |
| Garment uncollected > `uncollectedFlagDays` | Operations | Daily |
| Daily collections summary | Admin | Daily at `closingTime` |
| Monthly GST pack | Admin | 2nd of each month |
| Backup failure / storage at 70% / failed jobs | Admin | As they occur |

### 8.4 Scheduled jobs (worker)

| Job | Schedule |
|---|---|
| Deliver outbox | Every minute |
| Appointment reminders | Every 15 min |
| Late digest, pickup risk, vendor overdue, uncollected | Daily at `dailyJobTime` |
| Overdue invoices | Daily 10:00 |
| Collections summary | Daily at `closingTime` |
| Monthly GST pack | 2nd of month, 09:00 |
| Backup (`mongodump` → S3) | Every 6 h |
| Storage check | Weekly |

All jobs are idempotent through outbox `dedupeKey`s and are safe to re-run after a worker restart.

---

## 9. Dashboard and reports

### 9.1 Dashboard

Top to bottom:
1. **Needs attention today** — late garments, pickups ≤ 3 days not nearly ready, today's fittings, overdue invoices, failed QC, low stock, vendor overdue.
2. **Key numbers** — active orders, late garments, orders this month, billed, collected, outstanding, overdue, advances held, on-time rate; each with change vs last month.
3. **Production board** — garments per stage, in-house vs with vendors.
4. **Upcoming pickups** — next 14 days with stage and payment status.
5. **Money** — billed vs collected by month; who owes what and for how long.
6. **Today's calendar** — appointments and fittings by designer.
7. **Stock** — low stock, reserved for orders, profit per stock item.
8. **Enquiries** — conversion and source.
9. **Workload** — garments per designer and vendor, on-time rate.
10. **Expenses** — this month by category.
11. **Profit** — taxable revenue − material cost − expenses, overall and per order.

- Each tile is a **named query** in `modules/dashboard` returning a figure and paired with a list endpoint using the same filter definition, so tapping a number shows exactly the records behind it.
- Computed live from indexed queries with a 60-second in-memory cache.
- Filters: date preset (today, week, month, financial year, custom), customer type, designer, priority.
- Designers get the same layout limited to their own garments, with all money tiles removed — enforced on the server.

### 9.2 Reports (admin; Excel via exceljs and CSV)

- **GSTR-1 workbook** (sheets in GST offline-tool layout): B2B, B2CL, B2CS, CDNR, CDNUR, HSN summary (B2B and B2C split), document summary (issued, cancelled, net per series).
- **GSTR-3B summary:** outward taxable supplies by rate and tax head; eligible ITC from expenses; net tax.
- **Registers:** sales, credit notes, receipt vouchers, refund vouchers, collections by payment mode (cash reconciliation), advances held, expenses by category with input GST, stock movements and valuation.
- **Ledgers:** customer statement (PDF/Excel), receivables ageing (0–30, 31–60, 61–90, 90+), day book.
- **Business:** order and garment profitability, on-time by designer and vendor, enquiry conversion by source, profit per stock item.
- **Rules:** by document date; cancelled documents contribute zero value but appear in the document summary; locked months always reproduce the same numbers.
- **Automatic delivery:** daily collections summary; monthly GST pack (GSTR-1 workbook, 3B summary, registers) emailed to admin on the 2nd with a reminder to file and lock the month.

---

## 10. Roles and security

### 10.1 Authentication and sessions

- Email + password (argon2id). Password reset via a single-use emailed link (30-minute expiry).
- **Server-side sessions** in MongoDB. Cookie: `__Host-sid`, host-only on `api.<domain>`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`. Idle timeout 12 h, absolute 7 days. Deactivating a user or changing roles deletes their sessions.
- `app.<domain>` and `api.<domain>` are **same-site**, so the cookie is sent with `fetch(..., { credentials: 'include' })` and is not affected by third-party cookie blocking. Both must be on the boutique's own domain; default AWS hostnames would make them cross-site.
- **CORS:** allow exactly `https://app.<domain>` with credentials; preflight cached with `Access-Control-Max-Age: 7200`.
- **CSRF:** SameSite=Strict blocks cross-site requests; additionally every state-changing request must carry `X-Requested-With: vs-app` and a JSON body, forcing a CORS preflight that only the app origin passes. This covers same-site sibling subdomains.
- Login rate limit per IP and per account; 15-minute lockout after 10 consecutive failures.
- No two-factor authentication for now.

### 10.2 Permissions

- Named permissions in `packages/shared/src/permissions.js`, mapped to roles in one place. A user with several roles gets the union.

| Permission (examples) | admin | operations | designer |
|---|---|---|---|
| `orders.read.all`, `orders.write` | ✓ | ✓ | |
| `orders.read.own` | ✓ | ✓ | ✓ |
| `production.update` | ✓ | | ✓ |
| `measurements.write` | ✓ | ✓ | ✓ |
| `money.view` | ✓ | ✓ | |
| `billing.draft`, `billing.issue`, `payments.record`, `discounts.give` | ✓ | ✓ | |
| `billing.cancel`, `periods.lock`, `audit.verify`, `reports.export` | ✓ | | |
| `expenses.write` | ✓ | ✓ | |
| `stock.write` | ✓ | ✓ | (quantities on own garments) |
| `settings.edit`, `users.manage` | ✓ | | |

- Every route declares its required permission (`requirePermission(...)`).
- **Designer scoping:** repository functions filter by `designerId` when the user lacks `orders.read.all`.
- **Money stripping:** response serializers remove price, budget, cost, margin and payment amount fields when the user lacks `money.view`.
- An Accountant role can be added later as a new entry in the role map (read-only billing/expenses/reports, `periods.lock`, `reports.export`).

### 10.3 Data protection

- All inputs validated with strict zod schemas (unknown keys rejected — also prevents MongoDB operator injection).
- helmet security headers on the API; CloudFront response headers policy (CSP, HSTS) on the app.
- **Uploads:** server issues presigned PUT URLs with fixed key, content type (JPEG, PNG, WebP, HEIC, PDF) and size limit (10 MB). **Downloads:** presigned GET URLs valid 5 minutes, issued after a permission check.
- Personal data (phone numbers, measurements) is never logged. A short consent note is recorded for client communication (DPDP Act).
- Secrets only in SSM; EC2 uses an IAM role (no access keys).

---

## 11. Error handling and reliability

- **Error responses** (`{ error: { code, message, details } }`):
  - 400 `VALIDATION_FAILED` with field details
  - 401 `NOT_AUTHENTICATED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`
  - 409 `CONFLICT` — version mismatch or concurrent booking; UI asks to reload
  - 422 business rules with codes, e.g. `STOCK_INSUFFICIENT`, `PERIOD_LOCKED`, `DOCUMENT_IMMUTABLE`, `ADVANCE_EXCEEDS_TOTAL`, `STAGE_ORDER_VIOLATION`, `SLOT_TAKEN`
  - 500 with request id only
- The frontend maps codes to plain-language messages.
- **Transactions** use a helper that retries on `TransientTransactionError` and `UnknownTransactionCommitResult`.
- **Idempotency:** issuing documents, recording payments and refunds, and receiving stock require an `Idempotency-Key` header; the key and response are stored for 24 h and replayed on repeat.
- **PDF failure:** the document stays issued; the worker retries rendering from the snapshot.
- **Failed jobs:** after final retry, listed on an admin "failed jobs" screen and raise a CloudWatch alarm.
- **Observability:** pino JSON logs with request id → CloudWatch; `/v1/health` (DB ping, worker heartbeat) monitored by an alarm.

---

## 12. Testing

Vitest throughout. CI (GitHub Actions) runs lint and all tests; deploy runs only if all pass.

- **Unit (`packages/shared`):** GST calculation, slab selection, intra/inter-state, place of supply; discount allocation and rounding; amount in words; document number formatting; financial year boundaries at 31 March/1 April IST; stage back-scheduling and compression; weighted average cost.
- **API integration** (supertest + `mongodb-memory-server` as a replica set so transactions are real):
  - Order → stages → invoice issue → payment → credit note, end to end
  - Gapless numbering, including aborted issues
  - Period lock refusals across every billing and expense write
  - Audit hash chain verification and tamper detection
  - Stock never negative under concurrent reservations
  - Appointment double-booking under concurrent requests
  - Idempotency replay for payments and issue
  - Advance handling for goods vs service lines
- **Permission matrix:** every route × every role, generated from the route table; asserts no designer response contains a money field.
- **Notifications:** fake adapter and fake clock — routing, consent, quiet hours, fallback, dedupe.
- **End to end (Playwright, phone viewport):** take order → move through stages → issue invoice → record payment; enquiry → appointment → convert.

---

## 13. Go-live

- **Import tools**, each with a dry-run validation report before committing:
  - Inventory Excel → stock items + `opening` movements at cost
  - Customers
  - Open orders at their current stage (stage events marked as imported)
  - Opening balances: advances held, amounts owed (as opening receivables, clearly labelled)
- Number series starting points set in settings.
- Train staff; run alongside the paper form for one week.

---

## 14. Build order (internal milestones)

The product is delivered complete; milestones only order development.

1. **Foundation** — repo, CI/CD, infrastructure, auth, sessions, permissions, settings, users, audit core, transaction/idempotency helpers, notification core with `in-app` and `email-ses` adapters, file uploads, backups.
2. **Customers and orders** — customers, measurements, orders, garments, batches, stage planning.
3. **Production** — stage events, vendors, workers, QC/rework/alteration/rejection, late detection.
4. **Billing** — catalog, counters, invoices, PDFs, payments, advances, vouchers, credit notes, period locks, ledger.
5. **Expenses.**
6. **Stock and costing** — stock items, movements, reservations, purchase requests, garment costing.
7. **Front office** — enquiries, appointments.
8. **Dashboard and reports** — tiles, drill-downs, GST and business reports, scheduled report emails.
9. **Imports and go-live.**

---

## 15. Open items

**Client answers (built as settings or flexible structures; no code blocked):**
- Materials as separate bill lines vs one garment price → both supported.
- Price fixed at order vs advance on expected budget → advance computed from agreed garment prices; confirm.
- Cancellation refund by stage → `cancellationRefundSchedule`.
- Bill due days → `billDueDays`.
- Uncollected garment flag days → `uncollectedFlagDays`.
- Google Calendar → deferred.

**Accountant to confirm:**
- HSN/SAC and GST slabs per catalog item; goods vs service classification of each item.
- Treatment of advances for service lines (receipt vouchers).
- B2CL threshold value.

**To verify during build:**
- Whether Atlas M0 permits custom database roles (insert-only role on `auditLog`).
- SES production access (move out of sandbox) and domain verification (SPF, DKIM, DMARC).
