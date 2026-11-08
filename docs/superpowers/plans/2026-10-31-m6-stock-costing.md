# M6 Stock and Garment Costing Implementation Plan

Reconciled with built M5 on 2026-11-01.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The boutique knows what is on its shelves and what each garment really cost. Staff add stock items (fabric by the metre, buttons by the packet) and see a low-stock list at a glance. Materials are listed per garment when the order is taken (or later on the garment) and **reserved** from free stock; any shortfall becomes a "to buy" request. Receiving a delivery adds the stock **and** the material purchase expense in one step (never typed twice). When a designer completes **Materials ready**, the reserved materials become **used** — the designer confirms or corrects quantities with a few taps and never sees a price. Cancelling an order or rejecting a garment puts unused materials back. Stock is valued at weighted average cost; the admin sees each order's garments with billed value, material cost, expense cost and margin, and the order's profit.

**Architecture:** Same modular monolith. Quantity and weighted-average arithmetic stays pure in `packages/shared/src/stock.js` (the web previews exactly what the API stores). New API module `stock` with a strict import rule to keep ESM imports acyclic: `stock/service.js` (and `ledger.js`, `reservations.js`, `queries.js` it re-exports) imports only `core/*`, `settings/service.js` and its own model — orders, production, billing and catalog call it inside their own transactions. Files that need other modules — `purchasing.js` (needs `expenses/service.js`) and `routes.js` (needs `orders/service.js` for garment scope) — are imported by nobody but `routes.js`/`app.js`. Every quantity change is one append-only movement plus a guarded update of the item's cached balance in the same transaction. A second new module `costing` (`service.js`, `json.js`, `routes.js`, no model) reads `billing/service.js`, `stock/service.js`, `expenses/service.js` and `orders/service.js`; nobody imports it. Bounded queries only: per-garment and per-order lookups by index, movement history paginated, the low-stock list served by a cached `low` flag index.

**Tech Stack:** As M5. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-vastrasanskara-system-design.md` — §6.2 (all: stockItems, append-only stockMovements, cached `onHand`/`reserved`/`avgCost` in the same transaction, free = onHand − reserved, `STOCK_INSUFFICIENT`, weighted average, purchaseRequests, the 6-step order flow, low-stock alert, profit per stock item), §6.3 (all), §3.3 (`garments.materials[]`), §4 (stage order; Materials ready; rejection and remake), §5.1 (catalog item optional `stockItemId`), §5.3–5.4 (issued lines, credit notes), §5.7 ("stock adjustments" audited), §8.3 ("Stock below reorder level → Operations, immediate"), §9.1 tiles 1/7/11 and §9.2 "stock movements and valuation", "order and garment profitability", "profit per stock item" (data shape only — screens M8), §10.2 (`stock.write`; designer "quantities on own garments"; money stripping), §11 (`STOCK_INSUFFICIENT`, receiving stock requires `Idempotency-Key`), §12 ("weighted average cost" unit tests; "stock never negative under concurrent reservations"; permission matrix with no designer money field).

**Binding M5 (built; the code in `apps/api/src/modules/expenses/` and `packages/shared/src/expenses.js` is the contract):** `docs/superpowers/plans/2026-10-31-m5-expenses.md` — Task 3 `createExpense(branchId, input, actor, { storage, session, source = 'manual', sourceRef = null } = {}) → plain expense object` (re-parses `input` with `expenseSchema`; with `session` it joins the caller's transaction, else opens its own; `source` is `'manual' | 'purchase'`, `sourceRef` a String; `payee` needs `vendorId` or `name`, a `gst` bill needs the payee's GSTIN), `voidExpense(branchId, id, { version, patch: { reason } }, actor)` (currently has no 5th argument and always opens its own `withTransaction`; stale `version` → 409; already voided → 422 `ALREADY_VOIDED`), `updateExpense(branchId, id, { version, patch }, actor, { storage } = {})` (voided → 422 `EXPENSE_VOIDED`), `expenseCostForGarments(branchId, garmentIds, session) → Map<garmentId, { cost, expenses: [{ expenseId, number, kind, share }] }>` (every requested garment that exists has an entry, `{ cost: 0, expenses: [] }` when nothing is linked; `expenseId` a string), category key `material_purchase` (Decision 6), shared `expenseCost(expense)` (`@vs/shared/expenses.js`; 0 when `status === 'voided'`, `total` without `gst`, else `gst.taxable` plus CGST+SGST+IGST when `gst.itcEligible` is false). M4 ledger carried: `assertPeriodOpen` inside the transaction; the permission route table is hand-written and asserted equal to the routers' declared routes (M4 Task 13); a committed write answers 2xx even if reading it back fails (`respondCommitted`). M5 rulings are in `.superpowers/sdd/2026-10-31-m5-expenses/progress.md`; none renamed anything above.

## Global Constraints

- Everything in the M1–M5 Global Constraints still applies (integer paise, UTC + IST business-date strings, `branchId`, `version` in bodies and responses with 409 `CONFLICT`, strict zod, error shape, no personal data in logs, bundled icons, 390 px screens, sentence case, plain words).
- **Quantities** are integers in **thousandths of the item's usage unit** ("milli", as billing's `toMilli`): 2.5 metres = `2500`. Every API body and response carries milli integers; only the web converts (`toMilli` / `formatQty`). Money stays integer paise.
- **Layout and imports:** `apps/api/src/modules/stock/` keeps `model.js`, `service.js` (+ `ledger.js`, `reservations.js`, `queries.js`, re-exported), `purchasing.js`, `notifications.js`, `json.js`, `routes.js`. `stock/service.js` and what it re-exports never import `orders`, `production`, `billing`, `catalog`, `expenses` or `costing` (asserted by a test). No other module reads a stock model; no stock file reads another module's model.
- **Every movement inside a transaction:** the ledger functions require a `session` (throw without one) so a caller's business change and the stock change commit together.
- **Never negative:** a change that would make `onHand`, `reserved` or `free = onHand − reserved` negative → 422 `STOCK_INSUFFICIENT` `details: { stockItemId, name, free }`, nothing written. Reservations themselves never fail on a shortfall: they reserve what is free and request the rest (§6.2 steps 1–2).
- **Movements are append-only:** the model refuses `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `findOneAndUpdate`, `findOneAndDelete`, `replaceOne`, `findOneAndReplace` and `save()` of a stored movement.
- **Designers never see a cost:** no response to a user without `money.view` contains `cost`, `value`, `valueChange`, `avgCost`, `sellingPrice`, `price`, `total`, `revenue`, `margin` or `profit` keys (key absence, the M2 `withMoney` pattern).
- **Audit:** item create and changes to `reorderLevel`, `sellingPrice`, units or `active`; every count correction (`adjust`); opening stock; delivery undo — `recordAudit({ entityType: 'stock_item' | 'purchase_request', … })` in the same transaction. Receipts are audited through the expense they create.
- **Words in the UI:** "Stock", "In stock", "Reserved for orders", "Free", "Running low", "To buy", "Receive delivery", "Count stock", "Materials", "Materials used", "Used more", "Put back", "Costs and profit", "Billed", "Materials cost", "Other costs", "Margin". Never "SKU", "movement", "ledger", "weighted average" (the item page says "Average cost").
- Commit subjects end with `(M6 Task N)`. No deploy/infra changes.

## Decisions made in planning

| # | Decision | Why | Cost if wrong |
|---|---|---|---|
| 1 | Quantities are **integer milli-units** of the usage unit; the conversion factor is milli usage units per purchase unit (packet = 144 pieces → `144000`). Receiving in purchase units converts with `mulDivRound(qtyMilli, factorMilli, 1000)`. | Fabric is cut in fractions of a metre; billing already uses `toMilli`; integers keep sums exact. | — |
| 2 | **Valuation pool:** each item caches `value` (paise, authoritative) beside `onHand`. An outflow of q costs `mulDivRound(value, q, onHand)` — all of `value` when it empties the shelf; an inflow adds its cost. `avgCost` is cached for display as **milli-paise per usage unit** (`mulDivRound(value, 1_000_000, onHand)`, 0 when empty). Every movement stores signed `valueChange`; garment material cost = −Σ `valueChange` of its `consume` movements. | Exact weighted average with no drift: Σ movements = cached value always; a button at ₹100/144 keeps its fraction. | Display only; the pool is unchanged. |
| 3 | **Concurrency:** a movement reads the item in the transaction, computes the new balance with the pure `applyMovement`, and writes it with `updateOne({ _id, balanceSeq: read.balanceSeq }, { $set: balance, $inc: { balanceSeq: 1 } })`; `matchedCount 0` → 409 `CONFLICT`. Two transactions writing one item conflict in MongoDB (WriteConflict → `withTransaction` retries, re-reading the new balance). Mongoose `min: 0` on `onHand`/`reserved` is the last guard. | §12 "stock never negative under concurrent reservations"; the retry re-reads, so the second reservation sees the first. | — |
| 4 | Reservations **reserve what is free and request the rest**; they never fail. One open (`requested`) shortfall request per item accumulates `needs: [{ garmentId, garmentNo, orderId, quantity }]`; once marked ordered, new shortfalls open a new request. | §6.2 steps 1–2; one line per item on "To buy" is readable at a glance (a batch of 20 is one line). | — |
| 5 | Materials planned per garment live in the stock module's **`garmentMaterials`** collection (one document per garment: `lines[]`, `version`), not in `garments.materials[]` (left unused, empty). | The stock module owns the reservation state it changes in every movement transaction; writing into the orders module's garment would break the module boundary. | A later migration copies lines to `garments.materials`. |
| 6 | Materials can be listed **when the order is taken** (optional per garment line; a batch gives each garment the list), or later on the garment's **Materials** card. Before Materials ready completes, a list change reserves more or releases the difference; afterwards a change is "Used more" / "Put back" (a `consume` of ± quantity). | Spec step 1 says "when an order is taken", but the designer often decides materials later; both are a few taps. | — |
| 7 | **Materials ready** (`complete` or `skip` of that stage) turns each planned line into used: quantity = the designer's correction if sent, else planned; taken from the reservation first and free stock for any extra; the unused reservation is released; the garment's needs on `requested` shortfall requests are dropped. Not enough stock for the corrected quantity → `STOCK_INSUFFICIENT` and the stage action fails whole. A rework back to Materials ready consumes only lines still planned. | §6.2 step 4; the shelf cannot give what is not there, and the message says what to do ("Receive the delivery first or change the quantity"). | — |
| 8 | **Put back** after use values the returned quantity at that garment's own average for the item (`mulDivRound(usedCost, q, usedQty)`), at most what it used. | Returning stock at today's average would move cost between garments. | — |
| 9 | **Cancelling an order** releases every planned line of its unsettled garments and drops their needs from `requested` shortfall requests; a **rejected** garment does the same; a **remake** copies the rejected garment's lines and reserves them again. Used materials stay used (they were cut). | §6.2 step 5 and §4 rejection/remake. | — |
| 10 | **Receiving** (`Idempotency-Key`) does in one transaction: `createExpense(..., { session, source: 'purchase', sourceRef: requestId, storage })` with category `material_purchase` and no link; `purchase_in` at the expense's cost value (`expenseCost`: before-GST when ITC can be claimed, else the total); reservation of the request's still-open needs in garment order; request `received`. A smaller delivery than asked closes the request; unmet needs move to a new `requested` request. "Receive delivery" on an item without a request makes a `manual` request already received. | §6.2 step 3 "never entered twice"; ITC-claimable GST is not a cost (M5 Decision 9 rule). | — |
| 11 | A **purchase expense's** amount, GST, date, payee, category and link are fixed, and it cannot be voided from Expenses (422 `EXPENSE_FROM_STOCK`); its note, photos, mode and reference can change. A mistaken delivery is fixed by **"Undo delivery"** (reason required): allowed only while the receipt is the item's latest value-changing movement (else 422 `RECEIPT_USED`); it releases the reservations the receipt made, writes a negative `purchase_in` of exactly the receipt's quantity and value, voids the expense (in the same transaction, month lock applies) and sets the request back to `ordered`. | Stock value and the expense can never disagree; "used already" is the only case where an exact undo is impossible, and then a count correction is the right tool. | — |
| 12 | **Count stock** (adjust) asks "How many are on the shelf now?" with the `onHand` the screen showed; the server refuses with 409 if `onHand` moved since, and records the difference as `adjust` with a reason. A count up on an empty item needs a cost per unit; otherwise it is valued at the current average. A count below what is reserved → `STOCK_INSUFFICIENT` ("N is reserved for orders"). Audited. | Staff count shelves, they do not compute differences; the 409 stops a count racing a designer's consumption. | — |
| 13 | **Opening stock** only when creating an item (quantity + cost per unit); later changes are counts. Usage unit and conversion are fixed once the item has a movement (422 `UNIT_FIXED`); everything else stays editable. | One opening per item keeps the valuation start auditable. | — |
| 14 | **Low stock:** `low = reorderLevel > 0 && free < reorderLevel`, cached on the item in every movement; when it turns true `lowSeq` increments and `stock.low` is emitted (operations; in-app + email; `refId` item, `sequence` lowSeq) in the same transaction, so an item alerts once per dip. No scheduled job. The low list is served by a partial index on `low: true`. "Order more" suggests whole purchase units bringing free up to twice the reorder level. | §6.2 step 6, §8.3 "immediate"; readable at a glance; no notification storm. | A digest is one job file. |
| 15 | **Sales from bills:** a catalog item of kind `material` may name a `stockItemId` (sold in the stock item's usage unit). When a bill is issued, each such line **without** a garment records a `sale` (`STOCK_INSUFFICIENT` refuses the issue); cancelling the bill records a negative `sale` at the original cost. A credit note moves no stock (returned goods are a count). Garment lines move nothing (their materials were consumed). | §6.2 movement type `sale` and "profit per stock item … consumed or sold" without double-counting garment materials. | — |
| 16 | **Garment margin** = billed taxable value attributable to the garment (its garment lines and its charge lines on issued bills, net of credit-note line credits; cancelled bills count 0) **+ its equal share of the order's lines without a garment** (rush fee, extra material lines; `allocateProRata` across non-cancelled garments, all garments if none) − material cost − expense cost. Order profit = Σ garment margins (cancelled garments included, so their costs are not lost). | §6.3; unattributed lines would otherwise vanish from order profit. | One rule in `costing/service.js`. |
| 17 | New permissions: **`stock.view`** (admin + operations) for stock reads; **`costing.view`** (admin only) for margins and profit. `stock.write` (admin + operations) for items, counts, requests, receiving; designers keep `stock.consume.own` (materials on their own garments only, quantities only). Item money fields need `money.view` as well. | Spec's future Accountant needs read-only stock; profit is the owner's figure (spec silent; security first). | Give `costing.view` to operations: one line in `permissions.js`. |
| 18 | Stock item **step** for the +/− buttons (`step`, milli, default 1 unit; e.g. fabric 0.25 m) set on the item. The "Materials used" list is pre-filled with the plan, so the usual case is one tap on "Done". | Few taps for designers on a phone. | — |
| 19 | Stock **categories** are free text with suggestions from existing items (no settings list). Purchase requests have **no number**; they read "Red silk — 6 m". | Nothing files or audits these; fewer settings for staff. | Settings list later. |
| 20 | **Indexes:** items `by_name (branchId, active, searchName)`, `low (branchId, searchName)` partial `{ low: true }`; movements `by_item (branchId, stockItemId, at, _id)`, `by_date (branchId, date, type)`, `by_garment (garmentId, type)` partial, `by_request (purchaseRequestId)` partial, `by_invoice (invoiceId)` partial; garmentMaterials `garment_unique (garmentId)`, `by_order (branchId, orderId)`, `by_item (branchId, lines.stockItemId)`; requests `by_status (branchId, status, createdAt, _id)`, `open_for_item (branchId, stockItemId, status)`, `needs (needs.garmentId)`. | Every read is per item, per garment, per order or a date range. | — |
| 21 | API quantities in bodies are milli integers (`qty = z.int().min(1).max(1_000_000_000)`), so the server never parses decimals. | Same as paise. | — |

## Review Focus

1. **Two reservations or a reservation and a count at the same moment** — never more reserved than on hand; cached balances equal the sum of movements. → Task 3 test `two reservations at once never oversell`; Task 2 test `a count racing a consumption is refused, not negative`.
2. **Designer cost-blindness** — every stock/costing response a designer can reach (materials card, item picker, stage action, order and garment responses) has no money key, and every other stock/costing route is 403. → Task 8 tests `designers never receive a cost field` and `designers are refused every stock and costing route except their garments' materials`.
3. **Receiving entered once** — a double tap, an aborted transaction or an undo leaves stock and the material expense in agreement (one expense, one `purchase_in`; undo voids both). → Task 5 tests `receiving twice with one key makes one delivery and one expense`, `a failed receipt leaves neither stock nor expense` and `undo delivery voids the expense and takes the stock back out`.
4. **Materials ready with corrected quantities** — used = corrected quantity, remainder released, shortage refuses the whole stage action, bulk actions stay all-or-nothing. → Task 4 tests `completing Materials ready uses the plan and releases the rest`, `a corrected quantity larger than the stock refuses the stage action` and `a bulk Materials ready is all or nothing`.
5. **Margin arithmetic** — credit notes reduce billed value, rush fee shared exactly, cancelled bills count nothing, ITC GST is not a cost. → Task 7 tests `a credit note reduces the garment's billed value`, `lines without a garment are shared across the order's garments` and `order profit is the sum of garment margins`.

---

## File Structure

```
packages/shared/src/
  stock.js                      MOVEMENT_TYPES, StockError, formatQty, toUsage, applyMovement, avgCostOf, isLow,
                                suggestedOrder, usedReturnCost
  schemas/stock.js              qty, stockItemSchema, stockItemPatchSchema, stockCountSchema, materialLinesSchema,
                                materialsUsedSchema, materialChangeSchema, purchaseRequestSchema, purchaseOrderSchema,
                                receiveSchema, stockListQuery, movementsQuery, requestsQuery, pickerQuery
  schemas/orders.js             + garmentInputSchema.materials
  schemas/production.js         + stageActionSchema.materialsUsed
  schemas/catalog.js            + stockItemId
  permissions.js                + STOCK_VIEW, COSTING_VIEW
  index.js                      + exports
apps/api/src/
  modules/stock/
    model.js                    StockItem, StockMovement (append-only), GarmentMaterials, PurchaseRequest
    ledger.js                   moveStock (the only writer of balances), stock.low emit
    reservations.js             planNewGarments, setGarmentMaterials, consumeAtMaterialsReady, changeUsedMaterials,
                                releaseGarments, copyGarmentMaterials, addShortfall, dropNeeds
    queries.js                  listItems, getItem, pickerItems, listMovements, lowStockItems, garmentMaterialsView,
                                materialCostForGarments, stockItemProfit, materialCostTotal, stockValuation
    service.js                  createItem, updateItem, countStock, recordSale, reverseSale (+ re-exports)
    purchasing.js               listRequests, createRequest, markOrdered, cancelRequest, receive, undoReceipt
    notifications.js            defineEvent('stock.low')
    json.js, routes.js          stockRouter(storage)
  modules/costing/{service.js, json.js, routes.js}     garmentCosts, orderProfits; costingRouter()
  modules/billing/attribution.js (+ service.js)        orderRevenueLines
  modules/billing/invoices.js   sale on issue, reversal on cancel
  modules/catalog/{model.js, service.js}               stockItemId on material items
  modules/expenses/service.js   EXPENSE_FROM_STOCK guard in updateExpense and voidExpense (+ { session, fromStock })
  modules/orders/{service.js, lifecycle.js}            materials on create/add; release on cancel
  modules/production/service.js consume at Materials ready; release on rejection; copy on remake
  app.js                        mount /v1/stock, /v1/costing
apps/api/test/
  helpers/stock.js, stock-ledger.test.js, stock-reservations.test.js, stock-materials-ready.test.js,
  stock-purchasing.test.js, stock-sales.test.js, costing.test.js, stock-permissions.test.js
apps/web/src/
  features/stock/{stockApi.js, qty.js, StockPage.jsx, ItemsTab.jsx, LowStockList.jsx, ItemModal.jsx, StockItemPage.jsx,
                  MovementList.jsx, CountDialog.jsx, ToBuyTab.jsx, RequestModal.jsx, ReceiveDialog.jsx,
                  UndoReceiptDialog.jsx, ItemPicker.jsx, QtyStepper.jsx, GarmentMaterials.jsx, MaterialsUsed.jsx}
  features/costing/{costingApi.js, OrderCosts.jsx}
  features/orders/{GarmentPanel.jsx, StageActionDialog.jsx, OrderPage.jsx, new/GarmentsStep.jsx},
  features/production/BulkBar.jsx, features/catalog/ItemModal.jsx, layout/navItems.js, App.jsx,
  lib/errorMessages.js, test/server.js, test/stock.js
```

---

### Task 1: Shared — quantities, weighted average, stock schemas and permissions

**Files:**
- Create: `packages/shared/src/stock.js`, `packages/shared/src/schemas/stock.js`
- Modify: `packages/shared/src/permissions.js`, `schemas/orders.js`, `schemas/production.js`, `schemas/catalog.js`, `index.js`
- Test: `packages/shared/test/stock.test.js`, `packages/shared/test/m6-schemas.test.js`, `packages/shared/test/permissions.test.js`

**Interfaces:**
- Consumes: `toMilli` (gst.js), `mulDivRound` (money.js), `objectId`, `paise`, `billingAmount`, `gstin`, `stateCode` (common.js), `ymd`, M5 `expenseSchema` field set for receiving's `gst`/`attachments`/`payee` (`schemas/expenses.js`), `PAYMENT_MODES`.
- Produces (`permissions.js`): `STOCK_VIEW: 'stock.view'` (admin, operations); `COSTING_VIEW: 'costing.view'` (admin only — in `NOT_OPERATIONS`). Designers unchanged (`stock.consume.own`).
- Produces (`stock.js`), all pure:
  - `MOVEMENT_TYPES = ['opening', 'purchase_in', 'reserve', 'release', 'consume', 'adjust', 'sale']`.
  - `class StockError extends Error { code: 'STOCK_INSUFFICIENT', free }`.
  - `formatQty(milli, unit) → '2.5 m'` style: up to 3 decimals, trailing zeros dropped, Indian grouping (`'1,200 pieces'`); `toUsage(purchaseMilli, factorMilli) → milli` (`mulDivRound(·, ·, 1000)`).
  - `applyMovement(balance, movement) → { balance: { onHand, reserved, value }, valueChange }` with `balance = { onHand, reserved, value }` and `movement`:
    - `{ type: 'reserve', quantity }` — needs `free ≥ q`; `reserved += q`.
    - `{ type: 'release', quantity }` — needs `reserved ≥ q`.
    - `{ type: 'consume' | 'sale' | 'adjust', quantity: q > 0 out, fromReserved = 0 }` — out: needs `onHand ≥ q`, `reserved ≥ fromReserved`, `free ≥ q − fromReserved`; `valueChange = q === onHand ? −value : −mulDivRound(value, q, onHand)`; `reserved −= fromReserved`.
    - `{ type: 'opening' | 'purchase_in' | 'adjust' | 'consume' | 'sale', quantity: q (in: positive for opening/purchase/adjust up; negative for returns/undo), cost }` — in: `onHand += |q|`, `value += cost` (`cost` required, ≥ 0); for `purchase_in` with negative `q` (undo) `onHand −= |q|`, `value −= cost`, refusing if `free < |q|` or `value < cost`.
    - Any result with `onHand < 0`, `reserved < 0`, `onHand − reserved < 0` or `value < 0` throws `StockError` with `free` of the input. An item at `onHand 0` always has `value 0`.
  - `avgCostOf({ onHand, value }) → milli-paise per unit` (0 when empty); `costAtAverage(avgCost, qtyMilli) → paise` (`mulDivRound(avgCost, qty, 1_000_000)`); `unitCostToValue(paisePerUnit, qtyMilli) → paise`.
  - `isLow({ onHand, reserved, reorderLevel }) → boolean`; `suggestedOrder({ onHand, reserved, reorderLevel, factor }) → purchase-unit milli` (whole purchase units bringing free to 2 × reorder level, at least one).
  - `usedReturnCost({ usedQty, usedCost }, qty) → paise` (Decision 8).
- Produces (`schemas/stock.js`): `qty` (Decision 21); `stockItemSchema { name 1–80, brand ≤ 60 '', category ≤ 40 '', colour ≤ 40 '', usageUnit 1–20, purchaseUnit 1–20, factor qty, step qty default 1000, reorderLevel qty-or-0 default 0, sellingPrice paise nullable default null, opening: { quantity: qty, unitCost: paise } nullable default null }`; `stockItemPatchSchema` (same fields minus `opening`, + `active`, partial, non-empty, via `versioned`); `stockCountSchema { counted: int ≥ 0, expectedOnHand: int ≥ 0, unitCost: paise optional, reason 1–300 }`; `materialLinesSchema = array(strictObject({ stockItemId, quantity: qty })).max(20)` unique items; `materialsUsedSchema = array(strictObject({ garmentId, stockItemId, quantity: int ≥ 0 })).max(200)`; `materialChangeSchema { changes: array({ stockItemId, change: non-zero int }).min(1).max(20), note ≤ 300 }`; `purchaseRequestSchema { stockItemId, quantity: qty, reason: enum ['low_stock', 'manual'], note ≤ 300 '' }`; `purchaseOrderSchema { vendorId nullable, note ≤ 300 }`; `receiveSchema { quantity: qty, date: ymd optional, total: billingAmount.positive(), mode, reference, payee: M5 payee shape, gst: M5 gst shape nullable, attachments: M5 shape }` + `checkExpenseRules`-equivalent refinements reused from M5; `stockListQuery { q, category, low 'true'|'false', active, cursor, limit }`; `movementsQuery { cursor, limit }`; `requestsQuery { status enum + 'open', cursor, limit }`; `pickerQuery { q ≤ 40 }`.
- Produces (`schemas/orders.js`): `garmentInputSchema.materials = materialLinesSchema.default([])`. (`schemas/production.js`): `stageActionSchema.materialsUsed = materialsUsedSchema.optional()`, refused unless `stage === 'materials_ready'` and action is `complete` or `skip`, and each `garmentId` must be in `garments`. (`schemas/catalog.js`): `stockItemId: objectId.nullable().default(null)` on create/patch; refinement: only `kind: 'material'` items may set it.

- [ ] **Step 1: Write the failing tests** — `stock.test.js`: `quantities show like 2.5 m and 1,200 pieces`; `two packets of 144 are 288 pieces`; `weighted average after two purchases` (10 m for ₹5,000 then 10 m for ₹7,000 → avg ₹600/m; consume 5 m costs ₹3,000); `using the whole shelf takes the whole value` (value 1000 paise, 3 units, consume 1, 1, 1 → 333, 334/333 split sums to 1000, ends at value 0); `tiny unit costs keep their fraction` (₹100 for 144 pieces: avgCost 694444 milli-paise; consuming all 144 costs exactly 10000); `a reservation cannot exceed free stock`; `consuming more than the reservation takes the rest from free stock`; `nothing goes negative` (table of release > reserved, out > onHand, out beyond free, undo beyond free → `StockError` with `free`); `an empty shelf has no value and no average`; `low means free below the reorder level, never when the level is 0`; `the suggested order fills to twice the reorder level in whole packets`; `put back is valued at what the garment paid`. `m6-schemas.test.js`: `an item needs a name and units; the step defaults to one unit`; `quantities are whole milli-units`; `a material list names each item once, at most 20`; `materials used is only for completing or skipping Materials ready`; `a count needs a reason`; `receiving checks GST like an expense`; `only material price-list items can name a stock item`; `order garment lines may carry materials`. `permissions.test.js`: `stock.view is for admin and operations`; `costing.view is admin only`; `designers only have stock.consume.own`.
- [ ] **Step 2: Run** `npx vitest run --project shared` → FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project shared && npm run test:tz && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(shared): stock quantities, weighted average, stock schemas and permissions (M6 Task 1)`

---

### Task 2: API — stock items, the movement ledger, counts and the low-stock alert

**Files:**
- Create: `apps/api/src/modules/stock/{model.js,ledger.js,queries.js,service.js,notifications.js,json.js,routes.js}`, `apps/api/test/helpers/stock.js`
- Modify: `apps/api/src/app.js`
- Test: `apps/api/test/stock-ledger.test.js`

**Interfaces:**
- Consumes: Task 1; `withTransaction`, `recordAudit`, `emit`, `defineEvent`, `paginate`, `idempotent`, `versioned`, `istDate`, `getUserNames`.
- Produces (`model.js`):
  - `StockItem` (`stockItems`): `{ branchId, name, searchName, brand, category, colour, usageUnit, purchaseUnit, factor, step, reorderLevel, sellingPrice (null), active, onHand 0 (min 0), reserved 0 (min 0), value 0 (min 0), avgCost 0, low false, lowSeq 0, balanceSeq 0, lastValueMovementId (null), hasMovements false }` + `commonFields`; indexes per Decision 20.
  - `StockMovement` (`stockMovements`, `versionKey: false`): `{ branchId, stockItemId, type, quantity (signed milli as entered), onHandChange, reservedChange, valueChange, onHandAfter, reservedAfter, valueAfter, garmentId, orderId, purchaseRequestId, expenseId, invoiceId (each null), reason '', by, at, date }`; append-only hooks (Global Constraints) throwing `StockMovementImmutableError`.
  - `GarmentMaterials` (`garmentMaterials`): `{ branchId, orderId, garmentId, garmentNo, lines: [{ stockItemId, planned, reserved, used, usedCost, state: 'planned' | 'used' | 'released', _id: false }] }` + `commonFields` (version).
  - `PurchaseRequest` (`purchaseRequests`): `{ branchId, stockItemId, quantity, reason: 'shortfall' | 'low_stock' | 'manual', needs: [{ garmentId, garmentNo, orderId, quantity, reservedOnReceipt 0, _id: false }], note, status: 'requested' | 'ordered' | 'received' | 'cancelled', vendorId (null), orderedAt, orderedBy, receipt: { quantity, value, expenseId, movementId, date, at, by } | null, cancellation: { reason, at, by } | null }` + `commonFields`.
- Produces (`ledger.js`): `moveStock(branchId, { stockItemId, type, quantity, fromReserved, cost, refs: { garmentId, orderId, purchaseRequestId, expenseId, invoiceId }, reason }, actor, session) → { movement, item }` — throws without `session`; reads the item (404 if not the branch's); `applyMovement` (`StockError` → 422 `STOCK_INSUFFICIENT` with `{ stockItemId, name, free }`); guarded `updateOne` per Decision 3 setting `onHand, reserved, value, avgCost, low, hasMovements: true`, `lastValueMovementId` when `valueChange ≠ 0 || onHandChange ≠ 0`; low false→true: `lowSeq + 1` and `emit('stock.low', { branchId, refId: itemId, sequence: lowSeq, vars: { name, free: formatQty, reorderLevel: formatQty, link: '/stock/items/<id>' } }, { session })`; inserts the movement with the after-balances and `date = istDate(now)`.
- Produces (`notifications.js`): `defineEvent('stock.low', { recipients: ['operations'], channels: ['in_app', 'email'], templates: 'Running low: {name}' / '{name} is running low: {free} free (reorder at {reorderLevel}).' })`.
- Produces (`service.js`):
  - `createItem(branchId, input, actor) → item` — in one transaction: create; `opening` given → `moveStock(type 'opening', cost = unitCostToValue(unitCost, quantity))`; audit `stock_item`/`create`.
  - `updateItem(branchId, id, { version, patch }, actor)` — 404/409; `usageUnit` or `factor` change when `hasMovements` → 422 `UNIT_FIXED` `'The unit cannot change once stock has moved'`; `reorderLevel` change recomputes `low` (no alert on an edit); audit when changed.
  - `countStock(branchId, id, { counted, expectedOnHand, unitCost, reason }, actor) → item` — in the transaction: `onHand !== expectedOnHand` → 409 `CONFLICT`; difference 0 → 422 `NOTHING_TO_CHANGE`; up with `onHand === 0` and no `unitCost` → 400 `unitCost` "Enter the cost per unit"; up → `cost = unitCost ? unitCostToValue : costAtAverage`; down → out; audit `stock_item`/`count` `{ before: onHand, after: counted, reason, valueChange }`.
- Produces (`queries.js`, re-exported): `listItems(branchId, { q, category, low, active, cursor, limit })` (`paginate` by `searchName`); `getItem(branchId, id)`; `listMovements(branchId, itemId, { cursor, limit })` (`paginate(['at', -1])`, `by_item`); `lowStockItems(branchId, { limit = 50 }) → items` (`low` index, by name).
- Produces (`json.js`): `toItemJson(item, { money })` → `{ id, name, brand, category, colour, usageUnit, purchaseUnit, factor, step, reorderLevel, onHand, reserved, free, low, active, version, ...(money && { value, avgCost, sellingPrice }) }`; `toMovementJson(m, { names, money })` → `{ id, type, quantity, onHandChange, reservedChange, onHandAfter, reservedAfter, ref: { garmentId, orderId, purchaseRequestId, expenseId, invoiceId }, reason, by: { id, name }, at, date, ...(money && { valueChange, valueAfter }) }`.
- Produces (`routes.js`, `stockRouter(storage)` at `/v1/stock`): `GET /items` (`stock.view`), `POST /items` (`stock.write`), `GET /items/:id`, `PATCH /items/:id` (`stock.write`, versioned), `GET /items/:id/movements` (`stock.view`), `POST /items/:id/count` (`stock.write`), `GET /low` (`stock.view`). `money = user.permissions.has('money.view')`.
- Produces (`helpers/stock.js`): `stockHelpers(app)` → `{ world() /* admin, operations, designer, a vendor */, item(agent, fields) /* POST /items */, balancesFromMovements(itemId) /* Σ of movement changes */, expectBalanced(itemId) }`.

- [ ] **Step 1: Write the failing tests** — `an item is created with opening stock at its cost` (movement `opening`, value, avgCost, audit entry); `cached balances always equal the sum of movements` (after opening, count up, count down: `expectBalanced`); `movements cannot be changed or deleted` (each refused op throws); `a count records the difference and is audited`; `a count up on an empty item needs a cost per unit`; `a count below what is reserved is refused`; `a count racing a consumption is refused, not negative` (`expectedOnHand` stale → 409; balance unchanged); `the unit cannot change once stock has moved`; `falling below the reorder level alerts operations once per dip` (two drops → one outbox entry; refill and drop again → a second); `the low list shows only items below their level`; `movement history pages newest first without repeats` (limit 2 over 5); `a movement outside a transaction is refused` (`moveStock` without session throws); `item JSON without money.view leaves out value, average cost and selling price` (`toItemJson(item, { money: false })`); `stock queries use indexes` (`explain` of the item list, low list and history: no `COLLSCAN`); `the stock service imports no other business module` (reads `stock/{service,ledger,reservations,queries}.js` import lines: none match `modules/(orders|production|billing|catalog|expenses|costing)` or `'../(orders|production|billing|catalog|expenses|costing)/`).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/stock-ledger.test.js` → FAIL.
- [ ] **Step 3: Implement**; mount `stockRouter(app.locals.storage)` at `/v1/stock` in `app.js`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(api): stock items with an append-only ledger, weighted average, counts and low-stock alert (M6 Task 2)`

---

### Task 3: API — garment materials: reserve on order taking, shortfall requests, release on cancel and rejection

**Files:**
- Create: `apps/api/src/modules/stock/reservations.js`
- Modify: `apps/api/src/modules/stock/{service.js,queries.js,json.js,routes.js}`, `apps/api/src/modules/orders/{service.js,lifecycle.js}`, `apps/api/src/modules/production/service.js`
- Test: `apps/api/test/stock-reservations.test.js`

**Interfaces:**
- Consumes: Task 2 `moveStock`; `getGarment(branchId, user, id)`, `getOrder` (orders/service, in routes only); `stageIndex`, `workingStage`.
- Produces (`reservations.js`, re-exported by `service.js`; every function takes `session` and plain garment facts `{ garmentId, orderId, garmentNo, afterMaterialsReady }`):
  - `addShortfall(branchId, { stockItemId, garment, quantity }, session)` — upsert into the item's `requested` shortfall request (`open_for_item`), adding to `needs` and `quantity`.
  - `dropNeeds(branchId, garmentIds, session, { stockItemId })` — removes those garments' needs from `requested` requests; a request left with no needs and reason `shortfall` → `cancelled` (reason "No longer needed").
  - `planNewGarments(branchId, garments: [{ ...facts, materials }], actor, session)` — creates `GarmentMaterials` per garment with lines and reserves `min(planned, free)` each (`moveStock reserve`), shortfall → `addShortfall`. Unknown or inactive item → 400 `materials.<i>.stockItemId` "Choose an item from stock".
  - `setGarmentMaterials(branchId, garment, { version, lines }, actor, session) → doc` — 409 on version; before Materials ready: line added → reserve/shortfall; planned up → reserve the extra/shortfall; planned down → release down to the new planned and reduce its need; removed → release all and drop its need (state `released`, kept for history, hidden from the card). After Materials ready (`afterMaterialsReady`): 422 `MATERIALS_ALREADY_USED` `'Materials for this garment are already used. Use "Used more" or "Put back".'`.
  - `releaseGarments(branchId, garmentIds, actor, session)` — every `planned` line → release its reservation, state `released`; `dropNeeds`.
  - `copyGarmentMaterials(branchId, fromGarmentId, toGarment, actor, session)` — the source's `planned` and `used` lines' planned quantities become the new garment's plan (`planNewGarments`).
- Produces (`queries.js`): `garmentMaterialsView(branchId, garmentId) → { garmentId, version, lines: [{ stockItemId, name, usageUnit, step, planned, reserved, used, state, short }] }` (`short = planned − reserved` while planned) — quantities only; `pickerItems(branchId, { q }) → [{ id, name, brand, colour, usageUnit, step, free }]` (≤ 20 active, `searchName` prefix then contains).
- Produces (orders): `createOrder` and `addGarments` call `planNewGarments` inside their transactions for lines with `materials` (batch: each garment gets the list); `cancelOrder` calls `releaseGarments` for the garments it cancels. (production): `recordStageAction` with `action 'rejected'` calls `releaseGarments([garmentId])`; with resolution `remake` calls `copyGarmentMaterials` to the remake.
- Produces (routes): `GET /v1/stock/picker?q=` (`stock.view` or `stock.consume.own`); `GET /v1/stock/garments/:id/materials` and `PUT /v1/stock/garments/:id/materials` (`{ version, lines }`) — `requireAnyPermission('stock.write', 'stock.consume.own')` (GET also `stock.view`); the garment is loaded with `getGarment(branchId, req.user, id)` (designer scope → 404) and must be on an `active` or `on_hold` order (else 422 `INVALID_STATUS`).

- [ ] **Step 1: Write the failing tests** — `materials listed when the order is taken are reserved` (2 garments × 2 m, 10 m on hand → reserved 4, free 6); `a batch gives each garment the list`; `a shortfall reserves what is free and asks for the rest` (need 8, free 5 → reserved 5, one request of 3 naming the garment); `shortfalls for one item collect on one request until it is ordered`; `two reservations at once never oversell` (`Promise.all` of two PUTs needing 8 each with 10 free → reserved 10, requests total 6, `expectBalanced`, free ≥ 0); `changing the plan reserves more or releases the difference`; `removing a line releases it and drops its request`; `cancelling an order releases every unused material`; `a rejected garment releases its materials and a remake reserves them again`; `materials already used cannot be re-planned` (422 `MATERIALS_ALREADY_USED`); `an inactive item cannot be planned`; `a designer can plan materials only on their own garments` (other designer's garment → 404); `the materials card and picker carry no costs` (no money keys for designer or operations); `materials queries use indexes`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/stock-reservations.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/stock-reservations.test.js apps/api/test/orders-create.test.js apps/api/test/orders-lifecycle.test.js apps/api/test/production-actions.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): reserve garment materials when orders are taken, request shortfalls, release on cancel (M6 Task 3)`

---

### Task 4: API — Materials ready uses the materials; "Used more" and "Put back"

**Files:**
- Modify: `apps/api/src/modules/stock/{reservations.js,routes.js}`, `apps/api/src/modules/production/service.js`
- Test: `apps/api/test/stock-materials-ready.test.js`

**Interfaces:**
- Consumes: Task 3; `stageActionSchema.materialsUsed` (Task 1).
- Produces (`reservations.js`):
  - `consumeAtMaterialsReady(branchId, garments: [facts], used: [{ garmentId, stockItemId, quantity }] | undefined, actor, session)` — per `planned` line: `q = used entry ?? planned`; `q > 0` → `moveStock({ type: 'consume', quantity: q, fromReserved: min(q, reserved), refs: { garmentId, orderId } })`, then release `reserved − fromReserved`; `q === 0` → release all; line → `state 'used'`, `used += q`, `usedCost += −valueChange`, `reserved 0`; `dropNeeds(garmentIds)`. A `used` entry for an item not on the garment → 400 `materialsUsed.<i>` "This material is not on the garment".
  - `changeUsedMaterials(branchId, garment, { version, changes, note }, actor, session)` — before Materials ready → 422 `MATERIALS_NOT_USED_YET` `'Change the plan instead'`; `change > 0` → consume from free (new item allowed: a `used` line is added); `change < 0` → `consume` with negative quantity and `cost = usedReturnCost(line, |change|)`, at most `used` (else 400 "More than was used"); updates `used`, `usedCost`.
- Produces (production): in `recordStageAction`'s transaction, after the rules: garments whose working stage was `materials_ready` and action is `complete` or `skip` → one `consumeAtMaterialsReady` call for all of them with `input.materialsUsed`; a `StockError` fails the whole action. The response stays without any cost.
- Produces (routes): `POST /v1/stock/garments/:id/materials/used` (`{ version, changes, note }`; same guard and scope as Task 3).

- [ ] **Step 1: Write the failing tests** — `completing Materials ready uses the plan and releases the rest` (plan 3 m, reserved 3 → consume 3; corrected 2.5 → consume 2.5, release 0.5); `using more than reserved takes from free stock`; `a corrected quantity larger than the stock refuses the stage action` (422 `STOCK_INSUFFICIENT`, garment still at Materials ready, no movements); `skipping Materials ready also uses the materials`; `a bulk Materials ready is all or nothing` (two garments, the second short → neither moves); `the garment's open requests are dropped once its materials are used`; `a rework back to Materials ready uses only what is still planned`; `material cost of a garment is the value its materials took` (two purchases at different prices, consume → `usedCost` = pool share); `used more takes from free stock; put back returns at the garment's own cost` (put back more than used → 400); `a designer's stage action response carries no cost`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/stock-materials-ready.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/stock-materials-ready.test.js apps/api/test/stock-reservations.test.js apps/api/test/production-actions.test.js apps/api/test/production-finish.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): Materials ready uses reserved materials with corrections; used more and put back (M6 Task 4)`

---

### Task 5: API — "To buy" requests, receiving with the material expense, undo delivery

**Files:**
- Create: `apps/api/src/modules/stock/purchasing.js`
- Modify: `apps/api/src/modules/stock/{json.js,routes.js}`, `apps/api/src/modules/expenses/service.js`
- Test: `apps/api/test/stock-purchasing.test.js`, `apps/api/test/expenses-edit.test.js`

**Interfaces:**
- Consumes: Tasks 2–4; M5 `createExpense`, `voidExpense`, `expenseCost`; `getVendorNames`; `idempotent()`.
- Produces (`expenses/service.js`, M5 code; both exist today with no purchase handling): in `updateExpense` (inside its transaction, after the `EXPENSE_VOIDED` check, comparing the merged values with the stored ones) a `source: 'purchase'` expense refuses changes to `total`, `gst`, `date`, `payee`, `category`, `link` → 422 `EXPENSE_FROM_STOCK` `'This expense came from receiving stock. Undo the delivery in Stock to change it.'`; `voidExpense(branchId, id, { version, patch: { reason } }, actor, { session, fromStock = false } = {})` — add the 5th argument: when `session` is given run the body directly on it (as `createExpense` does with `insertExpense`), else `withTransaction`; after `loadForWrite` and the `ALREADY_VOIDED` check, `source === 'purchase' && !fromStock` → 422 `EXPENSE_FROM_STOCK` (`businessRule`). The route passes no options, so Expenses cannot void a purchase. `toExpenseJson` already returns `source` (no change needed for ExpensePage's "From a stock delivery").
- Produces (`purchasing.js`; imported only by `routes.js`):
  - `listRequests(branchId, { status = 'open', cursor, limit })` — `open` = `requested` + `ordered`, newest first (`by_status`).
  - `createRequest(branchId, { stockItemId, quantity, reason, note }, actor)`; `markOrdered(branchId, id, { version, patch: { vendorId, note } }, actor)` (`requested` → `ordered`; inactive vendor → 400); `cancelRequest(branchId, id, { version, patch: { reason } }, actor)` (`requested`/`ordered` only; needs return to a new `requested` request — they are still unmet).
  - `receive(branchId, { requestId | stockItemId }, input, actor, { storage }) → { request, item, expense }` — one `withTransaction`: request must be `requested`/`ordered` (else 422 `INVALID_STATUS`); `date` defaults to today; `createExpense(branchId, { date, category: 'material_purchase', note: '<qty> <item name>', payee, total, mode, reference, gst, attachments, link: null }, actor, { storage, session, source: 'purchase', sourceRef: String(request._id) })`; `moveStock({ type: 'purchase_in', quantity, cost: expenseCost(expense), refs: { purchaseRequestId, expenseId } })`; then for each need in order whose garment line is still `planned` with `planned > reserved`: reserve `min(gap, free)` (record `reservedOnReceipt`); unmet needs → `addShortfall` on a new request; request `received` with `receipt`. Without `requestId`: a `manual` request is created `received` in the same transaction.
  - `undoReceipt(branchId, id, { version, patch: { reason } }, actor)` — `received` only; `item.lastValueMovementId !== receipt.movementId` → 422 `RECEIPT_USED` `'Some of this delivery has been used or counted. Count the stock instead.'`; releases each need's `reservedOnReceipt` (back to needs); `moveStock({ type: 'purchase_in', quantity: −receipt.quantity, cost: receipt.value })`; `voidExpense(…, { reason: 'Delivery undone: <reason>' }, actor, { session, fromStock: true })`; request → `ordered` (`receipt: null`); audit `purchase_request`/`undo_receipt`.
- Produces (json): `toRequestJson(r, { names, item, money })` → `{ id, stockItem: { id, name, usageUnit, purchaseUnit, factor }, quantity, reason, needs: [{ garmentId, garmentNo, orderId, quantity }], note, status, vendor: { id, name } | null, orderedAt, receipt: { quantity, date, expenseId, ...(money && { value }) } | null, cancellation, version }`.
- Produces (routes): `GET /v1/stock/requests` (`stock.view`); `POST /v1/stock/requests` (`stock.write`); `POST /v1/stock/requests/:id/order`, `/cancel`, `/undo` (`stock.write`, versioned); `POST /v1/stock/requests/:id/receive` and `POST /v1/stock/items/:id/receive` (`stock.write`, `validate({ body: receiveSchema })`, `idempotent()`) → 201 `{ request, item, expense: { id, number } }` (respondCommitted pattern).

- [ ] **Step 1: Write the failing tests** — `receiving adds stock and the material expense together` (one `purchase_in` with `expenseId`; expense `source 'purchase'`, category `material_purchase`, `sourceRef` = request); `stock is valued before GST when the GST can be claimed`; `stock includes GST when it cannot`; `receiving twice with one key makes one delivery and one expense`; `a failed receipt leaves neither stock nor expense` (`recordAudit` spy throws once → 500; no movement, no expense, number reused); `a receipt in a locked month is refused` (date last month, locked → 422 `PERIOD_LOCKED`, nothing written); `a delivery is reserved for the garments waiting for it, oldest first`; `a smaller delivery leaves the rest on a new request`; `receiving without a request records a manual one`; `undo delivery voids the expense and takes the stock back out` (stock and value back to before; expense voided; request `ordered`; `expectBalanced`); `undo is refused once the delivery has been used` (422 `RECEIPT_USED`); `marking ordered and cancelling follow the request's status`. `expenses-edit.test.js`: `a purchase expense's amount and GST cannot be changed or voided from Expenses` (422 `EXPENSE_FROM_STOCK`; note and photos can change).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/stock-purchasing.test.js apps/api/test/expenses-edit.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/stock-purchasing.test.js apps/api/test/expenses-edit.test.js apps/api/test/expenses-create.test.js apps/api/test/stock-reservations.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): to-buy requests, receiving stock with its material expense, undo delivery (M6 Task 5)`

---

### Task 6: API — stock sold on bills

**Files:**
- Modify: `apps/api/src/modules/catalog/{model.js,service.js}`, `apps/api/src/modules/stock/service.js`, `apps/api/src/modules/billing/invoices.js`
- Test: `apps/api/test/stock-sales.test.js`, `apps/api/test/catalog.test.js`

**Interfaces:**
- Consumes: Task 2 `moveStock`; `toMilli`; `getItem` (stock).
- Produces (catalog): `CatalogItem.stockItemId` (ObjectId, null); create/update check the stock item exists and the catalog item is `kind 'material'` (400 `stockItemId`).
- Produces (`stock/service.js`): `recordSale(branchId, { invoiceId, lines: [{ stockItemId, quantity }] }, actor, session)` — one `sale` out per line (`invoiceId` ref); `reverseSale(branchId, invoiceId, actor, session)` — for each `sale` movement of the invoice, a `sale` in with `quantity = −q`, `cost = −valueChange`.
- Produces (billing): `issueInvoice` — after checks, lines whose item has `stockItemId` and no `garmentId` → `recordSale` with `toMilli(line.quantity)` in the issue transaction (422 `STOCK_INSUFFICIENT` refuses the issue: no number taken); `cancelInvoice` → `reverseSale` in its transaction.

- [ ] **Step 1: Write the failing tests** — `a material sold on a bill leaves stock at average cost`; `a garment line moves no stock`; `not enough stock refuses the bill and takes no number`; `cancelling the bill puts the stock back at the same cost` (`expectBalanced`); `a credit note moves no stock`; `only material price-list items can be linked to stock` (catalog test).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/stock-sales.test.js apps/api/test/catalog.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/stock-sales.test.js apps/api/test/catalog.test.js apps/api/test/billing-issue.test.js apps/api/test/billing-corrections.test.js apps/api/test/billing-e2e.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): stock sold on bills leaves stock at average cost; cancelling puts it back (M6 Task 6)`

---

### Task 7: API — garment and order costing, and report data for M8

**Files:**
- Create: `apps/api/src/modules/billing/attribution.js`, `apps/api/src/modules/costing/{service.js,json.js,routes.js}`
- Modify: `apps/api/src/modules/billing/service.js`, `apps/api/src/modules/stock/queries.js`, `apps/api/src/app.js`
- Test: `apps/api/test/costing.test.js`

**Interfaces:**
- Consumes: Tasks 2–6; M5 `expenseCostForGarments`; `getOrder` (orders/service); `listChargeableEvents` (production); `allocateProRata`.
- Produces (`billing/attribution.js`, re-exported by `billing/service.js`): `orderRevenueLines(branchId, orderId, session) → [{ invoiceId, number, lineKey, garmentId | null, taxable }]` — issued invoices of the order (`order_docs`), each snapshot line's `taxable` minus Σ `lineCredits[key].taxable` of its issued credit notes (`credit_notes`); charge lines get the garment of their stage event (`listChargeableEvents` over the order's garments); cancelled invoices omitted.
- Produces (`stock/queries.js`): `materialCostForGarments(branchId, garmentIds, session) → Map<garmentId, { cost, lines: [{ stockItemId, name, usageUnit, quantity, cost }] }>` (`consume` movements by `by_garment`; quantity and cost net of put-backs); `stockItemProfit(branchId, { from, to }) → [{ stockItemId, name, quantity, cost, sales, profit }]` (one aggregate over `by_date` for `consume` and `sale`; `sales = mulDivRound(quantity, sellingPrice, 1000)`, `profit = sales − cost`; items without a selling price have `sales: null, profit: null`) — **M8 tile 7 / profit per stock item**; `materialCostTotal(branchId, { from, to }) → paise` (consume + sale cost) — **M8 tile 11**; `stockValuation(branchId) → { value, reservedValue, items }` (`reservedValue = Σ costAtAverage(avgCost, reserved)`) — **M8 tile 7 / valuation register**.
- Produces (`costing/service.js`):
  - `garmentCosts(branchId, orderId) → { order: { id, orderNo, status, revenue, material, expense, margin }, garments: [{ id, garmentNo, description, status, revenue, sharedRevenue, material, expense, margin, materials: [...], expenses: [...] }] }` — Decision 16; `revenue` includes `sharedRevenue`; sums exact.
  - `orderProfits(branchId, orderIds) → Map<orderId, { revenue, material, expense, profit }>` (≤ 100 ids; bounded per-order reads) — **M8 order profitability report**.
- Produces (routes, `costingRouter()` at `/v1/costing`): `GET /v1/costing/orders/:id` (`costing.view`) → `toOrderCostsJson`.

- [ ] **Step 1: Write the failing tests** — `a garment's margin is billed value less materials and expenses` (garment billed ₹10,000 taxable, materials ₹2,400, batch expense share ₹1,000 → margin ₹6,600); `a credit note reduces the garment's billed value`; `a cancelled bill counts nothing`; `a charge line counts for its garment`; `lines without a garment are shared across the order's garments` (rush ₹1,000 over 3 → 33334/33333/33333; cancelled garment gets none); `GST that can be claimed is not a cost` (through M5 expense cost); `order profit is the sum of garment margins` (incl. a cancelled garment's used materials); `a rejected garment shows its costs as a loss`; `profit per stock item uses its selling price`; `material cost and stock value for a date range`; `costing queries use indexes`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/costing.test.js` → FAIL.
- [ ] **Step 3: Implement**; mount `costingRouter()` at `/v1/costing`.
- [ ] **Step 4: Run** `npx vitest run apps/api/test/costing.test.js apps/api/test/expenses-costing.test.js apps/api/test/billing-corrections.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): garment margin and order profit from bills, materials and expenses; stock report data (M6 Task 7)`

---

### Task 8: API — permission matrix, designer cost-blindness and the end-to-end stock test

**Files:**
- Modify: `apps/api/src/modules/stock/routes.js`, `apps/api/src/modules/costing/routes.js` (only if the matrix finds a wrong guard)
- Test: `apps/api/test/stock-permissions.test.js`

**Interfaces:**
- Consumes: Tasks 2–7; `helpers/stock.js`, `helpers/production.js`, `helpers/billing.js`, `helpers/expenses.js`.
- Produces: a route table `[method, path, permissions]` covering every `/v1/stock` and `/v1/costing` route, asserted equal to the routers' declared routes (M4 Task 13 pattern).

- [ ] **Step 1: Write the failing tests** — `designers are refused every stock and costing route except their garments' materials` (403 per row; picker and own-garment materials allowed; another designer's garment 404); `operations are allowed stock routes and refused costing` (`costing.view` 403); `admins are allowed every route`; `designers never receive a cost field` (walk every JSON a designer gets — picker, materials GET/PUT/used, stage action with `materialsUsed`, `GET /v1/orders/:id`, `GET /v1/garments/:id` — and assert none of the Global Constraints money keys appear at any depth); `garment and order responses carry no stock cost`; `from order to profit` (create item with opening stock → order with materials (shortfall) → request ordered → receive with GST bill → reservation filled → designer completes Materials ready with a correction → operations "used more" → bill issued with a rush line and a material sale → credit note → admin `GET /v1/costing/orders/:id` matches hand-computed figures → `expectBalanced` for each item → `POST /v1/admin/audit/verify` ok).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/stock-permissions.test.js` → FAIL until the table is written and any wrong guard fixed.
- [ ] **Step 3: Implement** the table; fix guards it exposes.
- [ ] **Step 4: Run** `npx vitest run --project api && npm run lint` → PASS.
- [ ] **Step 5: Commit** `test(api): stock and costing permission matrix, designer cost-blindness, order-to-profit (M6 Task 8)`

---

### Task 9: Web — Stock: items at a glance, item page, add item, count stock

**Files:**
- Create: `apps/web/src/features/stock/{stockApi.js,qty.js,StockPage.jsx,ItemsTab.jsx,LowStockList.jsx,ItemModal.jsx,StockItemPage.jsx,MovementList.jsx,CountDialog.jsx,QtyStepper.jsx}`, `apps/web/src/test/stock.js`
- Modify: `apps/web/src/App.jsx`, `apps/web/src/layout/navItems.js`, `apps/web/src/lib/errorMessages.js`, `apps/web/src/test/server.js`
- Test: `apps/web/src/features/stock/stock.test.jsx`, `apps/web/src/features/stock/qty.test.js`

**Interfaces:**
- Consumes: Task 2 routes; `formatQty`, `toMilli`, `avgCostOf`, `formatINR`; `LoadMore`, `ResponsiveTable`, `EmptyState`, `Money`, `PageHeader`, `StatusBadge`.
- Produces:
  - `stockApi.js`: `STOCK_KEY = ['stock']`; `useStockItems(filters)` (infinite), `useStockItem(id)`, `useMovements(id)` (infinite), `useLowStock()`, `useCreateItem()`, `useUpdateItem(id)`, `useCountStock(id)`, `usePicker(q)`; mutations invalidate `STOCK_KEY`.
  - `qty.js`: `qtyInput(text) → milli | null` (≤ 3 decimals, via `toMilli`, try/catch); `showQty(milli, unit)` = `formatQty`; `showUnitCost(avgCost, unit) → '₹500.00 per metre'` (4 rupee decimals when under ₹1).
  - `QtyStepper({ value, onChange, step, unit, min = 0 })` — − / value / + buttons ≥ 44 px, tap the value to type; used by Tasks 11.
  - `/stock` → `StockPage` behind `stock.view`, tabs "Items" and "To buy" (Task 10). `ItemsTab`: **"Running low"** block on top (`LowStockList`: each row name, colour, "2 m free · reorder at 5 m" in red, "Order more" button for `stock.write` — Task 10 opens it); search, category chips, rows: name, brand · colour, free in large type, "3 m reserved" small; "Add item" button (bottom on phones, `stock.write`).
  - `ItemModal` — "Name", "Brand", "Category" (suggestions), "Colour", "We use it in" (usage unit, suggestions metre/piece/gram/spool/set), "We buy it in" (purchase unit) + "How many <usage> in one <purchase>?", "+/− step", "Reorder when free stock falls below", "Selling price per <usage> (optional)", and for a new item "Already have some?" → quantity and cost per unit.
  - `/stock/items/:id` → `StockItemPage`: big "In stock 12.5 m", "Reserved for orders 4 m", "Free 8.5 m"; for `money.view`: "Stock value ₹6,250 · Average cost ₹500.00 per metre"; "Count stock" (`CountDialog`: "How many are on the shelf now?" with `QtyStepper`, the difference shown "2 m less than recorded", reason required, cost per unit when the shelf was empty; 409 → "Stock changed while you were counting. Count again."); "Edit"; `MovementList` (paged, plain labels: "Opening stock", "Delivery received", "Reserved for VS/ORD/…-02", "Released", "Used for …", "Put back from …", "Count correction", "Sold on INV/…", "Delivery undone"; signed quantity; value change for `money.view`).
  - Nav: `{ label: 'Stock', path: '/stock', permission: 'stock.view', icon: IconPackage, phone: 'more' }` after Expenses.
  - `errorMessages`: `STOCK_INSUFFICIENT` 'There is not enough of this in stock.' (UI adds name and free from `details` where shown), `UNIT_FIXED` 'The unit cannot change once stock has moved.', `NOTHING_TO_CHANGE` 'The count matches what is recorded.'.

- [ ] **Step 1: Write the failing tests** — `qty.test.js`: `typed quantities become milli-units`; `unit costs under a rupee keep four decimals`. `stock.test.jsx`: `running-low items are listed first in red`; `items show free and reserved stock`; `adding an item with opening stock sends milli-units and paise`; `the item page shows stock, reserved and free; value only with money.view`; `counting stock sends the counted and expected quantities`; `a count conflict asks to count again`; `the history pages and uses plain words`; `designers have no Stock menu and are sent away from /stock`.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement**; routes behind `RequirePermission permission="stock.view"`.
- [ ] **Step 4: Run** `npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Visual check** at 390 and 1280 px (items with a low block, item page, count dialog) with the M4/M5 visual harness seeded with five items, two low.
- [ ] **Step 6: Commit** `feat(web): stock list with running-low items, item page and stock count (M6 Task 9)`

---

### Task 10: Web — "To buy" and "Receive delivery"

**Files:**
- Create: `apps/web/src/features/stock/{ToBuyTab.jsx,RequestModal.jsx,ReceiveDialog.jsx,UndoReceiptDialog.jsx}`
- Modify: `apps/web/src/features/stock/{stockApi.js,StockPage.jsx,LowStockList.jsx,StockItemPage.jsx}`, `apps/web/src/features/expenses/ExpensePage.jsx`, `apps/web/src/lib/errorMessages.js`, `apps/web/src/test/server.js`
- Test: `apps/web/src/features/stock/toBuy.test.jsx`

**Interfaces:**
- Consumes: Task 5 routes; M5 web pieces `PayeePicker`, `ModeButtons`, `BillPhotos`, `GstSection`, `AmountField`, `formToBody` GST helpers (`features/expenses/`); `suggestedOrder`, `toUsage`.
- Produces:
  - `stockApi.js`: `useRequests(status)`, `useCreateRequest()`, `useMarkOrdered(id)`, `useCancelRequest(id)`, `useReceive({ requestId | itemId })` (`{ body, key }`, `idempotencyKey`), `useUndoReceipt(id)`.
  - `ToBuyTab`: open requests, one row per item: "Red silk — 6 m (1 packet)", why ("For VS/ORD/2627/0012-01, -02" / "Running low" / "Added by hand"), status "To order" / "Ordered from Sharma Textiles"; actions "Mark ordered" (vendor optional), "Receive delivery", "Cancel" (reason). Filter "Received" shows past deliveries with "Undo delivery" on the latest one.
  - `RequestModal` — from "Order more" (pre-filled `suggestedOrder`) or "Add to list".
  - `ReceiveDialog` — one screen: "How much arrived?" in purchase units with `QtyStepper` and "= 288 pieces"; "How much did you pay?" (`AmountField`); "Paid to" (`PayeePicker`, defaults to the ordered vendor); "How did you pay?" (`ModeButtons`); "Photo of the bill" (`BillPhotos`); folded "Has a GST bill?" (`GstSection`); button "Save delivery of ₹X". Idempotency-Key made on open, reused on retry. Success notice "Stock added and expense EXP/2627/0031 saved".
  - `UndoReceiptDialog` — reason; "The stock comes back out and the expense is voided."; `RECEIPT_USED` shown in place.
  - Item page: "Receive delivery" (direct). `ExpensePage` (M5): a purchase expense shows "From a stock delivery" with a link to the item and hides Void.
  - `errorMessages`: `RECEIPT_USED`, `EXPENSE_FROM_STOCK`, `INVALID_STATUS` (if not already present) with the API's wording.

- [ ] **Step 1: Write the failing tests** — `to-buy lists one row per item with who it is for`; `order more suggests whole packets`; `marking ordered keeps the vendor`; `receiving sends usage milli-units, the payment and one Idempotency-Key` (retry after a network error reuses the key); `a GST bill on a delivery uses the expense GST section`; `undo delivery needs a reason and explains a used delivery`; `a purchase expense links back to stock and cannot be voided`.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Visual check** at 390 and 1280 px (to-buy list, receive dialog with GST open). Time receiving a delivery on 390 px by hand: ≤ 30 s.
- [ ] **Step 6: Commit** `feat(web): to-buy list and receiving deliveries with their expense (M6 Task 10)`

---

### Task 11: Web — materials on garments and "Materials used" for designers

**Files:**
- Create: `apps/web/src/features/stock/{ItemPicker.jsx,GarmentMaterials.jsx,MaterialsUsed.jsx}`
- Modify: `apps/web/src/features/stock/stockApi.js`, `apps/web/src/features/orders/{GarmentPanel.jsx,StageActionDialog.jsx,new/GarmentsStep.jsx}`, `apps/web/src/features/production/BulkBar.jsx`, `apps/web/src/lib/errorMessages.js`, `apps/web/src/test/server.js`
- Test: `apps/web/src/features/stock/materials.test.jsx`, `apps/web/src/features/orders/stageActions.test.jsx`, `apps/web/src/features/orders/NewOrderPage.test.jsx`

**Interfaces:**
- Consumes: Tasks 3–4 routes; `QtyStepper`, `usePicker`.
- Produces:
  - `stockApi.js`: `useGarmentMaterials(garmentId)`, `useSetGarmentMaterials(garmentId)`, `useChangeUsed(garmentId)`; they also invalidate the order and production queries.
  - `ItemPicker({ onPick })` — search box, rows "Red silk · Raw silk — 8.5 m free"; no prices.
  - `GarmentMaterials({ garment })` on `GarmentPanel` for `stock.write` or `stock.consume.own`: "Materials" card; before Materials ready: each line name + `QtyStepper` + remove, "Add material" (`ItemPicker`), a line short of stock shows "2 m to buy" in amber; "Save" sends `{ version, lines }`. After: "Used" quantities with "Used more" / "Put back" (`QtyStepper` sheet, note). Never a price.
  - `GarmentsStep` (new order): per garment line a folded "Materials (optional)" with the same picker and steppers; a batch line says "Each of the 20 garments gets these".
  - `MaterialsUsed({ garments, value, onChange })` inside `StageActionDialog` when the action is `complete`/`skip` at `materials_ready`: the planned list pre-filled, a stepper per item; one garment → per line; a bulk action → one stepper per item applied to every selected garment that has it ("each garment"), with "Materials as planned" when the garments' lists differ; sends `materialsUsed` only for changed quantities. `BulkBar` passes the selected garments.
  - `errorMessages`: `MATERIALS_ALREADY_USED`, `MATERIALS_NOT_USED_YET`; the stage dialog shows `STOCK_INSUFFICIENT` as "Only {free} of {name} is in stock. Receive the delivery first or change the quantity."

- [ ] **Step 1: Write the failing tests** — `materials.test.jsx`: `a designer adds materials to their garment without seeing prices` (no ₹ anywhere in the card or picker); `a short line shows how much is to buy`; `after Materials ready the card offers used more and put back`. `stageActions.test.jsx`: `completing Materials ready shows the planned materials and sends only corrections` (unchanged → no `materialsUsed`; one − tap → one entry); `a bulk Materials ready applies one quantity to each garment`; `not enough stock explains what to do`. `NewOrderPage.test.jsx`: `materials chosen for a garment line are sent with the order in milli-units`.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Visual check** at 390 px as a designer (garment materials card, Materials ready dialog single and bulk). Count taps for the common case (plan unchanged): open dialog → "Done" = 2.
- [ ] **Step 6: Commit** `feat(web): materials on garments and materials used at Materials ready, without prices (M6 Task 11)`

---

### Task 12: Web — costs and profit on the order page, catalog stock link, whole suite

**Files:**
- Create: `apps/web/src/features/costing/{costingApi.js,OrderCosts.jsx}`
- Modify: `apps/web/src/features/orders/OrderPage.jsx`, `apps/web/src/features/catalog/ItemModal.jsx`, `apps/web/src/lib/errorMessages.test.js`, `apps/web/src/test/server.js`
- Test: `apps/web/src/features/costing/orderCosts.test.jsx`, `apps/web/src/features/catalog/catalog.test.jsx`, `apps/web/src/lib/errorMessages.test.js`

**Interfaces:**
- Consumes: Task 7 route; Task 6 catalog `stockItemId`; `usePicker`.
- Produces:
  - `costingApi.js`: `useOrderCosts(orderId)` (enabled only with `costing.view`).
  - `OrderCosts({ orderId })` on `OrderPage` for `costing.view`: folded "Costs and profit" card; order line "Profit ₹X" (red when negative); per garment rows "Billed / Materials cost / Other costs / Margin"; tap a garment → its materials (name, quantity, cost) and expenses (number, share, link to `/expenses/:id`); a note when a garment has nothing billed yet ("Not billed yet — margin will change").
  - Catalog `ItemModal`: for `kind 'material'`, "Take from stock (optional)" with `ItemPicker`.
  - `errorMessages.test.js` gains every M6 code (`STOCK_INSUFFICIENT`, `UNIT_FIXED`, `NOTHING_TO_CHANGE`, `MATERIALS_ALREADY_USED`, `MATERIALS_NOT_USED_YET`, `RECEIPT_USED`, `EXPENSE_FROM_STOCK`).

- [ ] **Step 1: Write the failing tests** — `orderCosts.test.jsx`: `the admin sees billed, materials, other costs and margin per garment`; `a loss shows in red`; `a garment's breakdown lists materials and expenses`; `operations and designers see no costs card` (no request made). `catalog.test.jsx`: `a material item can be taken from stock`. `errorMessages.test.js`: `every stock error code has a plain message`.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS (whole suite).
- [ ] **Step 5: Visual check** at 390 and 1280 px (order costs card folded and open, catalog item with stock link).
- [ ] **Step 6: Commit** `feat(web): costs and profit per order for the admin; price-list items linked to stock (M6 Task 12)`

---

## Not in M6 (later milestones)

- Dashboard tiles 1 (low stock in "Needs attention"), 7 (stock: low, reserved, profit per stock item) and 11 (profit), the stock movements and valuation register, order and garment profitability and profit-per-item reports — M8 (M6 provides `lowStockItems`, `stockValuation`, `stockItemProfit`, `materialCostTotal`, `orderProfits`, `listMovements` and their indexes).
- Opening stock import from a spreadsheet — M9 if the client wants it.
- Vendor work expenses created automatically from vendor returns; stock transfers between branches; batch/lot tracking, expiry, barcode scanning; partial deliveries kept open on one request (Decision 10 closes and re-requests); `costing.view` for operations (Decision 17); a low-stock digest job (Decision 14).
