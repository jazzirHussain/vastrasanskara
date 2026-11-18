# M8 Dashboard and Reports Implementation Plan

Reconciled with built M5 on 2026-11-01, and with built M6 and M7 on 2026-11-13 (see "Reconciliation with built M6/M7").

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner opens the app on a phone and sees how the business is doing at a glance. At the top, "Needs attention today" lists what to act on: late garments, pickups at risk, today's fittings, overdue bills, failed quality checks, low stock, vendors running late and follow-up calls due. Below that come the key numbers, each with its change against last month. Then the production board, upcoming pickups, money (billed against collected by month, and who owes what), today's calendar, stock, enquiries, workload, expenses and profit. A date preset (Today / This week / This month / This year / Custom) and three filters (designer, priority, customer type) apply across the page. Tapping any number opens the exact records behind it. Designers get the same page limited to their own garments, with no money on it. The admin gets a Reports page with plain names: "GST return file (GSTR-1)", "GST summary (GSTR-3B)", registers, ledgers and business reports, each as an Excel or CSV file. Files are prepared in the background and downloaded through a 5-minute link, and every export is audited. On the 2nd of each month the GST pack (GSTR-1 workbook, 3B summary and registers) is emailed to the admin with a reminder to file and lock the month.

**Architecture:** Same modular monolith. Two new API modules:
- **`dashboard`.** No business model, only a tiny `DashboardSnapshot` collection used for month-ago comparisons. A registry of **metrics**, where each is one named query with a `figure(ctx)` and a `rows(ctx, page)` built from the **same filter object**. Tiles group metrics. Responses are cached in memory for 60 s per scope, and every figure is one bounded indexed aggregate or a capped read.
- **`reports`.** One `ReportRun` model. Builders turn data into `{ sheets: [{ name, columns, rows }] }` and writers turn that into XLSX (exceljs) or CSV. Runs are claimed by the worker every minute, and small ones also start at once in the API process. The file is stored under `<branchId>/reports/…` and downloaded by presigned link.

All GST classification and arithmetic (B2B/B2CL/B2CS/CDNR/CDNUR/AT/ATADJ split, HSN summary, document summary, 3B figures, ITC set-off) is **pure** in `packages/shared/src/reports/`, fed by document "views" that billing exports. The two new modules read every other module only through its `service.js`. Where a module's service lacks a function M8 needs, M8 adds it to that module (Tasks 3–4).

**Tech Stack:** As M7, plus **`exceljs` 4.4.0** (pure JS, spec §2.3) in `apps/api`. CSV is written by hand (shared encoder). Charts are **hand-built inline SVG/CSS** with no chart library (Decision 9).

**Spec:** `docs/superpowers/specs/2026-10-22-vastrasanskara-system-design.md`. Sections used:
- §9 (all): the 11 tiles, named queries paired with list endpoints, 60 s cache, filters, designer view without money; reports, report rules, automatic delivery.
- §2.2: the `dashboard` and `reports` modules, access through `service.js` only.
- §2.3: exceljs.
- §5.2–5.5: the document series, lifecycle, snapshots, place of supply, money flow, ledger and ageing.
- §5.6: locked months reproduce the same numbers.
- §5.7: audit.
- §6.1–6.3: the expense register, stock valuation and movements, costing.
- §7: enquiries and appointments.
- §8.1, §8.3 "Monthly GST pack → Admin, 2nd of each month" and §8.4 "2nd of month, 09:00".
- §10.2: `reports.export` admin only, money stripping, designer scoping.
- §10.3: presigned GET valid 5 minutes, issued after a permission check.
- §11: error shape, idempotency, failed jobs.
- §12: permission matrix with no designer money field.

Carried rulings:
- M4 ledger (`.superpowers/sdd/2026-10-30-m4-billing/progress.md`): heavy work runs as a **background job with a stored result** that the screen starts and then reads (Final ruling, "Check records"). The permission route table is hand-written and asserted equal to the routers' declared routes (Task 13 ruling). A committed write answers 2xx even if reading it back fails (`respondCommitted`). `advanceHeld = Σ issued receipts − Σ their allocation rows` (Task 11 ruling).
- M4 plan line 445: billed = invoices − credit notes, collected = receipts − refunds, by `date` on `register`; outstanding, overdue and ageing come from the `receivables` partial index.
- M3: on-time rate uses `readyDate` against the original due date.

**Binding unbuilt plans (their Interfaces are the contract).** These names are used exactly as written:
- M5 (built, `apps/api/src/modules/expenses/queries.js`, all re-exported by `expenses/service.js`): `expenseTotalsByCategory(branchId, { from, to }) → [{ category: <key>, total, count }]` (active only, biggest first, `total` includes GST, keys not labels: look labels up in `readSettings().expenseCategories` as `{ key, label }`); `inputTaxSummary(branchId, { from, to }) → { count, taxable, cgst, sgst, igst, itc: { cgst, sgst, igst }, ineligible: { cgst, sgst, igst } }`; `expenseCostTotal(branchId, { from, to }) → { cost, purchaseCost }`; `listExpenses(branchId, { from, to, category, vendorId, orderId, status = 'active', noBill, q, cursor, limit }) → { items: <raw expense docs>, nextCursor }` (without `from`/`to`/`month` it defaults to this month; `status: 'all'` includes voided); `monthSummary(branchId, month)`; shared `expenseCost(expense)`. Category labels live in settings `expenseCategories`.
- M6 (built; `apps/api/src/modules/stock/queries.js`, all re-exported by `stock/service.js`, except `orderProfits`). Permissions `stock.view`, `costing.view`. Money fields on stock rows need `money.view`.
  - `lowStockItems(branchId, { limit = 50 }) → [raw lean StockItem docs]` (active items with `low: true`, by name; the docs carry `value`, `avgCost`, `sellingPrice`, so rows must be whitelisted).
  - `stockValuation(branchId) → { value, reservedValue, items: [{ stockItemId, name, usageUnit, onHand, reserved, avgCost, value, reservedValue }] }` (items with `onHand > 0`).
  - `stockItemProfit(branchId, { from, to }) → [{ stockItemId, name, quantity, cost, sales, profit }]` (by name, not by profit; `sales` and `profit` are null without a selling price).
  - `materialCostTotal(branchId, { from, to }) → paise` (consume and sale movements).
  - `listMovements(branchId, itemId, { cursor, limit })` is **per item** and newest first. It is not the by-date list M8 needs (`listMovementsByDate`, Task 4).
  - `orderProfits(branchId, orderIds) → Map<orderId, { revenue, material, expense, profit }>` lives in **`apps/api/src/modules/costing/service.js`**, not in stock. It takes at most 100 ids (400 validation beyond) and reads each order on its own.
- M7 (built). `enquiries/queries.js` (re-exported by `enquiries/service.js`) and `appointments/queries.js` (re-exported by `appointments/service.js`). Permissions `enquiries.write`, `appointments.own`, `appointments.write`.
  - `followUpsDue(branchId, today) → { count, overdue }`.
  - `enquiryConversionBySource(branchId, { from, to }) → [{ source, total, converted, lost, open }]` (by source name).
  - `listEnquiries(branchId, { view = 'open', q, cursor, limit }, { today })` takes **`today` as a third argument**. Views: `follow_ups, open, new, appointment_booked, converted, lost, all`.
  - `appointmentsForDay(branchId, user, { date, designerId }) → { date, openingTime, closingTime, designers: [{ id, name, appointments: [card] }] }`. Cancelled ones are left out, and a user without `appointments.write` gets only their own column. A card has `type` (`consultation, measurement, fitting, pickup`), `status`, `time`, `designer`, `customer`, `enquiry` and no money.
  - `appointmentCounts(branchId, { from, to, designerId }) → { booked, completed, no_show, cancelled, byType }`. It takes **no user**, so it is not scoped (M8 does not use it).
  - `listAppointments(branchId, user, { from, to, designerId, customerId, enquiryId, status, cursor, limit })` has no `type` filter.

The M6 and M7 ledgers record no rename of any function above. The differences found are in the table "Reconciliation with built M6/M7".

## Global Constraints

- Everything in the M1–M7 Global Constraints still applies: integer paise, UTC times with IST business-date strings, `branchId`, strict zod, the error shape, no personal data in logs, bundled icons, 390 px screens, sentence case and plain words.
- **Layout and imports.** `apps/api/src/modules/dashboard/` holds `model.js` (`DashboardSnapshot` only), `service.js`, `metrics/*.js`, `filters.js`, `cache.js`, `snapshots.js`, `jobs.js`, `json.js` and `routes.js`. `apps/api/src/modules/reports/` holds `model.js`, `service.js`, `runner.js`, `writers.js`, `builders/*.js`, `gstPack.js`, `notifications.js`, `jobs.js`, `json.js` and `routes.js`.
  - Neither module imports another module's `model.js`, and no other module imports either of them (a test asserts this, as M6's import test does).
  - New data functions live in the owning module, in a focused file re-exported by its `service.js`.
- **Bounded reads only.** Every dashboard figure is one aggregate over a date range or partial index, or a read capped at a stated limit that returns `truncated: true` when hit. No figure scans a collection without an index (`explain` tests per task). Live dashboard ranges are capped at **400 days** (422 `RANGE_TOO_LONG` "Use Reports for longer periods").
- **Money stripping.** Without `money.view` a response contains **none** of `MONEY_KEYS` at any depth (key absence, not null). `MONEY_KEYS` is a shared constant: `amount, total, balance, billed, credited, collected, refunded, outstanding, overdueAmount, advancesHeld, revenue, cost, profit, margin, value, reservedValue, taxable, sales, expense, expenses, material, price, budget`.
  - Money tiles are absent for such users, not empty.
  - Designers are scoped to their own orders and garments by the server (`orderScope(user)` and the `user` argument of the orders and production services). A `designerId` filter can never widen that scope.
- **Permissions (no new names).**
  - `orders.read.own`: production, pickups (no payment status without `money.view`), workload, and the order and garment metrics.
  - `money.view`: money metrics and payment status.
  - `expenses.view`: expenses tile.
  - `stock.view`: stock tile.
  - `costing.view`: profit tile (admin only).
  - `enquiries.write`: enquiries tile and follow-ups.
  - `appointments.own`: calendar and fittings (scoped by M7).
  - `reports.export` (admin only): every `/v1/reports` route.
- **Report rules (spec §9.2).** Every report goes by document date. Cancelled documents contribute zero value but appear in the document summary. A report on a locked month gives identical rows every time, and the run stores `rowsHash`, the SHA-256 of the canonical rows JSON.
- **Exports audited.** `recordAudit({ entityType: 'report', entityId: run._id, action: 'request' | 'download', after: { kind, params, format } })` runs when a run is requested and each time a download link is issued, both in a transaction.
- **Cell safety.** In XLSX and CSV, any text cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`. Numbers stay numbers. Money is written in rupees with 2 decimals (`paise / 100`, XLSX `numFmt '#,##0.00'`). Dates are `dd-mmm-yyyy` in GST sheets and `YYYY-MM-DD` elsewhere. CSV is UTF-8 with BOM and CRLF.
- **Words in the UI:**
  - Labels: "Home", "Needs attention today", "Key numbers", "Reports", "Get file", "Preparing your file…", "Download", "Make it again".
  - "Excel" or "CSV (plain text)". Excel is the default.
  - Presets: "Today", "This week", "This month", "This year", "Custom".
  - Report names: "GST return file (GSTR-1)", "GST summary (GSTR-3B)".
  - Change line: "vs last month: up ₹12,400". Neutral words, with colour only alongside an arrow icon and a label.
  - Never use "metric", "aggregate", "cache" or "run" in copy.
- Commit subjects end with `(M8 Task N)`. No deploy or infra changes. The S3 lifecycle expiry for `reports/` is parked for go-live.

## Decisions made in planning

| # | Decision | Why | Cost if wrong |
|---|---|---|---|
| 1 | **Every number is a metric** in a registry (`dashboard/metrics/*.js`): `{ id, tile, permission, figure(ctx), rows(ctx, { cursor, limit }), periodic }`. The figure and its rows are built from **one filter object** (`filters.js`), and a test asserts `figure === Σ rows` for every metric. Drill-downs open one generic page `/home/:metric` that lists those rows. Each row links to its record (order, garment, bill, expense…). Existing pages (Production, Bills) are **not** changed to read URL filters. | Spec: "tapping a number shows exactly the records behind it". One definition can't drift. One generic page avoids editing six existing pages. | Deep links into existing pages later are a `link` field per metric. |
| 2 | **`GET /v1/dashboard` returns every tile the user may see in one response.** A tile that throws becomes `{ error: 'UNAVAILABLE' }` and the rest still render. Cached **60 s in memory** keyed by `branchId + scopeKey + filters`. `scopeKey` is `'all'` for users with `orders.read.all`, else `user:<id>`, plus a hash of the sorted permission set, so a designer never shares an entry with operations. `?fresh=1` bypasses the cache (the "Refresh" button). The response carries `asOf`. | One round trip on a phone. Spec's 60 s cache. A fresh payment is visible after one tap on Refresh. | Per-tile endpoints are a router split. |
| 3 | **Presets.** "This week" runs Monday to today. "This month" runs the 1st to today. "This year" is the financial year to date. "Today" is today. The comparison period is the **same span one period back**: Monday to the same weekday last week, the 1st to the same day last month (capped at that month's end), FY start to the same date last FY, yesterday, or the equal-length range before a custom range. Custom ranges are ≤ 400 days. | "Change vs last month" must compare like with like. A month-to-date against a whole month always looks bad. | Pure function `presetRange`. |
| 4 | **Point-in-time figures** (active orders, late garments, outstanding, overdue, advances held) are compared with a **daily snapshot** written at 23:30 IST by the `dashboard-snapshot` job. The snapshot is branch-wide only and taken from the same functions with the whole-branch scope. The comparison uses the snapshot dated the same day last month, else the nearest earlier one within 7 days, else no change line. Designers and filtered views show no change line on these figures. | There is no history to compute "outstanding a month ago" from. One small document per day per branch. | Before the first month after go-live there is no change line. |
| 5 | **Gross figures with exact drill-downs.** "Billed" is the issued invoice total by date, with a sub-line "less ₹X in credit notes". "Collected" is the issued receipts by date, with a sub-line "₹X refunded". The profit tile uses **net taxable revenue** (invoice taxable − credit-note taxable). | The owner can match each figure to a list of bills or payments. Nets hide the documents behind them. | One label change. |
| 6 | **Profit (tile 11)** is net taxable revenue − material cost (M6 `materialCostTotal`) − **operating expense cost**. Operating expense cost is the expense cost value (taxable, plus GST only when ITC cannot be claimed) of active expenses **not created by stock receiving** (`source !== 'purchase'`). Purchases enter stock and count when used, so counting them again would double-count. "Per order" shows the 5 lowest and 5 highest profits among the **≤ 100 most recently invoiced orders in the range** (M6 `orderProfits`). The full list is a business report. | Spec §9.1 tile 11 and §6.3. Avoids the double count. Stays bounded. | Show purchases instead of consumption: swap two calls. |
| 7 | **Filters.** Designer and priority apply to order and garment metrics (orders carry `designerId` and `priority`). Customer type applies to order, garment and money metrics through `customerIdsOfType`. Business and film customers are few, so it returns `{ in: [...] }`, and for `individual` it returns `{ notIn: [...] }`, capped at 5,000 ids (over that → 422 `FILTER_TOO_BROAD`). Tiles a filter does not apply to (expenses, stock, enquiries, calendar) show "Not filtered by customer type". | Spec filters. No denormalised customer type on orders, so no cross-module writes. Honest about what a filter touches. | Denormalising `customerType` onto orders is a migration plus one filter. |
| 8 | **QC failed** in "Needs attention" means `qc_fail` events in the **last 7 days** on garments that are still open. **Vendor overdue** means open garments with `stageState === 'with_vendor'` whose `vendorWork.dueBackDate < today`. **Pickups at risk** means order pickup in ≤ 3 days and the garment not nearly ready (the M3 daily-job rule, moved to a shared pure helper `isPickupAtRisk`). **Follow-ups due** (M7) appears in the same list. | Spec lists the items but not the windows. 7 days catches Monday's view of Friday's failures. | One constant. |
| 9 | **Charts without a library.** Billed against collected by month is a grouped bar chart, 2 series, with a legend plus direct labels and a "Show as table" toggle. The other tiles use horizontal bars (expenses by category, conversion by source, workload) or stat tiles. Both are inline SVG or CSS from `components/charts/`, following the dataviz skill: one axis, thin marks with 4 px rounded data-ends, 2 px gaps, categorical hues in fixed order, a tap tooltip, and status colours only with an icon and label. The palette is validated with the skill's `validate_palette.js` against the light and dark app surfaces. | Two chart shapes do not justify a 100 kB library on a phone. Accessible by construction. | Swapping in a library touches 2 components. |
| 10 | **Reports run in the background.** `POST /v1/reports` (Idempotency-Key) creates a `ReportRun` (`queued`). If the kind is **light** (range ≤ 31 days, or a single customer), the API starts it at once in-process (`setImmediate`, claim-based). Otherwise the worker's `reports-run` job claims it within a minute. The screen polls every 3 s. Claims use `findOneAndUpdate({ status: 'queued' } → 'running', claimedAt)`, so the API and worker never both build one. A run stuck `running` > 30 min becomes `failed`. Up to 2 attempts. | The M4 "Check records" ruling, made quicker for the common monthly case. A yearly register never runs in a web request. | Moving everything to the worker is one condition. |
| 11 | **Formats.** XLSX via **exceljs** (spec §2.3), written with the streaming `WorkbookWriter` to a buffer. CSV for single-sheet reports only (multi-sheet kinds offer Excel only). Customer statement also as **PDF** (spec §9.2 "PDF/Excel") with pdfmake via `core/pdf`. Reports are capped at **200,000 rows** (`REPORT_TOO_LARGE`: "Choose a shorter period"). | Spec-pinned library. Bounded memory on a 2 GB box. | — |
| 12 | **Files** are stored under `<branchId>/reports/<yyyy>/<uuid>.<ext>` (the files service's key pattern `<branchId>/<purpose>/<yyyy>/<uuid>.<ext>`, purpose `reports`), with a friendly filename such as `GSTR-1 October 2026.xlsx` kept on the run. `storage.putObject` gains an optional `contentDisposition` (both adapters, and `devFilesRoutes` serves it), so the download saves under that name. Download is `GET /v1/reports/:id/download` → `{ url }`: a presigned GET for 5 minutes after the `reports.export` check, audited each time. Runs older than 90 days are hidden ("Make it again"). Expiring the objects is go-live S3 lifecycle. | Spec §10.3. Exports are audited. Files hold personal data, so they are not kept in view forever. | — |
| 13 | **GSTR-1 workbook layout follows the GST offline tool**: sheets `b2b, b2cl, b2cs, cdnr, cdnur, at, atadj, hsn(b2b), hsn(b2c), docs` with the tool's exact headers (Task 2 `GSTR1_COLUMNS`). **AT/ATADJ are added** (spec lists them implicitly via receipt vouchers): advances taxed by receipt vouchers in the month and those adjusted by invoices or refunds in the month, by place of supply and rate. | The system issues receipt vouchers with GST (spec §5.5), and the accountant must report them. | Drop two sheets. |
| 14 | **Classification.** B2B is an invoice whose customer snapshot is `registered`. B2CL is unregistered **and** inter-state **and** invoice total > `settings.b2clThreshold`. Everything else is B2CS, aggregated by place of supply × rate, type `OE`. Credit notes:<ul><li>a registered customer goes to **CDNR**;</li><li>a note on a B2CL invoice goes to **CDNUR** (`UR Type B2CL`);</li><li>a note on a B2CS invoice is **netted into B2CS** of the note's month as negative taxable value.</li></ul>HSN summary is the month's invoices minus credit notes per HSN × rate × B2B/B2C. Quantity comes from invoices only, UQC maps `PCS→PCS-PIECES, MTR→MTR-METERS, SET→SET-SETS, NOS→NOS-NUMBERS, OTH→OTH-OTHERS`, and services use `NA` with quantity 0. | Offline-tool practice. The accountant confirms. | Pure functions with their own tests; changing a rule changes one function. |
| 15 | **GSTR-3B summary** comprises:<ul><li>3.1(a): invoices − credit notes + advances (RV) − advance adjustments in the month, per head.</li><li>3.1(c): lines at 0 %.</li><li>3.2: inter-state supplies to unregistered persons by place of supply.</li><li>4(A)(5): M5 `inputTaxSummary().itc`. Non-claimable GST is shown "for information".</li><li>"Tax to pay in cash": pure `gstSetOff`. IGST credit goes to IGST, then CGST, then SGST. CGST credit goes to CGST, then IGST. SGST credit goes to SGST, then IGST. IGST credit is used first, and leftover credit is shown as carried forward.</li></ul>Labelled "Estimate. Your accountant confirms before filing." | Spec "net tax". Cross-utilisation follows ss. 49/49A. | One pure function. |
| 16 | **Monthly GST pack**: the `reports-gst-pack` job runs every 15 min. On or after the 2nd at 09:00 IST, for each branch without a scheduled pack for the previous month (unique index `(branchId, kind, params.month, source)` on `source: 'schedule'`), it queues a `gst_pack` run. On completion, `reports.gst_pack` is emitted to `owner` (email + in-app) with **two attachments**: `GSTR-1 <Month>.xlsx` (offline-tool sheets only) and `GST summary and registers <Month>.xlsx` (3B, sales, credit notes, receipt vouchers, refund vouchers, collections by mode, expenses with input GST). The body says "Your GST files for October 2026 are ready. After filing, lock October in Accounts → Month locks." and links to `/accounts`. | Spec §8.3 and §8.4. A separate GSTR-1 file keeps the offline-tool import clean. The dedupe key keeps restarts safe. | — |
| 17 | **Data functions M8 adds to other modules** (each in the owner's service, Tasks 3–4; M5 `expenseCostTotal` is already built):<ul><li>billing (M4) `reports.js`: `periodMoney`, `monthlyMoney`, `receivablesAgeing`, `advancesHeld`, `advancesByCustomer`, `orderPaymentStatuses`, `invoicedOrderIds`, `billingDocumentsInRange`, `documentSeries`.</li><li>orders (M2): `orderCounts`, `listOrdersPlaced`, `garmentsReadyBetween`, plus indexes.</li><li>customers: `customerIdsOfType`, plus an index.</li><li>production (M3): `qcFailures`, `vendorOnTime`.</li><li>expenses (M5): `expenseCostTotal`.</li><li>stock (M6): `listMovementsByDate`, in `stock/queries.js` and re-exported by `stock/service.js`.</li><li>enquiries (M7): `listEnquiries` gains `source`, `from`, `to` (it already takes `{ today }` as its third argument).</li></ul> | Only the owning module reads its models. These are the gaps between the M5–M7 contracts and the tiles and reports. | — |
| 18 | **On-time rate** is garments whose `readyDate` falls in the range (status `ready` or `picked_up`), on time when `readyDate ≤ garment.originalDueDate ?? order.originalPickupDate`. A garment reopened by alteration has `readyDate` reset and drops out until ready again. Capped at 5,000 garments per call (`truncated`). New garment index `ready (branchId, readyDate)` partial on string. | Spec §4 definition with the stored M3 fields. | — |
| 19 | **Home is the dashboard.** `/` renders `DashboardPage` for every role. The old "Upcoming pickups" and "On hold" lists become the pickups tile and an "On hold" item in Needs attention. The M7 "Follow-ups today" list becomes the "follow-up calls due" item in Needs attention, and "Today's appointments" becomes the calendar tile. The three quick buttons stay at the top, each by its permission: "New enquiry" (`enquiries.write`), "Book appointment" (`appointments.write`) and the M5 "Add expense" (`expenses.write`). Nav gains **"Reports"** (`IconFileSpreadsheet`, phone `more`, `reports.export`). | A non-technical owner looks in one place. No new bottom-bar slot. | — |
| 20 | **No report scheduling UI** beyond the fixed monthly pack. The M4 daily collections summary stays as built. | Spec lists exactly these two automatic deliveries. | A schedule table is a later feature. |

## Review Focus

1. **A number and its list disagree.** The owner taps "Overdue ₹48,000" and must see bills summing to exactly ₹48,000, under every filter and preset. → Task 7 test `every figure equals the sum of its drill-down rows`.
2. **Designer sees money or other designers' work.** No money key at any depth, no other designer's garments, no money tile, and a `designerId` filter cannot widen the scope. → Task 7 tests `designers never receive a money field anywhere on Home` and `a designer filter cannot widen a designer's scope`.
3. **GSTR-1 classification at the edges.**
   - An unregistered inter-state invoice exactly at the threshold is B2CS, and ₹1 over is B2CL.
   - A credit note on a B2CS bill nets into B2CS.
   - A cancelled invoice is in docs but nowhere else.
   - A B2B invoice with two rates is two rows.

   → Task 2 tests `the B2CL threshold is strictly greater than`, `credit notes on small bills reduce B2CS`, `cancelled bills appear only in the document summary`.
4. **Locked month reproducibility and cross-month documents.** A bill dated 31 October, issued on 1 November IST, belongs to October. A locked month gives the same `rowsHash` twice, even after later-month activity. → Task 9 tests `a locked month gives identical GST files` and `documents count in the month of their date`.
5. **Export safety.**
   - A customer named `=HYPERLINK(...)` is neutralised in CSV and XLSX.
   - Operations and designers get 403 on every report route and cannot fetch a report key through `/v1/files/url`.
   - Each download is audited.
   - A double tap on "Get file" makes one run.

   → Task 1 test `cells that look like formulas are neutralised`. Task 8 tests `report files are admin only, even by key`, `each download link is audited`, `asking twice with one key makes one file`.

---

## File Structure

```
packages/shared/src/
  dashboard.js                  PRESETS, presetRange, comparisonRange, MONEY_KEYS, DASHBOARD_TILES, METRICS,
                                changeOf, onTimeRate, isPickupAtRisk, MAX_LIVE_RANGE_DAYS
  reports/catalog.js            REPORTS (kind, label, group, params, formats, light), reportFilename
  reports/csv.js                safeCell, toCsv
  reports/gstr1.js              GSTR1_COLUMNS, UQC_BY_UNIT, classifyInvoice, gstr1Sheets
  reports/gstr3b.js             gstr3bSummary, gstSetOff
  reports/registers.js          salesRegisterRows, creditNoteRows, voucherRows, collectionsByMode, dayBookRows
  schemas/dashboard.js          dashboardQuery, metricRowsQuery
  schemas/customers.js          + export CUSTOMER_TYPES (now a private const)
  schemas/frontOffice.js        + source, from, to on enquiryListQuery
  schemas/reports.js            reportRequestSchema, reportListQuery
  production.js                 + isPickupAtRisk moved here and re-exported by dashboard.js
  index.js                      + exports
apps/api/src/
  core/files/storage-local.js, storage-s3.js, devFilesRoutes.js   putObject + contentDisposition (headObject returns it; the dev route sends it)
  core/files/purposes.js        + 'reports' purpose (canRead: reports.export; server-written only)
  modules/billing/reports.js    (+ re-export in billing/service.js)
  modules/orders/{model.js,service.js,reports.js}       + indexes, orderCounts, listOrdersPlaced, garmentsReadyBetween
  modules/customers/{model.js,service.js}               + index (branchId, type), customerIdsOfType
  modules/production/{service.js,reports.js}            qcFailures, vendorOnTime
  modules/expenses/queries.js   (M5, built: expenseCostTotal, expenseTotalsByCategory, inputTaxSummary, listExpenses; nothing added)
  modules/stock/{queries.js,service.js}     + listMovementsByDate, re-exported   (M6 module)
  modules/enquiries/queries.js  + listEnquiries source/from/to (M7 module; service.js already re-exports it)
  modules/dashboard/
    model.js                    DashboardSnapshot
    filters.js                  buildContext(user, query) → ctx
    cache.js                    cached(key, fn, { ttlMs, fresh })
    metrics/{attention.js,keyNumbers.js,production.js,money.js,front.js,stock.js,expenses.js,profit.js,index.js}
    service.js                  dashboardFor, metricRows
    snapshots.js, jobs.js, json.js, routes.js
  modules/reports/
    model.js                    ReportRun
    service.js                  requestReport, getRun, listRuns, downloadLink, runPendingReports
    runner.js                   claimRun, buildRun
    writers.js                  toXlsx, toCsv (buffer), toPdf (statement)
    builders/{index.js,gst.js,registers.js,ledgers.js,business.js}
    gstPack.js, notifications.js, jobs.js, json.js, routes.js
  app.js, jobs.js               mount /v1/dashboard, /v1/reports; import dashboard + reports jobs
apps/api/test/
  helpers/dashboard.js, dashboard-data.test.js, dashboard-tiles.test.js, dashboard-drill.test.js,
  dashboard-permissions.test.js, reports-runs.test.js, reports-gst.test.js, reports-registers.test.js,
  reports-gst-pack.test.js, billing-reports.test.js, module-data.test.js
apps/web/src/
  components/charts/{BarPair.jsx, HBars.jsx, StatTile.jsx, chartTokens.css}
  features/dashboard/{dashboardApi.js, DashboardPage.jsx, FilterBar.jsx, AttentionList.jsx, KeyNumbers.jsx,
                      tiles/*.jsx, MetricPage.jsx}
  features/reports/{reportsApi.js, ReportsPage.jsx, ReportCard.jsx, RecentFiles.jsx}
  features/home/{HomePage.jsx (→ DashboardPage), HomePage.test.jsx}, layout/navItems.js, App.jsx, lib/errorMessages.js, test/server.js
```

---

### Task 1: Shared: presets, money keys, metric catalog, CSV safety, report catalog

**Files:**
- Create: `packages/shared/src/dashboard.js`, `packages/shared/src/reports/{catalog.js,csv.js}`, `packages/shared/src/schemas/{dashboard.js,reports.js}`
- Modify: `packages/shared/src/production.js`, `packages/shared/src/schemas/customers.js` (export `CUSTOMER_TYPES`), `packages/shared/src/index.js`
- Test: `packages/shared/test/dashboard.test.js`, `packages/shared/test/m8-schemas.test.js`, `packages/shared/test/production.test.js`

**Interfaces:**
- Consumes: `addDaysYmd`, `financialYear`, `istDate` (fy.js); `isNearlyReady` (production.js); `CUSTOMER_TYPES` (customers schema, exported by this task).
- Produces (`production.js`): `isPickupAtRisk({ garment, order }, today) → boolean`. True when the garment is `in_progress`, `today ≤ order.pickupDate ≤ today+3` and it is not nearly ready. `production/daily.js` switches to it.
- Produces (`dashboard.js`):
  - `PRESETS = ['today','week','month','fy','custom']`; `MAX_LIVE_RANGE_DAYS = 400`.
  - `presetRange(preset, today, { from, to }) → { from, to }`; `comparisonRange({ preset, from, to }) → { from, to }` (Decision 3).
  - `changeOf(current, previous) → { previous, diff, direction: 'up'|'down'|'same' } | null` (null when `previous` is null).
  - `onTimeRate(rows) → { ready, onTime, rate: number|null }` (`rate` in basis points of 10000, null when `ready === 0`).
  - `MONEY_KEYS` (Global Constraints list, frozen).
  - `DASHBOARD_TILES`: ordered ids `attention, key_numbers, production, pickups, money, calendar, stock, enquiries, workload, expenses, profit`.
  - `METRICS`: frozen map id → `{ tile, label, permission, money: boolean, periodic: boolean, filters: ['designer','priority','customerType'] subset }`. Ids:
    - attention: `late_garments`, `pickups_at_risk`, `fittings_today`, `overdue_bills`, `qc_failed`, `low_stock`, `vendor_overdue`, `follow_ups_due`, `on_hold_orders`.
    - key numbers: `active_orders`, `orders_placed`, `billed`, `collected`, `outstanding`, `overdue_amount`, `advances_held`, `on_time`.
    - other tiles: `stage_garments`, `upcoming_pickups`, `month_money`, `receivables_ageing`, `appointments_today`, `stock_low`, `stock_reserved`, `stock_item_profit`, `enquiry_sources`, `workload_designers`, `workload_vendors`, `expense_categories`, `profit`, `order_profits`.
    - Labels are plain, e.g. "Late garments", "Pickups in 3 days, not nearly ready", "Owed to you", "Overdue", "Advances held", "On time".
- Produces (`reports/csv.js`): `safeCell(v) → v` (Global Constraints rule); `toCsv(columns, rows) → string` (BOM, CRLF, quotes doubled, money columns `kind: 'money'` → rupees `1234.50`).
- Produces (`reports/catalog.js`): `REPORTS` frozen array of `{ kind, label, group, params: 'month'|'range'|'customer'|'none', formats, sheets?: 'multi' }`:
  - **GST**: `gstr1` "GST return file (GSTR-1)", month, xlsx only. `gstr3b` "GST summary (GSTR-3B)", month, xlsx/csv. `gst_pack` "This month's GST files (all of them)", month, xlsx.
  - **Registers**: `sales_register`, `credit_note_register`, `receipt_voucher_register`, `refund_register`, `collections_by_mode`, `advances_held`, `expense_register` ("Expenses by category with GST"), `stock_movements`, `stock_valuation` (params none).
  - **Ledgers**: `customer_statement` (customer + range; pdf/xlsx), `receivables_ageing` (none), `day_book` (range).
  - **Business**: `order_profitability`, `on_time` ("On time by designer and vendor"), `enquiry_conversion`, `stock_item_profit` (range).
  - `isLight({ kind, params }) → boolean` (Decision 10). `reportFilename({ kind, params, format }, { customerName }) → 'GSTR-1 October 2026.xlsx'`.
- Produces (schemas):
  - `dashboardQuery`: strict; `preset` default `'month'`; `from`/`to` ymd required iff custom; `designerId` objectId; `priority` enum; `customerType` enum `CUSTOMER_TYPES` (`individual, business, film_production`); `fresh` `'1'`.
  - `metricRowsQuery = dashboardQuery + { cursor ≤ 500, limit 1–100 }`.
  - `reportRequestSchema`: `{ kind: enum REPORTS kinds, format: enum, params: { month?: 'YYYY-MM', from?, to?, customerId? } }`, refined per the kind's `params` and `formats`. The month may not be in the future. The range is ≤ 1 FY span (`to − from ≤ 366` days).
  - `reportListQuery { cursor, limit }`.

- [ ] **Step 1: Write the failing tests.**
  - `dashboard.test.js`:
    - `this month runs from the 1st to today and compares with the same days last month` (31 March → compare 1–28 Feb).
    - `this week starts on Monday`.
    - `this year is the financial year to date` (5 April 2027 → 2027-04-01..05; compare 2026-04-01..05).
    - `a custom range compares with the range just before it`.
    - `change is up, down or the same, and absent without a previous figure`.
    - `on-time rate counts garments ready by their original date` (rate null with none ready).
    - `pickups in three days not nearly ready are at risk`.
    - `every metric belongs to a tile and money metrics need money.view`.
  - `csv.test` (in `dashboard.test.js`): `cells that look like formulas are neutralised` (`=SUM(A1)`, `+91…`, `-5` text, `@x` → prefixed; numbers untouched); `CSV quotes commas, quotes and new lines and starts with a BOM`.
  - `catalog`: `every report has a plain label, a group and at least one format`; `GSTR-1 is Excel only`; `file names read like GSTR-1 October 2026.xlsx`; `a month or one customer is light, a year is not`.
  - `m8-schemas.test.js`: `custom needs from and to; other presets refuse them`; `a report month cannot be in the future`; `a range is at most one year`; `a statement needs a customer`; `unknown keys are refused`.
  - `production.test.js`: `isPickupAtRisk matches the daily job rule`.
- [ ] **Step 2: Run** `npx vitest run --project shared`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement**, and switch `production/daily.js` to `isPickupAtRisk` (no behaviour change; its tests still pass).
- [ ] **Step 4: Run** `npx vitest run --project shared && npm run test:tz && npx vitest run apps/api/test/production-daily.test.js && npm run lint`. Expected: PASS. (If the daily test file has another name, run the file covering `runDailyProductionChecks`.)
- [ ] **Step 5: Commit** `feat(shared): dashboard presets, metric catalog, money keys, safe CSV and report catalog (M8 Task 1)`

---

### Task 2: Shared: GSTR-1 sheets, GSTR-3B summary and ITC set-off (pure)

**Files:**
- Create: `packages/shared/src/reports/{gstr1.js,gstr3b.js,registers.js}`
- Modify: `packages/shared/src/index.js`
- Test: `packages/shared/test/gstr1.test.js`, `packages/shared/test/gstr3b.test.js`, `packages/shared/test/registers.test.js`

**Interfaces:**
- Consumes: `stateName` (states.js); `displayDate`; the **document view** shape produced by Task 3 `billingDocumentsInRange`:
  ```
  { id, type: 'invoice'|'credit_note'|'receipt'|'receipt_voucher'|'refund', status: 'issued'|'cancelled', number, date,
    customer: { id, name, gstin, stateCode, registered }, placeOfSupply: { stateCode, interState } | null,
    totals: { taxable, cgst, sgst, igst, tax, roundOff, total } | null,
    lines: [{ hsnSac, description, supplyType, unit, quantity, gstRateBp, taxable, cgst, sgst, igst }],
    original: { id, number, date, total, registered, interState } | null,     // credit notes
    amount, mode,                                                            // receipts, refunds
    advanceAdjustments: [{ stateCode, gstRateBp, taxable, cgst, sgst, igst }], // invoices: RV tax applied
    rvReversal: { taxable, cgst, sgst, igst, gstRateBp, stateCode } | null }   // refunds
  ```
- Produces (`gstr1.js`):
  - `GSTR1_COLUMNS`: sheet → header list, verbatim from the offline tool.
    - `b2b`: GSTIN/UIN of Recipient, Receiver Name, Invoice Number, Invoice date, Invoice Value, Place Of Supply, Reverse Charge, Applicable % of Tax Rate, Invoice Type, E-Commerce GSTIN, Rate, Taxable Value, Cess Amount.
    - `b2cl`: Invoice Number, Invoice date, Invoice Value, Place Of Supply, Applicable % of Tax Rate, Rate, Taxable Value, Cess Amount, E-Commerce GSTIN.
    - `b2cs`: Type, Place Of Supply, Applicable % of Tax Rate, Rate, Taxable Value, Cess Amount, E-Commerce GSTIN.
    - `cdnr`: GSTIN/UIN of Recipient, Receiver Name, Note Number, Note Date, Note Type, Place Of Supply, Reverse Charge, Note Supply Type, Note Value, Applicable % of Tax Rate, Rate, Taxable Value, Cess Amount.
    - `cdnur`: UR Type, Note Number, Note Date, Note Type, Place Of Supply, Note Value, Applicable % of Tax Rate, Rate, Taxable Value, Cess Amount.
    - `at`: Place Of Supply, Applicable % of Tax Rate, Rate, Gross Advance Received, Cess Amount.
    - `atadj`: Place Of Supply, Applicable % of Tax Rate, Rate, Gross Advance Adjusted, Cess Amount.
    - `hsn(b2b)` and `hsn(b2c)`: HSN, Description, UQC, Total Quantity, Total Value, Rate, Taxable Value, Integrated Tax Amount, Central Tax Amount, State/UT Tax Amount, Cess Amount.
    - `docs`: Nature of Document, Sr. No. From, Sr. No. To, Total Number, Cancelled.
  - Fixed values: Place Of Supply `"29-Karnataka"`. Reverse Charge `N`. Invoice Type `Regular B2B`. Note Type `C`. Note Supply Type `Regular B2B`. Rate as a percent number. Cess 0. Applicable % blank. E-Commerce GSTIN blank.
  - `UQC_BY_UNIT` (Decision 14).
  - `classifyInvoice(view, b2clThreshold) → 'b2b'|'b2cl'|'b2cs'` (Decision 14; B2CL needs `total > threshold`).
  - `gstr1Sheets({ docs, b2clThreshold, month }) → { sheets: [{ name, columns, rows }], totals: { b2b, b2cl, b2cs, cdnr, cdnur, at, atadj } }`.
    - Rows are one per document × rate.
    - B2CS and AT/ATADJ are summed per place of supply × rate.
    - Docs: per nature (`Invoices for outward supply`, `Credit Note`, `Receipt Voucher`, `Refund Voucher`) and series prefix, giving From, To, total issued + cancelled, and cancelled. Taken from `documentSeries` input `series: [{ nature, from, to, total, cancelled }]`.
    - Cancelled documents are skipped everywhere else.
- Produces (`gstr3b.js`):
  - `gstr3bSummary({ docs, itc }) → { outward: { taxable, igst, cgst, sgst }, nilRated: { taxable }, interStateUnregistered: [{ placeOfSupply, taxable, igst }], itc: { igst, cgst, sgst }, ineligible: { igst, cgst, sgst }, setOff: <gstSetOff> }`. `itc` is M5 `inputTaxSummary` (Decision 15).
  - `gstSetOff({ liability, credit }) → { creditUsed: { igst: { igst, cgst, sgst }, cgst: { cgst, igst }, sgst: { sgst, igst } }, cash: { igst, cgst, sgst }, carriedForward: { igst, cgst, sgst } }`. All values are paise and never negative.
- Produces (`registers.js`), pure row builders over views with plain column labels:
  - `salesRegisterRows(views)`: bill number, date, customer, GSTIN, place of supply, taxable, CGST, SGST, IGST, round-off, total, status. Cancelled bills show 0 values and status "Cancelled".
  - `creditNoteRows`, `voucherRows(type)`.
  - `collectionsByMode(views) → rows per date × mode` with receipts, refunds and net.
  - `dayBookRows({ billing, expenses })`: date-ordered rows, "Bill / Credit note / Payment / Refund / Expense", number, party, in, out.

- [ ] **Step 1: Write the failing tests.**
  - `gstr1.test.js`:
    - `a registered customer's bill goes to B2B, one row per rate`.
    - `the B2CL threshold is strictly greater than` (unregistered inter-state, total = threshold → b2cs; threshold + 100 → b2cl).
    - `an intra-state bill of any size is B2CS`.
    - `B2CS is summed by place of supply and rate`.
    - `credit notes on small bills reduce B2CS`.
    - `a credit note for a registered customer goes to CDNR; on a B2CL bill to CDNUR`.
    - `cancelled bills appear only in the document summary`.
    - `advances and their adjustments fill AT and ATADJ`.
    - `HSN summary splits B2B and B2C, nets credit notes and maps units` (services `NA`, qty 0).
    - `headers match the offline tool exactly`.
    - `place of supply reads 29-Karnataka; dates read 05-Oct-2026`.
  - `gstr3b.test.js`:
    - `outward supplies are bills less credit notes plus net advances`.
    - `zero-rated lines go to nil-rated`.
    - `inter-state supplies to unregistered persons are listed by state`.
    - `IGST credit is used first, then CGST and SGST credit` (table of 4 cases incl. leftover carried forward; no head negative).
    - `CGST credit never pays SGST`.
  - `registers.test.js`:
    - `the sales register shows cancelled bills at zero`.
    - `collections by mode net refunds per day`.
    - `the day book interleaves bills, payments and expenses by date`.
- [ ] **Step 2: Run** `npx vitest run --project shared`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project shared && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): GSTR-1 sheets, GSTR-3B summary with ITC set-off and register rows (M8 Task 2)`

---

### Task 3: API: billing report data (period money, ageing, advances, document views)

**Files:**
- Create: `apps/api/src/modules/billing/reports.js`
- Modify: `apps/api/src/modules/billing/service.js` (re-export)
- Test: `apps/api/test/billing-reports.test.js`

**Interfaces:**
- Consumes: billing models, `paginate`, `getCustomerNames`, `getOrderNumbers` (orders service), `ageingBucket` (`@vs/shared/billing.js`), `istDate(clock.now())` (billing's `todayIst` is private to `ledger.js`).
- Produces (all re-exported by `billing/service.js`). `customerFilter` is `{ in } | { notIn } | undefined` from Task 4.
  - `periodMoney(branchId, { from, to, customerFilter }) → { billed, invoices, credited, creditedTaxable, taxable, collected, receipts, refunded }`: one `$group` by `type` on `register`, issued only. `taxable` is invoice `totals.taxable`.
  - `monthlyMoney(branchId, { from, to }) → [{ month, billed, collected }]`: one aggregate by `month`. Months with nothing are present with 0.
  - `receivablesAgeing(branchId, { customerFilter, top = 5 }) → { count, outstanding, overdueAmount, buckets: { not_due, d0_30, d31_60, d61_90, d90_plus }, topCustomers: [{ id, name, balance, oldestDays }] }`: one `$facet` on `receivables`.
  - `advancesHeld(branchId) → { advancesHeld, customers }` and `advancesByCustomer(branchId, { cursor, limit }) → { items: [{ customer: { id, name }, received, allocated, advancesHeld }], nextCursor }`. Both are Σ issued receipts − Σ allocations grouped by customer, keeping only those > 0. Receipts use `register`, allocations use `(branchId, customerId, date)`.
  - `orderPaymentStatuses(branchId, orderIds) → Map<orderId, { status: 'paid'|'part_paid'|'unpaid'|'advance_only'|'nothing_yet', balance, advancesHeld }>`: at most 200 ids; `order_docs` index.
  - `invoicedOrderIds(branchId, { from, to, limit = 100 }) → [orderId]`: most recent first, distinct.
  - `billingDocumentsInRange(branchId, { types, from, to }) → AsyncIterable<view>`: Task 2 view shape. Covers issued and cancelled, by `date` on `register`, via a Mongoose cursor with a fixed projection. Credit notes get `original` from their invoice (one batched `_id $in` per 200 notes).
  - `documentSeries(branchId, { from, to }) → [{ nature, prefix, from, to, total, cancelled }]`: an aggregate grouped by type and prefix, with min/max number by sequence.
  - `moneyRows(branchId, metric, { from, to, customerFilter, cursor, limit })` serves the drill-down rows for `billed` (invoices), `collected` (receipts), `overdue_bills` and `outstanding` (receivables), each paginated with the same filter as its figure.
- Comment at the top of `reports.js`: these functions are only for the dashboard and reports. They are read-only and go by document date.

- [ ] **Step 1: Write the failing tests.**
  - `period money adds up bills, credit notes, payments and refunds by document date` (a cancelled bill counts 0).
  - `a customer type filter keeps only those customers' documents`.
  - `months without bills show zero`.
  - `ageing buckets and the top customers match the money owed list` (equal to `listReceivables` totals).
  - `advances held equals the sum of customers' advances` (equal to Σ `customerMoneySummary().advanceHeld`; the built field is singular).
  - `order payment status is paid, part paid, unpaid, advance only or nothing yet`.
  - `document views carry lines, place of supply and the original bill of a credit note`.
  - `document series give first, last, count and cancelled per series`.
  - `money drill-down rows sum to the figure`.
  - `billing report queries use indexes` (`explain` on each aggregate's `$match` and finds: no `COLLSCAN`).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/billing-reports.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/billing-reports.test.js apps/api/test/billing-ledger.test.js && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): billing figures and document views for the dashboard and reports (M8 Task 3)`

---

### Task 4: API: order, garment, customer, production, expense, stock and enquiry data for M8

**Files:**
- Create: `apps/api/src/modules/orders/reports.js`, `apps/api/src/modules/production/reports.js`
- Modify:
  - `apps/api/src/modules/orders/{model.js,service.js}`, `apps/api/src/modules/customers/{model.js,service.js}`, `apps/api/src/modules/production/service.js`
  - `apps/api/src/modules/stock/{queries.js,service.js}` (M6: the function and its re-export; stock imports no other business module, and still will not)
  - `apps/api/src/modules/enquiries/queries.js` and `packages/shared/src/schemas/frontOffice.js` (`enquiryListQuery`) (M7)
- Test: `apps/api/test/module-data.test.js`

**Interfaces:**
- Consumes: `orderScope` (orders service), `paginate`, `getCustomerNames`, `getUserNames`, `getVendorNames`, M5 `expenseCostTotal`.
- Produces:
  - **Order indexes:** `by_order_date (branchId, orderDate, _id)`. **Garment index:** `ready (branchId, readyDate)` partial `{ readyDate: { $type: 'string' } }`. **Customer index:** `by_type (branchId, type)`.
  - `customers/service.js`: `customerIdsOfType(branchId, type) → { in: ObjectId[] } | { notIn: ObjectId[] }` (Decision 7). More than 5,000 → 422 `FILTER_TOO_BROAD` "Too many customers for this filter".
  - `orders/reports.js` (re-exported). `user` scopes everything via `orderScope`:
    - `orderCounts(branchId, user, { from, to, designerId, priority, customerFilter }) → { placed, byPriority: { normal, rush } }`: one aggregate on `by_order_date`.
    - `listOrdersPlaced(branchId, user, { …same, cursor, limit })`: rows as `listOrders` items.
    - `activeOrderCount(branchId, user, { designerId, priority, customerFilter })` and `onHoldOrders(branchId, user, filters, { cursor, limit })`.
    - `garmentsReadyBetween(branchId, user, { from, to, designerId, priority, customerFilter }) → { items: [{ garmentId, garmentNo, orderId, orderNo, designerId, readyDate, dueDate, onTime }], truncated }`: Decision 18, cap 5000.
    - Every function **AND-combines** `designerId` with `orderScope(user)`, as `listOrders` does.
  - `production/reports.js` (re-exported):
    - `qcFailures(branchId, user, { since }) → [{ garmentId, garmentNo, orderId, stage, at, reason }]`: `(branchId, action, at)` index, last failure per garment, open garments in scope only, cap 200.
    - `vendorOnTime(branchId, { from, to }) → [{ vendorId, name, returned, onTime }]`: `returned_from_vendor` events in range, each matched to the latest earlier `sent_to_vendor` of that garment and stage; on time when the return date (IST) ≤ `dueBackDate`.
  - `expenses` (M5, already built, nothing to add): `expenseCostTotal(branchId, { from, to }) → { cost, purchaseCost }` (one aggregate on `by_date` over active expenses; `purchaseCost` = `source: 'purchase'`). Operating expense cost = `cost − purchaseCost`.
  - `stock` (M6): `listMovementsByDate(branchId, { from, to, cursor, limit }) → { items: [{ id, date, type, item: { id, name, usageUnit }, quantity, valueChange, reference, reason }], nextCursor }` on `by_date (branchId, date, type)`. Add it to `stock/queries.js` and re-export it from `stock/service.js`. Item names come from the stock module's own `StockItem`, and `reference.garmentNo` from its `garmentNumbers`, so no other module is read.
  - `enquiries` (M7): `enquiryListFilter`, `listEnquiries` (its signature stays `(branchId, filters, { today })`) and `enquiryListQuery` accept `source` and `from`/`to` (on `enquiryDate`, `by_date`). Used by the `enquiry_sources` drill-down.

- [ ] **Step 1: Write the failing tests** (`module-data.test.js`).
  - `orders placed are counted by order date in the user's scope`.
  - `a designer filter cannot widen a designer's scope` (designer A with `designerId` = B → A's own or none).
  - `priority and customer type filters narrow orders`.
  - `customer type individual excludes business and film customers`.
  - `garments ready in a period are on time by their original due date` (a moved pickup date still uses the original).
  - `QC failures in the last seven days on open garments`.
  - `vendor returns are on time by the due-back date`.
  - `operating expense cost leaves out stock purchases and claimable GST`.
  - `stock movements list by date across items`.
  - `enquiries filter by source and date`.
  - `M8 data queries use indexes` (`explain` for each new find or aggregate).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/module-data.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project api && npm run lint`. Expected: PASS (new indexes break nothing).
- [ ] **Step 5: Commit** `feat(api): order, garment, production, expense, stock and enquiry figures for M8 (M8 Task 4)`

---

### Task 5: API: dashboard module, context, cache and the order and production tiles

**Files:**
- Create: `apps/api/src/modules/dashboard/{filters.js,cache.js,service.js,json.js,routes.js,metrics/index.js,metrics/attention.js,metrics/keyNumbers.js,metrics/production.js}`, `apps/api/test/helpers/dashboard.js`
- Modify: `apps/api/src/app.js`
- Test: `apps/api/test/dashboard-tiles.test.js`

**Interfaces:**
- Consumes:
  - Task 1: `presetRange`, `comparisonRange`, `METRICS`, `DASHBOARD_TILES`, `onTimeRate`, `isPickupAtRisk`, `changeOf`. Existing in `@vs/shared/production.js`: `isGarmentLate`.
  - Task 4 functions, `productionBoard`, `listProductionGarments(branchId, user, { designerId, … }) → { items, truncated }` (each item already carries `late`, `nearlyReady`, `workingStage`, `vendorName`, `designerName`), `customerIdsOfType`.
  - M7: `appointmentsForDay(branchId, user, { date })`, `followUpsDue(branchId, today) → { count, overdue }`. M6: `lowStockItems(branchId, { limit })` (raw docs). Task 3: `receivablesAgeing`, `orderPaymentStatuses`.
- Produces:
  - `filters.js`: `buildContext(user, query, { today }) → ctx = { branchId, user, today, preset, range: { from, to }, previous: { from, to }, designerId, priority, customerType, customerFilter, money: boolean, scopeKey }`. Over 400 days → 422 `RANGE_TOO_LONG`.
  - `cache.js`: `cached(key, fn, { ttlMs = 60_000, fresh = false }) → Promise`. Uses `clock.now()`, holds at most 500 entries (oldest evicted), shares one promise between concurrent callers, and never caches a rejection.
  - `metrics/index.js`: `registerMetric(def)`, `metricsFor(user) → defs` (filtered by `permission`, and by `money.view` when `money`). A metric def is `{ id, figure(ctx) → { value, sub? , truncated? }, rows(ctx, { cursor, limit }) → { items, nextCursor, sum? } }`.
  - Open garments are read **once per request**: `ctx.openGarments()` memoises `listProductionGarments(branchId, user, { designerId })`, post-filtered by priority and customer filter. The read is capped at 1,000 garments by `listOpenGarments`; its `truncated` flag is passed on to every figure derived from it. The attention, key-number, production, pickups and workload metrics all derive from it.
  - Metrics in this task:
    - `late_garments`, `pickups_at_risk`, `vendor_overdue`, `qc_failed` (Decision 8).
    - `fittings_today` (M7 day view, cards with `type === 'fitting'`; the day view already leaves cancelled ones out).
    - `follow_ups_due` (`enquiries.write`; `followUpsDue().count`), `low_stock` (`stock.view`; `lowStockItems(branchId, { limit: 501 })`, `truncated` over 500), `on_hold_orders`.
    - `overdue_bills` (`money.view`; count + `overdueAmount` from `receivablesAgeing`).
    - `active_orders`, `orders_placed` (periodic), `on_time` (periodic).
    - `stage_garments` (production board; rows per stage via `?stage=` param), `upcoming_pickups` (next 14 days, payment status only with `money.view`).
    - `workload_designers`, `workload_vendors`. Counts of open garments by designer and vendor, plus on-time rate per designer from `garmentsReadyBetween`. Designers see only themselves.
  - `service.js`: `dashboardFor(user, query) → { asOf, range, previous, filters, tiles: { [tileId]: { metrics: { [metricId]: figure+change }, notFilteredBy: [] } | { error: 'UNAVAILABLE' } } }`. Periodic metrics get `change = changeOf(current, figure(ctx with previous range))`. Tiles with no permitted metric are absent.
  - `routes.js`: `dashboardRouter()` at `/v1/dashboard`. `GET /` (any signed-in user; `validate({ query: dashboardQuery })`) → `dashboardFor`.
  - Test helper `helpers/dashboard.js`: `dashboardWorld(app)` → admin, operations, two designers, customers of each type, orders across both designers with late, at-risk, vendor and QC garments, bills, payments, an expense, a stock item and an appointment. It uses the existing billing, production, expenses helpers and service calls only.

- [ ] **Step 1: Write the failing tests** (`dashboard-tiles.test.js`).
  - `Home shows the attention list with late, at-risk, vendor-overdue and QC-failed garments`.
  - `today's fittings and follow-ups due appear for front desk`.
  - `key numbers count active orders, orders this month and on-time rate with change vs last month`.
  - `the production board counts garments per stage in house and with vendors`.
  - `upcoming pickups show payment status only to money users`.
  - `workload counts garments per designer and vendor`.
  - `filters narrow order tiles and are reported on tiles they do not touch`.
  - `a range over 400 days is refused`.
  - `figures are cached for a minute per scope and fresh=1 recomputes` (`vi.spyOn` on a metric's figure: 1 call for 2 requests, 2 calls with `fresh`; designer and operations each compute their own).
  - `a failing tile shows unavailable and the rest still load`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/dashboard-tiles.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**, and mount `dashboardRouter()` in `app.js`.
- [ ] **Step 4: Run** `npx vitest run apps/api/test/dashboard-tiles.test.js && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): dashboard with attention list, key numbers, production, pickups and workload (M8 Task 5)`

---

### Task 6: API: money, expenses, stock, enquiries, calendar and profit tiles; daily snapshot

**Files:**
- Create: `apps/api/src/modules/dashboard/{model.js,snapshots.js,jobs.js,metrics/money.js,metrics/front.js,metrics/stock.js,metrics/expenses.js,metrics/profit.js}`
- Modify: `apps/api/src/modules/dashboard/{service.js,metrics/keyNumbers.js}`, `apps/api/src/jobs.js`
- Test: `apps/api/test/dashboard-tiles.test.js` (extend), `apps/api/test/dashboard-snapshots.test.js`

**Interfaces:**
- Consumes:
  - Task 3: `periodMoney`, `monthlyMoney`, `receivablesAgeing`, `advancesHeld`, `invoicedOrderIds`.
  - M5: `expenseTotalsByCategory`, `expenseCostTotal`. M6: `stockValuation`, `stockItemProfit`, `materialCostTotal`, `lowStockItems` (stock service) and `orderProfits` (**costing service**).
  - M7: `enquiryConversionBySource`, `appointmentsForDay`. Settings: category labels.
- Produces:
  - Metrics:
    - `billed` (sub: credited), `collected` (sub: refunded), `outstanding`, `overdue_amount`, `advances_held`.
    - `month_money`: the last 6 months including the current one, or the FY months for preset `fy`.
    - `receivables_ageing`: buckets and top 5 who owe.
    - `appointments_today`: by designer (`appointments.own`, scoped by M7).
    - `stock_low`, `stock_reserved` (`reservedValue`), `stock_item_profit` (the dashboard sorts `stockItemProfit` rows by profit and keeps the top 5; items with no selling price listed as "No selling price"). `stock_reserved` and `stock_item_profit` are money metrics (`money: true`), so a user with `stock.view` but no `money.view` sees the stock tile with `stock_low` only, as M6's own routes strip stock values.
    - `enquiry_sources` (total, converted, conversion %).
    - `expense_categories` (`expenseTotalsByCategory` rows `{ category: key, total, count }`, labels added from `readSettings().expenseCategories`; `expenses.view`).
    - `profit` (Decision 6: `{ revenue, material, expenses, profit }`) and `order_profits` (lowest 5 and highest 5). Both need `costing.view`.
  - `model.js`: `DashboardSnapshot { branchId, date, figures: { activeOrders, lateGarments, outstanding, overdueAmount, advancesHeld } }`, unique `(branchId, date)`.
  - `snapshots.js`:
    - `takeSnapshot(branchId, date)` is an upsert. Figures come from the whole-branch metric figures with a system user that has `orders.read.all` and `money.view`.
    - `snapshotNear(branchId, date) → figures | null`: the latest snapshot with `date ≤ target` and `date ≥ target − 7`.
  - `jobs.js`: `defineJob('dashboard-snapshot', { schedule: '*/30 * * * *', handler })`. It snapshots each branch once its IST time is ≥ 23:30 and today's snapshot is missing. Idempotent.
  - Point-in-time key numbers get `change` from `snapshotNear(today − 1 month)` only when the context is unfiltered and has whole-branch scope (Decision 4).

- [ ] **Step 1: Write the failing tests.**
  - `money tiles show billed, collected, owed, overdue and advances with credit notes and refunds as sub-lines`.
  - `billed against collected by month has every month, even empty ones`.
  - `expenses this month by category with labels`.
  - `stock tile shows low items, money reserved for orders and profit per item`.
  - `enquiries by source with conversion`.
  - `today's calendar groups appointments by designer`.
  - `profit is net taxable revenue less materials used and running costs, not stock purchases` (receive stock ₹5,000 with a purchase expense, use ₹2,000 of it → profit counts ₹2,000 once).
  - `per-order profit lists the lowest and highest of the latest invoiced orders`.
  - `profit is for admins only` (operations: no `profit` tile).
  - `dashboard-snapshots.test.js`: `a snapshot is taken once a day after 23:30`; `outstanding compares with the snapshot a month ago`; `no snapshot, no change line`; `filtered views show no change on point-in-time figures`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/dashboard-tiles.test.js apps/api/test/dashboard-snapshots.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**, and import `modules/dashboard/jobs.js` in `jobs.js`.
- [ ] **Step 4: Run** the same command, then `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): money, expenses, stock, enquiries, calendar and profit tiles with month-ago snapshots (M8 Task 6)`

---

### Task 7: API: drill-down rows, figure-equals-rows proof and the dashboard permission matrix

**Files:**
- Modify: `apps/api/src/modules/dashboard/{service.js,routes.js,json.js,metrics/*.js}`
- Test: `apps/api/test/dashboard-drill.test.js`, `apps/api/test/dashboard-permissions.test.js`

**Interfaces:**
- Consumes: Tasks 5–6; Task 3 `moneyRows`; Task 4 list functions; M5 `listExpenses` (cursor-paged, active by default); M6 `listItems(branchId, { low: true, cursor, limit })`; M7 `listEnquiries(branchId, { view: 'follow_ups', cursor, limit }, { today })` and `appointmentsForDay`.
  - Rows for `fittings_today` and `appointments_today` come from `appointmentsForDay` (one day, so no paging), not `listAppointments`, which has no `type` filter.
  - Every row is built from a whitelist, never by spreading a raw doc: stock docs carry `value`, `avgCost` and `sellingPrice`, and enquiries carry `phone` and `budget`.
- Produces:
  - `metricRows(user, metricId, query) → { metric: { id, label, value }, items: [row], nextCursor, columns }`. 404 for an unknown or unpermitted metric, so it does not reveal that the metric exists. `items` use the same filter as the figure.
  - Every row is `{ id, title, subtitle, amount? , date?, badge?, link }` (`link` is the app path of the record, e.g. `/orders/:id`, `/bills/:id`, `/expenses/:id`). `amount` is present only with `money.view`.
  - Metrics with a breakdown take `?key=` (stage, category, source, designerId, vendorId, month, bucket) and list the rows of that bar.
  - Route: `GET /v1/dashboard/metrics/:metric/rows` (`validate({ query: metricRowsQuery })`).
  - Route table test: every `/v1/dashboard` route × role, asserted equal to the declared routes (M4 Task 13 pattern).
  - Import test, in the style of M6's `the stock service imports no other business module` (`stock-ledger.test.js`, which reads each file's import specifiers): no file outside `modules/dashboard` and `modules/reports` imports them, and neither imports a `model.js` of another module.

- [ ] **Step 1: Write the failing tests.**
  - `dashboard-drill.test.js`:
    - `every figure equals the sum of its drill-down rows`. Use `it.each` over every metric in `METRICS` the admin sees, with presets `month` and `fy` and filters none / designer / customerType=business. A count compares with the row count over all pages, an amount with Σ `amount`, and a breakdown with each key's rows.
    - `rows link to the record behind them`.
    - `paging never repeats a row`.
    - `an unpermitted metric is not found`.
  - `dashboard-permissions.test.js`:
    - `designers never receive a money field anywhere on Home`. Walk the full `GET /v1/dashboard` and every metric rows response a designer can reach, asserting no `MONEY_KEYS` key at any depth.
    - `designers see only their own garments, appointments and on-time rate`.
    - `a designer filter cannot widen a designer's scope`.
    - `operations see money but not profit`.
    - `admins see every tile`.
    - `the dashboard route table matches the router`.
    - `dashboard and reports never import another module's model`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/dashboard-drill.test.js apps/api/test/dashboard-permissions.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the rows for each metric. Fix any figure the equality test exposes in the figure, never in the test.
- [ ] **Step 4: Run** `npx vitest run --project api && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): tap any dashboard number to see the records behind it; designer view proven money-free (M8 Task 7)`

---

### Task 8: API: reports module: runs, background builder, Excel/CSV files, audited downloads

**Files:**
- Create: `apps/api/src/modules/reports/{model.js,service.js,runner.js,writers.js,builders/index.js,builders/registers.js,jobs.js,json.js,routes.js}`, `apps/api/test/helpers/reports.js`
- Modify: `apps/api/package.json` (`exceljs: 4.4.0`; not installed yet), `apps/api/src/core/files/{storage-local.js,storage-s3.js,devFilesRoutes.js,purposes.js}`, `apps/api/src/app.js`, `apps/api/src/jobs.js`
- Test: `apps/api/test/reports-runs.test.js`, `apps/api/test/files.test.js`

**Interfaces:**
- Consumes: Task 1 `REPORTS`, `isLight`, `reportFilename`, `toCsv`, `safeCell`; Task 2 register rows; Task 3 `billingDocumentsInRange`; `recordAudit`, `withTransaction`, `idempotent`, `actorFrom` and `requirePermission` (`core/auth/middleware.js`), `getCustomer`. `respondCommitted` is **not shared**: billing, expenses, enquiries and appointments each keep a local one in their `routes.js`, so `reports/routes.js` gets its own (a 202 whose read-back failure falls back to `{ id, status }`).
- Produces:
  - Storage: `putObject({ key, body, contentType, contentDisposition? })`. S3 sets `ContentDisposition`; local stores it in `.meta.json`, `headObject` returns it, and `devFilesRoutes` sends it as the header.
  - `purposes.js`: `registerFilePurpose('reports', { allowedTypes: [], canWrite: () => false, canRead: (u) => u.permissions.has('reports.export') })`. Nobody can upload one. Reads go through `/v1/reports/:id/download`, and `/v1/files/url` also enforces `reports.export`.
  - `model.js`: `ReportRun { branchId, kind, format, params: { month, from, to, customerId }, status: 'queued'|'running'|'done'|'failed', source: 'manual'|'schedule', attempts, claimedAt, startedAt, finishedAt, error: { code, message } | null, file: { key, filename, contentType, size, sha256 } | null, extraFiles: [same] (gst_pack), rows, rowsHash, requestedBy }` + `commonFields`.
    - Indexes: `recent (branchId, createdAt, _id)`; `queue (status, createdAt)` partial `{ status: { $in: ['queued','running'] } }`; `schedule_unique (branchId, kind, params.month, source)` unique partial `{ source: 'schedule' }`.
  - `writers.js`:
    - `toXlsx(sheets) → Buffer`: exceljs `WorkbookWriter`, bold frozen header row, money `numFmt`, `safeCell` on text, sheet names ≤ 31 chars, workbook `created` = run `startedAt`.
    - `toCsvBuffer(sheet) → Buffer`.
    - `REPORT_MAX_ROWS = 200_000` → `REPORT_TOO_LARGE`.
  - `builders/index.js`: `registerBuilder(kind, async (branchId, params, { storage }) → { sheets } | { pdf: Buffer })`. This task registers `sales_register` (Task 2 rows over `billingDocumentsInRange(['invoice'])`). Tasks 9–10 add the rest.
  - `runner.js`:
    - `claimRun({ id } | {}) → run | null`: atomic `queued → running`. A run stuck `running` more than 30 min is re-queued, or marked `failed` (`STUCK`) after 2 attempts.
    - `buildRun(run, { storage })` → builds, writes, `putObject`, `rowsHash = sha256(canonical JSON of sheets rows)`, `done`. Errors become `failed` with a plain code (`REPORT_TOO_LARGE`, `REPORT_FAILED`), and nothing personal is logged.
  - `service.js`:
    - `requestReport(branchId, input, actor, { storage }) → run`. Validated, audit `request`. Light kinds start at once (`setImmediate(() => claimRun({ id }).then(buildRun))`).
    - `getRun(branchId, id)`; `listRuns(branchId, { cursor, limit })`, last 90 days.
    - `downloadLink(branchId, id, actor, { storage }) → { url, filename, expiresIn: 300 }`: `done` only (else 422 `REPORT_NOT_READY`), audit `download`.
    - `runPendingReports({ storage, limit = 3 })`.
  - `jobs.js`: `defineJob('reports-run', { schedule: '1 minute', quiet: true, handler: ({ storage }) => runPendingReports({ storage }) })`.
  - `json.js`: `toRunJson(run, { names, labels }) → { id, kind, label, format, params, status, filename, size, rows, error, requestedBy: { id, name }, createdAt, finishedAt }`.
  - Routes, `reportsRouter(storage)` at `/v1/reports`, all `reports.export`:
    - `GET /catalog` → `{ reports: REPORTS }`.
    - `POST /` (`validate({ body: reportRequestSchema })`, `idempotent()`) → 202 `{ report }` (respondCommitted).
    - `GET /` → `{ items, nextCursor }`.
    - `GET /:id` → `{ report }`.
    - `GET /:id/download` → `{ url, filename }`.

- [ ] **Step 1: Write the failing tests.**
  - `reports-runs.test.js`:
    - `a month's sales register is ready in a moment as Excel and as CSV`. Request, poll, then download. Parse the XLSX with exceljs and the CSV text, and check rows equal the bills.
    - `a year's report waits for the worker`. Stays `queued` until `runPendingReports`.
    - `asking twice with one key makes one file`.
    - `the API and the worker never build the same report twice` (two concurrent `claimRun`: one wins).
    - `a stuck report is retried, then marked failed`.
    - `a report over the row limit fails with a plain message`.
    - `report files are admin only, even by key`. Operations and designers get 403 on every route, and `GET /v1/files/url?key=<report key>` is 404 for them (the key matches the files key pattern, so the purpose's `canRead` is what refuses).
    - `each download link is audited` (audit entries `report`/`request` and `report`/`download`; chain verifies).
    - `cells that look like formulas are neutralised in the file`.
    - `the file downloads under its friendly name` (local storage serves `Content-Disposition`).
    - `the reports route table matches the router`.
  - `files.test.js`: `nobody can upload a report file`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/reports-runs.test.js apps/api/test/files.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Run `npm install exceljs@4.4.0 -w apps/api`, then mount the router and import the job.
- [ ] **Step 4: Run** `npx vitest run apps/api/test/reports-runs.test.js apps/api/test/files.test.js apps/api/test/billing-pdf.test.js && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): reports prepared in the background as Excel or CSV with audited 5-minute downloads (M8 Task 8)`

---

### Task 9: API: GST reports (GSTR-1 workbook, GSTR-3B summary) and locked-month reproducibility

**Files:**
- Create: `apps/api/src/modules/reports/builders/gst.js`
- Modify: `apps/api/src/modules/reports/builders/index.js`
- Test: `apps/api/test/reports-gst.test.js`

**Interfaces:**
- Consumes: Task 2 `gstr1Sheets`, `gstr3bSummary`; Task 3 `billingDocumentsInRange`, `documentSeries`; M5 `inputTaxSummary`; `readSettings` (`b2clThreshold`); `getBranch` (GSTIN in the sheet title row of 3B only, never in GSTR-1 sheets).
- Produces:
  - Builder `gstr1` → the offline-tool sheets only.
  - Builder `gstr3b` → one sheet "GSTR-3B summary": rows 3.1(a), 3.1(c), 3.2 per state, 4(A)(5), ITC not claimable (information), then "Tax to pay in cash" and "Credit carried forward" per head, ending with the line "Estimate. Your accountant confirms before filing."
  - `gstMonthDocs(branchId, month) → { docs, series }`, shared with Task 11.

- [ ] **Step 1: Write the failing tests.**
  - `the GSTR-1 file has the offline tool's sheets and headers`.
  - `a month with B2B, B2CL, B2CS bills, credit notes, an advance and a cancelled bill lands in the right sheets` (an end-to-end seed through the billing services, with expected rows written by hand).
  - `documents count in the month of their date` (bill dated 31 Oct issued at 00:30 IST on 1 Nov → October).
  - `a locked month gives identical GST files`. Lock October, build GSTR-1 and 3B, make November activity (bills, a credit note against an October bill), build again: same `rowsHash`.
  - `GSTR-3B uses claimable expense GST and shows tax to pay after set-off`.
  - `a month with nothing gives empty sheets with headers` (not an error).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/reports-gst.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/reports-gst.test.js apps/api/test/reports-runs.test.js && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): GSTR-1 workbook and GSTR-3B summary from issued documents and expense ITC (M8 Task 9)`

---

### Task 10: API: registers, ledgers and business reports

**Files:**
- Create: `apps/api/src/modules/reports/builders/{ledgers.js,business.js}`
- Modify: `apps/api/src/modules/reports/{builders/registers.js,builders/index.js,writers.js}`
- Test: `apps/api/test/reports-registers.test.js`

**Interfaces:**
- Consumes:
  - Task 2 register rows; Task 3 `billingDocumentsInRange`, `advancesByCustomer`, `listReceivables`, `customerLedger`, `customerMoneySummary`, `invoicedOrderIds`; Task 4 `garmentsReadyBetween`, `vendorOnTime`, `listMovementsByDate`.
  - M5 `listExpenses` (cursor-paged raw docs; active only unless `status: 'all'`, which the register's status column would need; `monthSummary`/`expenseTotalsByCategory` supply the "By category" totals, `inputTaxSummary` the input GST); M6 `stockValuation`, `stockItemProfit` (stock service) and `orderProfits` (costing service, 100 ids a call); M7 `enquiryConversionBySource`; `renderPdf` (`core/pdf/render.js`).
- Produces builders, each paging through cursors (no unbounded `find`):
  - **Registers:**
    - `credit_note_register`, `receipt_voucher_register`, `refund_register`, `collections_by_mode`, `advances_held`.
    - `expense_register`: number, date, category label, payee, GSTIN, bill no., before GST, CGST, SGST, IGST, total, ITC yes/no, mode, status. A second sheet "By category" holds totals with input GST.
    - `stock_movements`, `stock_valuation`.
  - **Ledgers:**
    - `customer_statement`: XLSX sheet, or a PDF via `writers.toPdf(statementDoc)` with branch header, period, opening balance, rows and closing balance.
    - `receivables_ageing`: per customer × bucket.
    - `day_book`.
  - **Business:**
    - `order_profitability`: orders invoiced in range in chunks of 100 via `orderProfits`, giving order no., customer, revenue, materials, other costs and profit.
    - `on_time`: two sheets, "By designer" and "By vendor".
    - `enquiry_conversion`, `stock_item_profit`.

- [ ] **Step 1: Write the failing tests.**
  - `each register matches the documents of the period` (`it.each` over register kinds; row totals equal `periodMoney` figures).
  - `the expense register shows input GST by category without voided expenses`.
  - `a customer statement opens and closes with the ledger balance, as Excel and as PDF` (PDF starts with `%PDF`).
  - `ageing by customer matches money owed`.
  - `the day book lists bills, payments, refunds and expenses by date`.
  - `order profitability matches costing for each order`.
  - `on time by designer and vendor`.
  - `enquiry conversion and profit per stock item for a period`.
  - `long reports read page by page` (`vi.spyOn` on the list functions: called with `limit ≤ 100`).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/reports-registers.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/reports-registers.test.js && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): registers, customer statement, ageing, day book and business reports (M8 Task 10)`

---

### Task 11: API: monthly GST pack emailed on the 2nd

**Files:**
- Create: `apps/api/src/modules/reports/{gstPack.js,notifications.js}`
- Modify: `apps/api/src/modules/reports/{jobs.js,runner.js,builders/index.js}`
- Test: `apps/api/test/reports-gst-pack.test.js`

**Interfaces:**
- Consumes: Tasks 8–10; `emit`, `defineEvent`, `listBranchIds`, `istDate`, `istTime`, `clock`.
- Produces:
  - Builder `gst_pack` → `file` = GSTR-1 workbook, `extraFiles[0]` = "GST summary and registers" workbook (Decision 16).
  - `gstPack.js`: `queueMonthlyPacks({ now }) → { queued }`. From the 2nd at 09:00 IST, it inserts a `source: 'schedule'` run for the previous month per branch. An E11000 on `schedule_unique` means it already exists, so the job is idempotent.
  - `notifications.js`: `defineEvent('reports.gst_pack', { recipients: ['owner'], channels: ['in_app','email'], templates: STAFF('Your GST files for {month}', 'Your GST files for {month} are ready: GSTR-1 and the GST summary with registers.\nAfter filing, lock {monthShort} in Accounts → Month locks.') })`. `vars.link: '/accounts'` (the way the other events carry their link), as in Decision 16. `STAFF` is a small local helper, as in `billing/notifications.js`; `defineEvent` comes from `core/notify/catalog.js`.
  - When a `gst_pack` run with `source: 'schedule'` finishes `done`, the runner emits it in the run's completion transaction with `refId: 'gst_pack:<month>'` and `attachments: [{ key, filename }]` for both files. A `failed` scheduled run emits `reports.gst_pack_failed` to the owner ("We could not prepare your GST files for {month}. Open Reports to try again.", with `vars.link: '/reports'`).
  - `jobs.js`: `defineJob('reports-gst-pack', { schedule: '*/15 * * * *', handler: () => queueMonthlyPacks() })`.

- [ ] **Step 1: Write the failing tests.**
  - `on the 2nd at 9 the previous month's pack is prepared and emailed with two files` (fake clock 2026-11-02 09:00 IST: outbox entries with both attachment keys; the email file adapter receives 2 attachments).
  - `before 9 on the 2nd nothing is queued`.
  - `running the job again sends nothing twice`.
  - `a pack that fails tells the owner`.
  - `the 1 April pack covers March of the previous financial year`.
  - `a pack made by hand does not stop the scheduled one, and is not emailed`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/reports-gst-pack.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project api && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): monthly GST pack emailed to the owner on the 2nd (M8 Task 11)`

---

### Task 12: Web: Home dashboard at 390 px

**Files:**
- Create:
  - `apps/web/src/components/charts/{BarPair.jsx,HBars.jsx,StatTile.jsx,chartTokens.css}`
  - `apps/web/src/features/dashboard/{dashboardApi.js,DashboardPage.jsx,FilterBar.jsx,AttentionList.jsx,KeyNumbers.jsx}`
  - `apps/web/src/features/dashboard/tiles/{ProductionTile.jsx,PickupsTile.jsx,MoneyTile.jsx,CalendarTile.jsx,StockTile.jsx,EnquiriesTile.jsx,WorkloadTile.jsx,ExpensesTile.jsx,ProfitTile.jsx}`
- Modify: `apps/web/src/features/home/HomePage.jsx` (renders `DashboardPage`), `apps/web/src/features/home/HomePage.test.jsx` (its M5/M7 cases are replaced by the dashboard cases below), `apps/web/src/test/server.js` (a default `GET /v1/dashboard` handler: the test server runs with `onUnhandledRequest: 'error'`, and `/` is rendered by several other test files), `apps/web/src/lib/errorMessages.js`
- Test: `apps/web/src/features/dashboard/dashboard.test.jsx`, `apps/web/src/components/charts/charts.test.jsx`

**Interfaces:**
- Consumes: `GET /v1/dashboard`; `Money`, `DateLabel`, `EmptyState`, `PageHeader`; `useAuth().can`; `formatINR`; `METRICS`, `PRESETS`.
- Produces:
  - `dashboardApi.js`: `useDashboard(filters)`. TanStack `staleTime 60_000`, key `['dashboard', filters]`, `refresh()` refetches with `fresh=1`. `useMetricRows(metric, filters, key)` is infinite.
  - Filters live in the URL (`?preset=&from=&to=&designerId=&priority=&customerType=`) so Back keeps them. The last preset is remembered in `localStorage` (try/catch).
  - `DashboardPage`, top to bottom at 390 px, single column (two columns of tiles at ≥ 992 px):
    1. Greeting, "Updated 1 min ago" with a Refresh icon button, and the quick buttons the M7 Home has today, each by its permission: "New enquiry" (`enquiries.write`, `/enquiries/new`), "Book appointment" (`appointments.write`, `/appointments/new`) and "Add expense" (`expenses.write`, `/expenses/new`).
    2. `FilterBar`: preset chips "Today / This week / This month / This year / Custom" in a horizontally scrollable row. "Custom" opens two date inputs. A "Filters" button (admin and operations) opens a drawer with Designer, Priority and Customer type, and the count of active filters shows on the button.
    3. `AttentionList` "Needs attention today": only items with count > 0, each a 56 px row with an icon, plain sentence ("3 garments are late", "2 bills are overdue — ₹48,000") and a chevron. Tapping goes to `/home/<metric>`. When all counts are zero it shows "Nothing needs you right now."
    4. `KeyNumbers`: `StatTile` grid, 2 per row on phones. Each tile has the label, a big value, and a change line with an arrow icon and words ("up ₹12,400 vs last month"; "same as last month"). Tapping opens the drill-down.
    5. Tiles in `DASHBOARD_TILES` order, each a card with a title, a one-line plain explanation, its chart or list, and "See all" to the drill-down:
       - Production: stage rows with in-house/vendor counts as `HBars` (2 series, legend).
       - Pickups: next 14 days, day-grouped, payment badge.
       - Money: `BarPair` billed against collected by month plus ageing chips.
       - Calendar: per designer.
       - Stock: low items, reserved value, top profit items.
       - Enquiries: `HBars` by source with conversion %.
       - Workload: `HBars` per designer and vendor.
       - Expenses: `HBars` by category.
       - Profit: revenue − materials − running costs = profit, written as a sum with the lowest and highest orders.
       - Unavailable tile: "Could not load this part. Pull to refresh."
       - Tiles a filter does not touch show "Not filtered by customer type".
  - `components/charts` (Decision 9):
    - `BarPair({ data: [{ label, a, b }], series: [{ key, name }], format })`: SVG with one value axis and 3 gridlines. Each bar is ≥ 8 px wide with a 2 px gap and a 4 px rounded top. A legend sits above, labels go on the last month only, tapping a group shows a tooltip, and "Show as table" switches to a `<table>`.
    - `HBars({ rows: [{ key, label, value, display }], onSelect })`: a single hue, sorted, with the value as a text label (text tokens, not the series colour). Rows are tappable.
    - `StatTile`.
    - Colours are CSS variables in `chartTokens.css` with light and dark values. The dataviz `validate_palette.js` output (pass) is recorded in the task report.
  - `errorMessages`: `RANGE_TOO_LONG` 'That period is too long for Home. Use Reports for longer periods.', `FILTER_TOO_BROAD` 'Too many customers match this filter. Try another one.'

- [ ] **Step 1: Write the failing tests.**
  - `dashboard.test.jsx`:
    - `Home shows what needs attention first, in plain sentences`.
    - `nothing to act on says so`.
    - `key numbers show the change against last month in words`.
    - `choosing This year asks for the year and keeps it in the address`.
    - `custom dates are sent as from and to`.
    - `filters show how many are on and are sent to the server`.
    - `tapping a number opens its list`.
    - `a tile that failed says so and the rest still show`.
    - `designers see their own production tiles and no money` (MSW returns the designer shape; no ₹ in the document).
    - `refresh asks for fresh figures`.
    - `the quick buttons show by permission` (replaces the M7 Home test: front desk keeps "New enquiry" and "Book appointment"; "Add expense" needs `expenses.write`; designers get none).
    - `follow-up calls due and today's appointments are on Home` (replaces the M7 "Follow-ups today" and "Today's appointments" sections: the attention item and the calendar tile).
  - `charts.test.jsx`:
    - `the paired bars have a legend and a table view with the same numbers`.
    - `horizontal bars are sorted, labelled and tappable`.
    - `bars stay visible for zero and tiny values` (min 2 px).
- [ ] **Step 2: Run** `npx vitest run --project web`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project web && npm run lint`. Expected: PASS.
- [ ] **Step 5: Visual check** at 390 and 1280 px, light and dark, for admin, operations and designer, with the M4 visual harness seeded through `helpers/dashboard.js`. Check for: no horizontal scroll, label collisions, and tap targets ≥ 44 px. Run `node <dataviz skill>/scripts/validate_palette.js "<chart hexes>" --mode light` and `--mode dark` against the theme surfaces; both must PASS.
- [ ] **Step 6: Commit** `feat(web): Home shows how the business is doing, with attention list, key numbers and tiles (M8 Task 12)`

---

### Task 13: Web: drill-down lists, Reports page, navigation and the whole suite

**Files:**
- Create: `apps/web/src/features/dashboard/MetricPage.jsx`, `apps/web/src/features/reports/{reportsApi.js,ReportsPage.jsx,ReportCard.jsx,RecentFiles.jsx}`
- Modify: `apps/web/src/App.jsx`, `apps/web/src/layout/navItems.js`, `apps/web/src/lib/errorMessages.js`, `apps/web/src/lib/errorMessages.test.js`, `apps/web/src/test/server.js`
- Test: `apps/web/src/features/dashboard/metricPage.test.jsx`, `apps/web/src/features/reports/reports.test.jsx`

**Interfaces:**
- Consumes: Task 7 rows route; Task 8 routes; `REPORTS`; `LoadMore`, `ResponsiveTable`, `StatusBadge`; `crypto.randomUUID` for Idempotency-Key.
- Produces:
  - `/home/:metric` → `MetricPage`. It shows the metric label and value at the top, the active filters as removable chips, and rows (title, subtitle, date, amount for money users, badge) that tap through to `row.link`. It uses `LoadMore`. An unknown metric shows "This list is not available." with a link Home.
  - `/reports` → `ReportsPage`, behind `RequirePermission permission="reports.export"`:
    - At the top, a highlighted card "This month's GST files" with a month picker defaulting to last month and a "Get files" button (`gst_pack`).
    - Then groups "GST", "Registers", "Ledgers", "Business": `ReportCard` per report with a plain label, a one-line description, the period input (month / range presets / customer search via the existing `useCustomers(q)` in `features/customers/customersApi.js`), a format choice (Excel default; CSV only where offered; PDF for the statement), and "Get file".
    - `RecentFiles`: status "Preparing your file…" (polls every 3 s while queued or running), "Ready" with **Download** (calls the download route, then `window.location.assign(url)`), "Could not be made: <plain message>" with "Try again", plus size and who asked. Runs older than 90 days are not listed.
    - The Idempotency-Key is created per click and reused on a network retry.
  - Nav: `{ label: 'Reports', path: '/reports', permission: 'reports.export', icon: IconFileSpreadsheet, phone: 'more' }` after Accounts.
  - `errorMessages` + test list: `REPORT_NOT_READY` 'This file is still being prepared.', `REPORT_TOO_LARGE` 'That is too much for one file. Choose a shorter period.', `REPORT_FAILED` 'The file could not be made. Try again.', `RANGE_TOO_LONG`, `FILTER_TOO_BROAD`.

- [ ] **Step 1: Write the failing tests.**
  - `metricPage.test.jsx`:
    - `the list shows the same number as Home and its records`.
    - `rows open the order, bill or expense`.
    - `removing a filter chip updates the list`.
    - `designers see no amounts`.
  - `reports.test.jsx`:
    - `the GST files card asks for last month by default`.
    - `asking for a report sends one key and shows it preparing`.
    - `a ready file downloads through a fresh link`.
    - `a failed file says why and can be made again`.
    - `CSV is offered only where it fits; the statement offers PDF`.
    - `Reports is in the menu for admins only`.
  - `errorMessages.test.js`: `every report and dashboard error code has a plain message`.
- [ ] **Step 2: Run** `npx vitest run --project web`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint`. Expected: PASS (whole suite).
- [ ] **Step 5: Visual check** at 390 and 1280 px: a drill-down list (money and designer), the Reports page with a file preparing, ready and failed, and the month picker.
- [ ] **Step 6: Commit** `feat(web): drill-down lists and a Reports page with GST files, registers and business reports (M8 Task 13)`

---

## Reconciliation with built M6/M7 (2026-11-13)

Checked against the code on `m8-dashboard-reports` (develop with M1–M7 merged) and the M4, M5, M6 and M7 ledgers. Everything the plan names from M5, M6 and M7 exists with the names and return shapes the plan used. The rows below are the differences.

| Plan said | Built | Changed in the plan, and why |
|---|---|---|
| M6 `orderProfits` is one of the stock functions (M6 Task 7) | `orderProfits(branchId, orderIds)` is in `modules/costing/service.js`. Stock re-exports the other five. It returns a Map of `{ revenue, material, expense, profit }`, at most 100 ids | Binding list, Tasks 6 and 10 name the costing service. Dashboard and reports import it from there, still only through a `service.js` |
| M6 `listMovements` was listed as a contract function | `listMovements(branchId, itemId, …)` is per item, newest first | Task 4 keeps `listMovementsByDate` as new work. It lives in `stock/queries.js` and is re-exported by `stock/service.js`. Both files added to Task 4 and the file structure |
| `stockItemProfit` gives "top 5 by profit" | Rows are sorted by name, with `sales` and `profit` null when there is no selling price | Task 6: the dashboard sorts and keeps 5. `lowStockItems` returns raw docs carrying `value`, `avgCost`, `sellingPrice`: Tasks 6 and 7 require whitelisted rows |
| Stock tile is under `stock.view` only | M6 routes strip stock values without `money.view` | Task 6: `stock_reserved` and `stock_item_profit` are money metrics. `stock_low` stays for `stock.view` |
| `lowStockItems` can give the count | It has a `limit` (default 50) and no total | Task 5: ask for 501, report `truncated` above 500 |
| M7 `listEnquiries` is called with a filter object | `listEnquiries(branchId, filters, { today })` takes `today` third. `enquiryListQuery` is in `packages/shared/src/schemas/frontOffice.js` (the plan said `schemas/*`) | Tasks 4 and 7 call it with `{ today }`. The schema path is named |
| `listAppointments` serves the fittings drill-down | It has no `type` filter, and pages by start time | Task 7: rows for `fittings_today` and `appointments_today` come from `appointmentsForDay` (one day) |
| `appointmentCounts` "scoped by M7" | It takes no user and is unscoped | Listed with its real signature. M8 does not use it. Calendar figures use `appointmentsForDay`, which scopes by user |
| `followUpsDue` returned a count | It returns `{ count, overdue }` | Task 5 uses `.count` |
| M7 Home (follow-ups list, today's appointments, New enquiry and Book appointment buttons) is not mentioned | HomePage has all four; `HomePage.test.jsx` has cases for them | Decision 19 and Task 12 fold them in: follow-ups into Needs attention, appointments into the calendar tile, both buttons stay by permission. `HomePage.test.jsx` and a default `/v1/dashboard` test handler are in Task 12 |
| Vendor overdue is "garments `with_vendor`, `dueBackDate < today`" | The garment `status` has no `with_vendor`. It is `stageState === 'with_vendor'` and `vendorWork.dueBackDate` | Decision 8 reworded |
| Report files go under `<branchId>/reports/<yyyy>/<runId>/<filename>`, purpose `report` | `createDownloadUrl` only accepts `<branchId>/<purpose>/<yyyy>/<uuid>.<ext>`. A presigned GET cannot set a file name | Decision 12 and Task 8: key `<branchId>/reports/<yyyy>/<uuid>.<ext>`, purpose `reports` (so the M9 lifecycle path `*/reports/` still holds). The friendly name is stored on the run and written as `Content-Disposition` by `putObject`. `devFilesRoutes.js` added to Task 8 so local storage serves it |
| `respondCommitted` is a shared helper | Billing, expenses, enquiries and appointments each define their own in `routes.js` | Task 8: `reports/routes.js` defines its own |
| `todayIst` is consumable | It is private to `billing/ledger.js` | Task 3 uses `istDate(clock.now())`. `ageingBucket` is in `@vs/shared/billing.js` |
| `customerMoneySummary().advancesHeld` | The built field is `advanceHeld` (singular) | Task 3 test text. The new functions keep the plural name |
| Customer type filter uses a "customer types" enum | `CUSTOMER_TYPES` is a private const in `schemas/customers.js` | Task 1 exports it |
| `isGarmentLate` is a Task 1 product | It already exists in `@vs/shared/production.js`. `isPickupAtRisk` does not exist: the daily job has the rule inline with `isNearlyReady` | `isGarmentLate` moved to "existing". Task 1 still adds `isPickupAtRisk` and switches `production/daily.js` |
| Task 4 "adds" `expenseCostTotal` | Already built in M5 | Decision 17 says so. Nothing added to expenses |
| Test file `billing-pdfs.test.js` | It is `billing-pdf.test.js` | Task 8 step 4 names it. Task 3 step 4's hedge removed |
| Task 11 link `/reports` against Decision 16 `/accounts` | Events carry the link as `vars.link` | Success mail links to `/accounts`, the failure mail to `/reports` |
| `exceljs` 4.4.0 may be installed | It is not in `apps/api/package.json` or `node_modules` | Task 8 step 3 installs it, as written |
| Web customer search via `findCustomers` | No such function. `useCustomers(q)` exists in `customersApi.js` | Task 13 uses it |

---

## Not in M8 (later milestones)

- Imports and opening balances (M9). Opening receivables will appear in ageing once imported as documents.
- Go-live:
  - S3 lifecycle expiry for `<branchId>/reports/` (90 days).
  - SES attachment size check against real pack sizes.
  - Playwright phone E2E for Home → drill-down.
- Report scheduling beyond the monthly pack. The Accountant role (`reports.export` and read-only views as a new role-map entry). GSTR-2B reconciliation and filing itself (spec exclusions). E-invoice JSON. Per-designer email digests.
- A customer statement emailed to the client (needs consent and a template; owner to ask).
