# M7 Front Office Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The front desk takes a phone enquiry in about 15 seconds: phone first (the screen says at once "Already a customer: Priya" or "Open enquiry: Priya"), then name, what they want (garment type chips), a rough budget, how they heard of us and when to call back (Tomorrow is preselected). "Follow-ups today" lists who to call; one tap logs the call and the next date. From an enquiry, "Book appointment" picks a designer, a day and a free time (only free times are offered), and "Convert to order" finds the customer by phone (or creates one) and opens New order already filled in (customer, garments by type, budget, occasion date, notes); saving the order marks the enquiry converted. Appointments (consultation, measurement, fitting, pickup) are booked, moved and cancelled from a designer day view; two people can never book the same designer for overlapping times; staff mark them done or no-show; clients and designers get booked/changed/cancelled messages and reminders a day and two hours before. Designers see only their own appointments and never see enquiries or budgets.

**Architecture:** Same modular monolith. Pure rules (appointment time windows, overlap, free start times, which reminder is due, the enquiry status machine) live in `packages/shared/src/frontOffice.js`, so the booking form offers exactly the times the API accepts. Two new API modules: `enquiries` (`model.js`, `service.js` for capture/edit/follow-up/lost/reopen/convert, `queries.js` for lists and M8 figures, `json.js`, `routes.js`) and `appointments` (`model.js` with the `AppointmentLock` collection, `service.js` for book/reschedule/cancel/mark, `queries.js` for the day view, lists and M8 figures, `notifications.js`, `reminders.js`, `jobs.js`, `json.js`, `routes.js`). Dependency direction is one way: `orders → enquiries → customers`, `appointments → enquiries, customers, orders, users, settings`; `enquiries` never imports `appointments` or `orders`, so there is no import cycle. Booking takes the per-(designer, IST date) lock document inside the booking transaction (spec §7.2), so concurrent bookings conflict and are retried by `withTransaction` against fresh data.

**Tech Stack:** As M4/M5. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-vastrasanskara-system-design.md` — §7.1 (enquiries, convert by phone → order pre-filled), §7.2 (appointments, default length from settings, no double-booking via the designer × IST-date lock document, loser retries against fresh data; Google Calendar out of scope), §2.2 (modules `enquiries`, `appointments`; access only through `service.js`), §3.1 (`appointmentDurations` in settings), §3.2 (customer phone unique per branch, sources, consent), §8.1–8.4 (events `appointment.booked`/changed/cancelled immediate to client + designer; reminder 24 h and 2 h before, the 2 h one skipped for the client in quiet hours; reminders job every 15 min; dedupe keys; client messages only with consent), §9.1 tiles 1 (today's fittings), 6 (today's calendar by designer), 8 (enquiry conversion and source) — data shape only, screens are M8, §10.2–10.3 (permissions, designer scoping, money stripping, personal data never logged), §11 (`CONFLICT`, `SLOT_TAKEN`, idempotency), §12 (appointment double-booking under concurrent requests; permission matrix; E2E "enquiry → appointment → convert" — here as an API integration test, Playwright is not set up). M4 ledger carried (`.superpowers/sdd/2026-10-30-m4-billing/progress.md`): a guard that **writes** a document inside the transaction makes a concurrent writer conflict and retry (Tasks 3–4 ruling — the same mechanism as the appointment lock; test both orders of the race, not an impossible interleaving); the permission route table is hand-written but asserted equal to the routers' declared routes (Task 13 ruling); a committed write answers 2xx even if the read-back fails (`respondCommitted`); a notification event is deduped on a stable ref id (Task 12 ruling). **M7 does not depend on M5 or M6**: no import of `expenses`, `stock` or costing code.

## Global Constraints

- Everything in the M1–M5 Global Constraints still applies (integer paise, UTC times + IST business-date strings, `branchId`, `version` in bodies and responses with 409 `CONFLICT`, strict zod, error shape, no personal data in logs, bundled icons, 390 px screens, sentence case, plain words).
- Layout rule (user directive): `apps/api/src/modules/enquiries/` and `apps/api/src/modules/appointments/` each keep `model.js`, `service.js`, focused files (`queries.js`, `json.js`, `routes.js`; appointments also `notifications.js`, `reminders.js`, `jobs.js`). No module reads another's model; `enquiries` must not import `appointments` or `orders`.
- **Permissions:** new `enquiries.write` (admin + operations) for every enquiry route, read included; new `appointments.write` (admin + operations) to book, move, cancel, mark and read any designer's appointments; new `appointments.own` (all three roles) to read **one's own** appointments and mark them done / no-show. Designers have `appointments.own` only: every appointment read is filtered by `designerId = user.id` when the user lacks `appointments.write`; another designer's appointment is 404. Enquiry budgets appear only in enquiry responses (never in appointment responses).
- **Personal data:** names, phones and notes never go into logs or job results (log ids and counts only). Enquiries and appointments are **not** written to the hash-chained audit log (it cannot be erased; these hold personal data and no GST figure); each record keeps `createdBy/updatedBy` and a bounded activity log instead.
- **Phones** are stored E.164 via the shared `phone` schema (`+919876543210`); search by digits as customers do.
- **Times:** appointment input is `date` (IST `YYYY-MM-DD`) + `time` (`HH:mm`, minute 00/15/30/45) + `minutes` (5–480, default `settings.appointmentDurations[type]`); stored `start`/`end` are UTC `Date`s built with `atIstTime`, plus `date` for indexes. An appointment must end by 24:00 IST the same day. Booking or moving to a start before now → 422 `APPOINTMENT_IN_PAST`.
- **No double-booking:** inside the booking/moving transaction, first `AppointmentLock.updateOne({ _id: '<branchId>:<designerId>:<date>' }, { $inc: { n: 1 } }, { upsert: true, session })` for every (designer, date) the write touches (old and new on a move, in sorted `_id` order), **then** the overlap query. Overlap = same designer, `status: 'booked'`, `start < newEnd && end > newStart` (back-to-back allowed). Clash → 422 `SLOT_TAKEN` `'That time is already booked for this designer'` `details: { appointmentId, start, end }`.
- **Idempotency:** `POST /v1/enquiries` and `POST /v1/appointments` require `Idempotency-Key` (a double tap must not make two records or a self-clash); others use `version`.
- **Words in the UI:** "Enquiries", "New enquiry", "Phone", "Name", "Interested in", "Budget (rough)", "How did they hear of us?", "Call back on", "Follow-ups today", "Log a call", "Not interested", "Reopen", "Convert to order", "Appointments", "Book appointment", "Move", "Cancel appointment", "Done", "Didn't come". Types: Consultation, Measurement, Fitting, Pickup. Never "enquiry status", "no_show", "lock".
- Commit subjects end with `(M7 Task N)`. No deploy/infra changes.

## Decisions made in planning

| # | Decision | Why | Cost if wrong |
|---|---|---|---|
| 1 | **Conversion is two steps, one tap each.** "Convert to order" calls `POST /v1/enquiries/:id/convert`: it matches the customer by phone (or uses the one staff picked, or creates one from the enquiry's name, phone and source) and stores `convertedCustomerId`; the enquiry stays open and shows "Customer ready — continue to order". New order opens pre-filled (`/orders/new?enquiry=<id>`); `orderCreateSchema` gains `enquiryId`, and `createOrder` calls `enquiries/service.markEnquiryConverted` **in the order's transaction**, setting `status 'converted'` + `convertedOrderId`. | Spec §7.1 links both customer and order. Marking converted only when an order exists means an abandoned order form never leaves a "converted" enquiry with no order, and the order and the enquiry change commit together. | If the owner wants "converted" on customer creation: move one status assignment. |
| 2 | **Double-booking is refused with 422 `SLOT_TAKEN`, not 409.** Concurrent bookings for one designer-day write the same lock document; MongoDB aborts the loser with a write conflict (`TransientTransactionError`), `withTransaction` re-runs it against the committed data, and the overlap check then refuses it with the clashing appointment in `details`. A 409 `CONFLICT` remains only for stale `version`s. | Spec §7.2's "loser retries against fresh data" is done by the server, so staff see the useful answer ("that time was just booked — pick another") instead of a generic reload; `SLOT_TAKEN` is the spec's §11 code. | None: the lock and check are as specified. |
| 3 | **Enquiries never import appointments.** Booking for an enquiry moves it `new/contacted → appointment_booked` through `enquiries/service.noteAppointmentBooked`; after conversion, the enquiry's appointments are **not rewritten** — appointment reads and notifications resolve the client as `customerId ?? enquiry.convertedCustomerId`. | No import cycle, no cross-module bulk update; the customer gets reminders for appointments booked while they were an enquiry. | A one-time backfill if a later report needs `customerId` stored. |
| 4 | **One open enquiry per phone** (partial unique index `open_phone (branchId, phone)` where `isOpen: true`). A second capture → 409 `ENQUIRY_EXISTS` `details: { enquiryId }`; the form checks the phone first (`GET /v1/enquiries/check-phone`) and offers "Open it". A phone that is already a customer is allowed (repeat clients enquire again) and shown as "Already a customer". | Stops duplicate follow-up calls to the same person; the index also wins the double-submit race. | Drop the index; the check stays as a hint. |
| 5 | Enquiry **name and phone are required**; interest is garment-type chips (settings `garmentTypes`, ≤ 10) plus optional details text; budget optional (paise); `source` uses the **customer sources** (`instagram`, `referral`, `walk_in`, `website`, `film_industry`, `other`), so conversion copies it 1:1; optional `occasionDate`; follow-up date defaults to **tomorrow**. | Spec §7.1 fields; chips are fewest taps and pre-fill garment lines on the order; occasion date pre-fills the order (bridal work is planned around it). | Phone optional for DM enquiries: the unique index and convert match need a fallback — one task. |
| 6 | **Enquiry status machine:** `new → contacted` (any logged call), `new/contacted → appointment_booked` (automatic), any open → `lost` (reason required, chips "Too expensive", "Went elsewhere", "Could not reach", "Plans changed", "Other" + text), `lost → contacted` ("Reopen", re-checks the open-phone rule), open → `converted` (only through an order). `converted` is final. `isOpen = status ∈ {new, contacted, appointment_booked}` is stored for indexes. | Matches spec statuses; storing `isOpen` lets the follow-ups and phone indexes be plain equality (partial indexes cannot use `$in`). | — |
| 7 | **Activity log** on an enquiry: `log: [{ at, by, kind: 'call' | 'status' | 'appointment' | 'note', text }]`, newest last, capped at 100 with `$push … $slice: -100`. "Log a call" = text (may be empty) + next call-back date or "No more calls". | One place to see what was said, bounded document size. | — |
| 8 | **No audit-log entries** for enquiries or appointments. | The hash-chained log is append-only and cannot honour a DPDP erasure; these records carry personal data and no money. `createdBy/updatedBy`, `log` and appointment `statusBy/statusAt` answer "who did it". | Add `recordAudit` calls without personal fields later. |
| 9 | **Permissions:** `enquiries.write` and `appointments.write` for admin + operations; `appointments.own` for all roles. **Designers cannot book or move** appointments, only see their own and mark them "Done"/"Didn't come". | Front desk owns the calendar; designers need their day and to close it out; security: designers see no enquiry list or budgets. | Letting designers book their own: give them `appointments.write` scoped by a check in `bookAppointment` — one task. |
| 10 | **Designer is required for every type**, including pickup (front desk picks who hands over). Defaults: the order's designer for a fitting or pickup; the last designer booked for that customer/enquiry otherwise. | Every appointment then sits in one day column and is covered by the lock; one rule, no "unassigned" lane. | A designer-less pickup lane: nullable `designerId` with no lock — small. |
| 11 | **Booking hours are a guide, not a rule.** New setting `openingTime` (default `'10:00'`); the form offers free start times from `openingTime` to `closingTime` in 15-minute steps; "Another time" allows any quarter hour. The API refuses only the past, overlaps and crossing midnight. | Owners book evening trials for brides; refusing would block real work. | Make it a rule: one check in `bookAppointment`. |
| 12 | **Fittings may name garments** (`garmentIds`, ≤ 20): each must be the appointment customer's, not `cancelled`/`picked_up` (`orders/service.getGarmentsForAppointment`). Fittings for an enquiry (no customer yet) carry none. The garment panel at "Trials and fittings" gets "Book a fitting". | Spec §7.2 `garmentIds (fittings)`; linking from the stage the designer was just told about is one tap. | — |
| 13 | **Reminders:** job `appointments-reminders` every 15 min (`*/15 * * * *`) scans `status 'booked'` and `start ∈ (now, now + 24 h]` on index `reminders (status, start)`. `reminderDue({ start, scheduledAt, now })` → `'day'` when `start − now ≤ 24 h`, `start − now > 2 h` and `start − scheduledAt > 24 h`; `'soon'` when `start − now ≤ 2 h` and `start − scheduledAt > 2 h`; else null. `scheduledAt` = when booked or last moved. The `soon` reminder leaves the client out when `now` is inside the quiet hours of any client channel of the rule (spec: "skipped", not held); the designer still gets it. Dedupe `appointment.reminder:<id>:<startISO>:<1|2>` — moving an appointment re-arms reminders. | Spec §8.3/§8.4; no stored "reminded" flags to drift; a worker restart cannot double-send. | Change thresholds: one pure function. |
| 14 | **Change messages:** `appointment.booked` (ref `<id>`), `appointment.changed` (ref `<id>:<version>`, sent when date/time/length/designer changed), `appointment.cancelled` (ref `<id>`). Moving to another designer also sends `appointment.cancelled` to the **old designer only** (ref `<id>:moved:<version>`, no client). Done/no-show send nothing. Client templates are email (shipped channel); designers in-app + email. | Spec §8.3 "booked / changed / cancelled → client, designer, immediate". | Templates are editable in settings. |
| 15 | The `designer` recipient resolver moves from `production/notifications.js` to `core/notify/recipients.js` (unchanged behaviour), so appointment events never depend on the production module being imported first. | Today it works only because production happens to load; the worker imports jobs in a fixed order. | None. |
| 16 | **Indexes:** enquiries `open_phone (branchId, phone)` unique partial `{ isOpen: true }`; `follow_ups (branchId, isOpen, followUpDate, _id)`; `by_status (branchId, status, enquiryDate, _id)`; `by_date (branchId, enquiryDate)` (M8 tile 8); `by_name (branchId, searchName)`; `by_phone (branchId, phone, enquiryDate)`; `converted_customer (branchId, convertedCustomerId)` partial on objectId. Appointments `by_day (branchId, date, start)`; `by_designer_day (branchId, designerId, date, start)`; `reminders (status, start)`; `by_customer (branchId, customerId, start)` and `by_enquiry (branchId, enquiryId, start)` partial on objectId. Every list is paginated (`paginate`, ≤ 100) or bounded to one day. | Owner priority: bounded indexed queries. | Add an index if M8 explain shows otherwise. |
| 17 | **Navigation:** "Enquiries" (`IconPhoneCall`) and "Appointments" (`IconCalendarEvent`) under More on phones (the bottom bar keeps its first four); **Home** gets "New enquiry" and "Book appointment" buttons and two short lists — "Follow-ups today" (enquiries.write) and "Today's appointments" (own for designers, all for front desk). | One tap from Home for the two daily jobs without displacing Orders/Bills. | Nav order only. |
| 18 | Marking **Done / Didn't come** is allowed from the appointment's day onwards (`date ≤ today`, else 422 `APPOINTMENT_NOT_DUE`); cancelling is allowed while `booked` (reason optional). Changing a non-booked appointment → 422 `APPOINTMENT_CLOSED`. Type and party never change (cancel and book again). | Prevents marking tomorrow's client as a no-show by mistake. | — |

## Review Focus

1. **Two bookings for the same designer and time at once** (two phones, or a double tap) — exactly one is booked; the other gets "That time is already booked" naming the booked slot; back-to-back slots both succeed; moving into a taken slot is refused the same way. → Task 5 tests `concurrent bookings of one slot book exactly one`, `concurrent bookings of adjacent slots both succeed`, `a move into a slot booked meanwhile is refused`, `double tap with one key books once`.
2. **IST dates around midnight and the day boundary** — an 23:30 IST appointment on 7 Nov is `date '2026-11-07'` though its UTC start is the 7th 18:00; a 23:45 + 30 min appointment is refused; the day view for 7 Nov contains it and not 8 Nov's 00:15. → Task 1 test `appointment windows are IST and never cross midnight` (run under `test:tz`); Task 6 test `the day view is the IST day`.
3. **A designer seeing someone else's data** — another designer's appointment is 404, the day view shows only their column, no enquiry route answers them, and no appointment response holds a budget. → Task 8 tests `designers see only their own appointments`, `designers are refused every enquiry route`, `no appointment response carries a budget`.
4. **The same phone captured twice, or converted when already a customer** — a second open enquiry is refused with a link to the first; converting matches the existing customer by phone instead of failing on `PHONE_TAKEN`; the new order marks the enquiry converted only if the order commits. → Task 3 test `a second open enquiry for a phone is refused`; Task 4 tests `converting finds the customer by phone`, `an order that fails leaves the enquiry open`.
5. **Reminders sent twice, too late, or at night** — re-running the job sends nothing new; an appointment booked 3 h ahead gets no "tomorrow" reminder; the 2 h reminder at 08:00 for a 10:00 appointment goes to the designer but not the client (quiet until 09:00); a moved appointment gets fresh reminders; cancelled ones none. → Task 7 tests `re-running reminders queues nothing new`, `a late booking skips the day-before reminder`, `the two-hour reminder skips the client in quiet hours`, `moving an appointment re-arms its reminders`.

---

## File Structure

```
packages/shared/src/
  frontOffice.js                APPOINTMENT_TYPES, APPOINTMENT_STATUSES, ENQUIRY_STATUSES, OPEN_ENQUIRY_STATUSES,
                                LOST_REASONS, SLOT_STEP_MINUTES, appointmentWindow, overlaps, freeStartTimes,
                                reminderDue, nextEnquiryStatus, appointmentWhen, REMINDER_* constants
  schemas/frontOffice.js        enquiry*, appointment* request schemas and list queries
  schemas/customers.js          + export CUSTOMER_SOURCES
  schemas/orders.js             + orderCreateSchema.enquiryId
  schemas/settings.js           + openingTime
  permissions.js                + ENQUIRIES_WRITE, APPOINTMENTS_WRITE, APPOINTMENTS_OWN
  index.js                      + exports
apps/api/src/
  core/notify/recipients.js     + 'designer' resolver (moved from production/notifications.js)
  modules/enquiries/
    model.js                    Enquiry; named indexes
    service.js                  createEnquiry, updateEnquiry, logCall, markLost, reopenEnquiry, convertEnquiry,
                                getEnquiry, checkPhone, noteAppointmentBooked, markEnquiryConverted,
                                getEnquiryParties (+ re-exports of queries.js)
    queries.js                  listEnquiries, followUpsDue, enquiryConversionBySource
    json.js                     toEnquiryJson, toEnquiryRowJson
    routes.js                   enquiriesRouter()
  modules/appointments/
    model.js                    Appointment, AppointmentLock; named indexes
    service.js                  bookAppointment, moveAppointment, cancelAppointment, markAppointment,
                                getAppointment (+ re-exports of queries.js)
    queries.js                  appointmentsForDay, listAppointments, appointmentCounts
    notifications.js            event definitions, emitAppointmentEvent
    reminders.js                runAppointmentReminders
    jobs.js                     defineJob('appointments-reminders')
    json.js                     toAppointmentJson
    routes.js                   appointmentsRouter()
  modules/customers/service.js  + findCustomerByPhone; createCustomer(..., { session })
  modules/orders/service.js     + getGarmentsForAppointment; createOrder marks the enquiry converted
  modules/production/notifications.js   - designer resolver (moved)
  app.js                        mount /v1/enquiries, /v1/appointments
  jobs.js                       + './modules/appointments/jobs.js'
apps/api/test/
  helpers/frontOffice.js, enquiries.test.js, enquiries-convert.test.js, appointments-book.test.js,
  appointments-read.test.js, appointments-notify.test.js, front-office-permissions.test.js
apps/web/src/
  features/enquiries/{enquiriesApi.js, enquiryForm.js, NewEnquiryPage.jsx, PhoneCheck.jsx, InterestChips.jsx,
                      FollowUpChips.jsx, EnquiriesPage.jsx, EnquiryPage.jsx, LogCallDialog.jsx, LostDialog.jsx,
                      ConvertDialog.jsx}
  features/appointments/{appointmentsApi.js, bookingForm.js, BookAppointmentPage.jsx, PartyPicker.jsx,
                         TimeChips.jsx, AppointmentsPage.jsx, DayColumn.jsx, AppointmentCard.jsx,
                         MoveDialog.jsx, CancelDialog.jsx, PartyAppointments.jsx}
  features/orders/NewOrderPage.jsx (enquiry prefill), features/orders/GarmentPanel.jsx (Book a fitting),
  features/customers/CustomerPage.jsx (appointments), features/home/HomePage.jsx,
  features/settings/AppointmentsTab.jsx (opening time), layout/navItems.js, App.jsx, lib/errorMessages.js,
  test/server.js, test/frontOffice.js
```

---

### Task 1: Shared — front-office rules, permissions and the opening time setting

**Files:**
- Create: `packages/shared/src/frontOffice.js`
- Modify: `packages/shared/src/permissions.js`, `packages/shared/src/schemas/settings.js`, `packages/shared/src/schemas/customers.js`, `packages/shared/src/index.js`
- Test: `packages/shared/test/frontOffice.test.js`, `packages/shared/test/permissions.test.js`, `packages/shared/test/settings.test.js`

**Interfaces:**
- Consumes: `atIstTime`, `istDate`, `addDaysYmd`, `displayDate` (fy.js).
- Produces (`permissions.js`): `ENQUIRIES_WRITE: 'enquiries.write'`, `APPOINTMENTS_WRITE: 'appointments.write'` (admin + operations, not designers), `APPOINTMENTS_OWN: 'appointments.own'` (all three roles: add to the designer list).
- Produces (`schemas/settings.js`): `openingTime: hhmm`, `DEFAULT_SETTINGS.openingTime = '10:00'`; refine on the settings object: `openingTime < closingTime` (path `openingTime`, "Opening time must be before closing time") — only when both are present in a patch.
- Produces (`schemas/customers.js`): `export const CUSTOMER_SOURCES` (the existing `SOURCES` array, frozen).
- Produces (`frontOffice.js`), all pure:
  - `APPOINTMENT_TYPES = ['consultation', 'measurement', 'fitting', 'pickup']`; `APPOINTMENT_TYPE_LABELS` (Consultation, Measurement, Fitting, Pickup); `APPOINTMENT_STATUSES = ['booked', 'completed', 'no_show', 'cancelled']`; `SLOT_STEP_MINUTES = 15`.
  - `ENQUIRY_STATUSES = ['new', 'contacted', 'appointment_booked', 'converted', 'lost']`; `OPEN_ENQUIRY_STATUSES = ['new', 'contacted', 'appointment_booked']`; `LOST_REASONS = ['Too expensive', 'Went elsewhere', 'Could not reach', 'Plans changed', 'Other']`; `MAX_ENQUIRY_LOG = 100`.
  - `appointmentWindow({ date, time, minutes }) → { start: Date, end: Date }` — `start = atIstTime(date, time)`, `end = start + minutes`; throws `RangeError('APPOINTMENT_CROSSES_MIDNIGHT')` when `end > atIstTime(addDaysYmd(date, 1), '00:00')`.
  - `overlaps(a, b) → boolean` — `a.start < b.end && a.end > b.start` (Dates or ms).
  - `freeStartTimes({ date, minutes, taken: [{ start, end }], from: 'HH:mm', to: 'HH:mm', now }) → ['HH:mm']` — every quarter hour `t` with `from ≤ t` and `t + minutes ≤ to`, start after `now`, not overlapping any `taken`.
  - `reminderDue({ start, scheduledAt, now }) → 'day' | 'soon' | null` (Decision 13; `REMINDER_DAY_MS = 24 h`, `REMINDER_SOON_MS = 2 h`).
  - `nextEnquiryStatus(current, action) → status` — actions `'call'`, `'appointment'`, `'lost'`, `'reopen'`, `'convert'`; throws `RangeError('ENQUIRY_CLOSED')` for any action on `converted`, for `call`/`appointment`/`lost`/`convert` on `lost`, and for `reopen` on an open one. `call` on `appointment_booked` keeps it.
  - `appointmentWhen(start: Date) → 'Sat 7 Nov, 11:30 am'` (IST).

- [ ] **Step 1: Write the failing tests** — `frontOffice.test.js`: `appointment windows are IST and never cross midnight` (2026-11-07 23:30 + 15 → start `2026-11-07T18:00:00Z`; 23:45 + 30 throws; 00:00 + 480 ok); `back-to-back appointments do not overlap`; `free start times skip taken slots, the past and the closing time` (10:00–13:00, 60 min, taken 11:00–11:45, now 10:20 → `['11:45', '12:00']`… exact list asserted); `a day reminder is due within 24 hours only for appointments booked earlier`; `a soon reminder is due within 2 hours unless booked within 2 hours`; `no reminder after the start`; `a logged call moves a new enquiry to contacted`; `booking moves an open enquiry to appointment booked`; `a converted enquiry accepts nothing`; `only a lost enquiry can be reopened`; `appointment times read like Sat 7 Nov, 11:30 am`. `permissions.test.js`: `enquiries and booking are for admin and operations`; `designers can see their own appointments only`. `settings.test.js`: `default settings open at 10:00`; `opening time must be before closing time`.
- [ ] **Step 2: Run** `npx vitest run --project shared` → FAIL (module missing).
- [ ] **Step 3: Implement** `frontOffice.js`, the permissions, the setting, the export.
- [ ] **Step 4: Run** `npx vitest run --project shared && npm run test:tz && npx vitest run --project web && npm run lint` → PASS (web Settings tests render `DEFAULT_SETTINGS`).
- [ ] **Step 5: Commit** `feat(shared): appointment windows, free times, reminders and enquiry statuses (M7 Task 1)`

---

### Task 2: Shared — enquiry and appointment request schemas; orders take an enquiry

**Files:**
- Create: `packages/shared/src/schemas/frontOffice.js`
- Modify: `packages/shared/src/schemas/orders.js`, `packages/shared/src/index.js`
- Test: `packages/shared/test/m7-schemas.test.js`, `packages/shared/test/orders-schemas.test.js` (or the existing orders schema test file)

**Interfaces:**
- Consumes: `objectId`, `phone`, `paise`, `hhmm` (common.js); `ymd` (orders.js); `garmentTypeKey` (settings.js); `CUSTOMER_SOURCES`; Task 1 constants.
- Produces (`schemas/orders.js`): `orderCreateSchema.enquiryId: objectId.nullable().default(null)`.
- Produces (`schemas/frontOffice.js`):
  - Enquiry fields (no defaults): `name` trim 1–100; `phone`; `garmentTypes` array of `garmentTypeKey` ≤ 10, unique; `interest` trim ≤ 300; `budget` `paise.max(1_000_000_000).nullable()`; `source` enum `CUSTOMER_SOURCES`; `occasionDate` ymd nullable; `followUpDate` ymd nullable; `note` trim ≤ 500.
  - `enquirySchema` — fields with defaults (`garmentTypes []`, `interest ''`, `budget null`, `source 'walk_in'`, `occasionDate null`, `followUpDate null`, `note ''`). (The form sends tomorrow; the API does not invent a date.)
  - `enquiryPatchSchema` — fields without `note`, `.partial()`, no defaults, "Nothing to update"; used via `versioned`.
  - `logCallSchema { note: trim ≤ 500 default '', followUpDate: ymd.nullable() }`; `lostSchema { reason: trim 1–200 }`; `reopenSchema {}`; `convertSchema { customerId: objectId.nullable().default(null) }` — all via `versioned`.
  - `enquiryListQuery` strict: `view` enum `['follow_ups', 'open', 'new', 'appointment_booked', 'converted', 'lost', 'all']` default `'open'`; `q` ≤ 50; `cursor` ≤ 500; `limit` 1–100 (coerced).
  - `checkPhoneQuery { phone }`.
  - Appointment: `time = hhmm.refine(m % 15 === 0, 'Choose a time on the quarter hour')`; `minutes = z.int().min(5).max(480)`.
  - `appointmentSchema` — `type` enum `APPOINTMENT_TYPES`; `designerId` objectId; `customerId` objectId nullable default null; `enquiryId` objectId nullable default null; `date` ymd; `time`; `minutes` optional (service fills from settings); `garmentIds` array objectId ≤ 20 unique default `[]`; `note` trim ≤ 300 default `''`. Refine: exactly one of `customerId`/`enquiryId` (path `customerId`, "Choose who the appointment is for"); `garmentIds` only for `fitting` (path `garmentIds`); `date + time + minutes` within the day (`appointmentWindow` does not throw; path `minutes`, "The appointment must end by midnight").
  - `appointmentMoveSchema` — `{ designerId, date, time, minutes, garmentIds, note }` `.partial()`, non-empty; via `versioned`. (The service re-checks the merged window.)
  - `appointmentCancelSchema { reason: trim ≤ 200 default '' }`; `appointmentMarkSchema { status: enum ['completed', 'no_show'] }` — via `versioned`.
  - `appointmentDayQuery { date: ymd, designerId: objectId optional }`; `appointmentListQuery` strict: `from`, `to` ymd optional, `designerId`, `customerId`, `enquiryId` optional, `status` enum optional, `cursor`, `limit`.

- [ ] **Step 1: Write the failing tests** — `m7-schemas.test.js`: `an enquiry needs a name and a valid phone`; `phones are stored in international form` (`'98765 43210'` → `'+919876543210'`); `interest chips are garment types, at most ten, no repeats`; `a budget is paise and may be empty`; `an enquiry patch is never filled with defaults and cannot be empty`; `a lost enquiry needs a reason`; `an appointment is for a customer or an enquiry, not both`; `garments go only on fittings`; `times are on the quarter hour`; `an appointment must end by midnight`; `a move cannot be empty`; `done or didn't come are the only marks`; `unknown keys are refused`. Orders: `an order may name the enquiry it came from`.
- [ ] **Step 2: Run** `npx vitest run --project shared` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project shared && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(shared): enquiry and appointment request schemas; orders can name their enquiry (M7 Task 2)`

---

### Task 3: API — enquiries: capture, phone check, edit, log a call, lost, reopen, lists

**Files:**
- Create: `apps/api/src/modules/enquiries/{model.js,service.js,queries.js,json.js,routes.js}`, `apps/api/test/helpers/frontOffice.js`
- Modify: `apps/api/src/modules/customers/service.js`, `apps/api/src/app.js`
- Test: `apps/api/test/enquiries.test.js`

**Interfaces:**
- Consumes: Tasks 1–2; `withTransaction`, `paginate`, `idempotent`, `validate`, `versioned`, `requirePermission`, `actorFrom`, `conflict`, `notFound`, `businessRule`, `AppError`, `getUserNames`, `istDate`, `clock`.
- Produces (`customers/service.js`): `findCustomerByPhone(branchId, phone, session) → lean customer | null`.
- Produces (`model.js`): `Enquiry` (`enquiries`): `{ branchId, name, searchName, phone, garmentTypes: [String], interest, budget (null), source, occasionDate (null), followUpDate (null), status, isOpen, lostReason (null), enquiryDate (IST ymd of creation), convertedCustomerId (null), convertedOrderId (null), convertedAt (null), log: [{ at, by, kind, text, _id: false }] }` + `commonFields`; indexes per Decision 16 (named).
- Produces (`service.js`):
  - `createEnquiry(branchId, input, actor) → enquiry` — `searchName = name.toLowerCase()`, `status 'new'`, `isOpen true`, `enquiryDate = istDate(now)`, first log entry `{ kind: 'note', text: input.note }` when a note is given; duplicate open phone (pre-check and E11000 on `open_phone`) → 409 `ENQUIRY_EXISTS` `'There is already an open enquiry for this phone'` `details: { enquiryId }`.
  - `checkPhone(branchId, phone) → { customer: { id, name } | null, openEnquiry: { id, name, status } | null }`.
  - `getEnquiry(branchId, id, session) → lean | 404`.
  - `updateEnquiry(branchId, id, { version, patch }, actor)` — 404/409; closed → 422 `ENQUIRY_CLOSED` `'This enquiry is closed'`; phone change re-checks `ENQUIRY_EXISTS`; `increment()`.
  - `logCall(branchId, id, { version, patch: { note, followUpDate } }, actor)` — `status = nextEnquiryStatus(status, 'call')`; `followUpDate` set (null = no more calls); log `{ kind: 'call', text: note || 'Called' }`.
  - `markLost(branchId, id, { version, patch: { reason } }, actor)` — `status 'lost'`, `isOpen false`, `lostReason`, `followUpDate null`, log `status`.
  - `reopenEnquiry(branchId, id, { version }, actor)` — `lost → contacted`, `isOpen true`, `lostReason null`, `followUpDate = today`; another open enquiry on the phone → 409 `ENQUIRY_EXISTS`.
  - Every write maps a `RangeError('ENQUIRY_CLOSED')` from `nextEnquiryStatus` to 422 `ENQUIRY_CLOSED`, and pushes the log with `$slice: -MAX_ENQUIRY_LOG` semantics (trim the array in the document before save).
- Produces (`queries.js`, re-exported by `service.js`):
  - `listEnquiries(branchId, { view, q, cursor, limit }, { today }) → { items, nextCursor }` — `follow_ups`: `isOpen: true, followUpDate ≤ today`, sort `followUpDate` asc (`follow_ups` index); `open`: `isOpen: true`, sort `enquiryDate` desc; status views: that status, sort `enquiryDate` desc (`by_status`); `all`: sort `enquiryDate` desc; `q` digits → phone contains digits, else `searchName` prefix (escaped).
  - `followUpsDue(branchId, today) → { count, overdue }` (`overdue` = `followUpDate < today`) — one `$facet` on `follow_ups`. **M8 tile 1 / Home.**
- Produces (`json.js`): `toEnquiryJson(e, { names })` → `{ id, name, phone, garmentTypes, interest, budget, source, occasionDate, followUpDate, status, isOpen, lostReason, enquiryDate, convertedCustomer: { id } | null, convertedOrder: { id } | null, log: [{ at, by: { id, name }, kind, text }], createdAt, version }` (Task 4 fills `convertedCustomer.name/phone` and `convertedOrder.orderNo`); `toEnquiryRowJson` → `{ id, name, phone, garmentTypes, interest, source, followUpDate, status, enquiryDate, overdue }`.
- Produces (`routes.js`): `enquiriesRouter()` at `/v1/enquiries`, all `enquiries.write`: `GET /` (`enquiryListQuery`) → `{ items, nextCursor }`; `GET /check-phone?phone=` → check; `GET /follow-ups/count` → `followUpsDue`; `POST /` (`idempotent()`) → 201 `{ enquiry }` (respondCommitted); `GET /:id`; `PATCH /:id`; `POST /:id/call`; `POST /:id/lost`; `POST /:id/reopen` → `{ enquiry }`. Static paths declared before `/:id`.
- Produces (test helper `helpers/frontOffice.js`): `frontOfficeHelpers(app)` → `{ world() /* admin, operations, two designers, a customer with email consent, settings */, addEnquiry(agent, body?), book(agent, body), atIst(date, time) /* vi.spyOn(clock, 'now') */ }`.

- [ ] **Step 1: Write the failing tests** — `enquiries.test.js`: `a phone enquiry is saved as new with today's date`; `the phone check finds a customer and an open enquiry`; `a second open enquiry for a phone is refused` (409 `ENQUIRY_EXISTS` with `enquiryId`; `Promise.all` of two creates with different keys → one 201, one 409); `saving twice with one key makes one enquiry`; `logging a call moves it to contacted and sets the next call`; `no more calls clears the follow-up date`; `today's follow-ups list due and overdue enquiries, oldest first, without closed ones`; `a lost enquiry needs a reason and leaves the follow-ups`; `a lost enquiry can be reopened unless the phone has a new open enquiry`; `a closed enquiry cannot be edited`; `a stale version is a conflict`; `search finds a phone or a name`; `the log keeps the last hundred entries`; `enquiry queries use indexes` (`explain` of follow-ups, open list, phone check has no `COLLSCAN`); `no phone or name reaches the logs` (`captureLogger` over create + call: no `+91`, no name).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/enquiries.test.js` → FAIL.
- [ ] **Step 3: Implement**; mount `enquiriesRouter()` at `/v1/enquiries` in `app.js`.
- [ ] **Step 4: Run** `npx vitest run apps/api/test/enquiries.test.js apps/api/test/customers.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): capture enquiries, follow-ups, lost and reopen (M7 Task 3)`

---

### Task 4: API — convert an enquiry: customer by phone, then the order marks it converted

**Files:**
- Modify: `apps/api/src/modules/enquiries/{service.js,json.js,routes.js}`, `apps/api/src/modules/customers/service.js`, `apps/api/src/modules/orders/service.js`
- Test: `apps/api/test/enquiries-convert.test.js`, `apps/api/test/orders-create.test.js`

**Interfaces:**
- Consumes: Task 3; `createCustomer`, `findCustomerByPhone`, `getCustomer`, `getOrderNumbers` (orders/service — **routes only**, the enquiries service never imports orders).
- Produces (`customers/service.js`): `createCustomer(branchId, input, actor, { session } = {})` — with `session`, runs its body in the caller's transaction (no own `withTransaction`); without, unchanged.
- Produces (`enquiries/service.js`):
  - `convertEnquiry(branchId, id, { version, patch: { customerId } }, actor) → { enquiry, customer, matched: boolean }` — one transaction: load (404/409; `nextEnquiryStatus(status, 'convert')` must not throw → else 422 `ENQUIRY_CLOSED`); customer = given `customerId` (`getCustomer`, must exist in the branch) → else `findCustomerByPhone(phone)` (`matched: true`) → else `createCustomer({ name, phone, source }, actor, { session })` (branch state, no consent: consent is asked when the order is taken); sets `convertedCustomerId`, log `{ kind: 'status', text: 'Customer ready' }`; status unchanged. Calling it again returns the same customer (idempotent by state).
  - `markEnquiryConverted(branchId, enquiryId, { orderId, customerId }, actor, session)` — must run in a transaction (throws otherwise); enquiry missing → 400 `enquiryId` "Not found"; closed → 422 `ENQUIRY_CLOSED`; `convertedCustomerId` set and ≠ `customerId` → 422 `ENQUIRY_CUSTOMER_MISMATCH` `'This enquiry was converted for a different customer'`; sets `status 'converted'`, `isOpen false`, `convertedOrderId`, `convertedAt`, `convertedCustomerId = customerId`, `followUpDate null`, log; `increment()`.
  - `getEnquiryParties(branchId, ids, session) → Map<id, { name, phone, convertedCustomerId, isOpen }>` (for appointments).
- Produces (`orders/service.js`): `createOrder` calls `markEnquiryConverted(branchId, input.enquiryId, { orderId: order._id, customerId: input.customerId }, actor, session)` inside its transaction when `input.enquiryId` is set; `enquiryId` is not stored on the order.
- Produces (`json.js`/routes): `toEnquiryJson` fills `convertedCustomer: { id, name, phone }` and `convertedOrder: { id, orderNo }`; `POST /v1/enquiries/:id/convert` (`enquiries.write`, `versioned(convertSchema)`) → `{ enquiry, customer: toCustomerJson, matched }`.

- [ ] **Step 1: Write the failing tests** — `enquiries-convert.test.js`: `converting finds the customer by phone` (`matched: true`, no new customer); `converting creates a customer from the enquiry` (name, phone, source copied; branch state; no consent); `staff can pick a different customer`; `converting twice gives the same customer`; `a lost or converted enquiry cannot be converted`; `the order taken from an enquiry marks it converted` (POST `/v1/orders` with `enquiryId` → enquiry `converted`, `convertedOrderId`, not open, off the follow-ups); `an order that fails leaves the enquiry open` (pickup in the past → 422; enquiry unchanged); `an order for another customer than the converted one is refused` (422 `ENQUIRY_CUSTOMER_MISMATCH`, no order number used); `a converted enquiry frees the phone for a new enquiry`. `orders-create.test.js`: `an order without an enquiry is unchanged`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/enquiries-convert.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/enquiries-convert.test.js apps/api/test/enquiries.test.js apps/api/test/orders-create.test.js apps/api/test/customers.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): convert enquiries to customers by phone; orders taken from an enquiry close it (M7 Task 4)`

---

### Task 5: API — book, move, cancel and mark appointments with the designer-day lock

**Files:**
- Create: `apps/api/src/modules/appointments/{model.js,service.js,json.js,routes.js}`
- Modify: `apps/api/src/modules/orders/service.js`, `apps/api/src/app.js`
- Test: `apps/api/test/appointments-book.test.js`

**Interfaces:**
- Consumes: Tasks 1–4; `isActiveDesigner`, `getUserNames` (users); `getCustomer`, `getCustomerNames` (customers); `getEnquiry`, `getEnquiryParties`, `noteAppointmentBooked` (enquiries); `readSettings`; `withTransaction`, `idempotent`.
- Produces (`enquiries/service.js`): `noteAppointmentBooked(branchId, enquiryId, { appointmentId, when }, actor, session)` — open enquiry required (else 422 `ENQUIRY_CLOSED`); `status = nextEnquiryStatus(status, 'appointment')`; log `{ kind: 'appointment', text: 'Appointment booked for <when>' }`.
- Produces (`orders/service.js`): `getGarmentsForAppointment(branchId, garmentIds, session) → [{ id, garmentNo, description, status, orderId, customerId, designerId }]` (no user scope).
- Produces (`model.js`):
  - `Appointment` (`appointments`): `{ branchId, type, designerId, customerId (null), enquiryId (null), date, start, end, minutes, status, garmentIds: [ObjectId], note, scheduledAt, statusAt (null), statusBy (null), cancelReason (null) }` + `commonFields` (version). Indexes per Decision 16.
  - `AppointmentLock` (`appointmentLocks`): `{ _id: String, n: Number }`; export `lockDesignerDay(branchId, designerId, date, session)` (the `$inc` upsert; throws outside a transaction).
- Produces (`service.js`), each in one `withTransaction` with one `now = clock.now()`:
  - `bookAppointment(branchId, input, actor) → appointment` — designer must be active (400 `designerId` "Choose a designer"); party: `customerId` → `getCustomer`; `enquiryId` → `getEnquiry`, must be open (422 `ENQUIRY_CLOSED`; a converted enquiry is booked through its customer by the UI); `minutes = input.minutes ?? settings.appointmentDurations[type]`; window via `appointmentWindow` (RangeError → 400 `minutes`); `start < now` → 422 `APPOINTMENT_IN_PAST` `'This time has already passed'`; fitting garments via `getGarmentsForAppointment`: each must belong to the customer and not be `cancelled`/`picked_up` (400 `garmentIds`); `lockDesignerDay` then overlap query → 422 `SLOT_TAKEN`; create (`scheduledAt = now`); enquiry → `noteAppointmentBooked`. Returns `{ appointment, previous: null }` for Task 7's emit.
  - `moveAppointment(branchId, id, { version, patch }, actor) → { appointment, previous }` — 404/409; not `booked` → 422 `APPOINTMENT_CLOSED` `'This appointment is closed'`; merged window re-checked (past, midnight); new designer active; lock every touched (designer, date) in sorted order, overlap excluding itself; `scheduledAt = now` when date/time/minutes/designer changed; `increment()`. `previous = { designerId, start, end }`.
  - `cancelAppointment(branchId, id, { version, patch: { reason } }, actor)` — booked only; `status 'cancelled'`, `cancelReason`, `statusAt/By`.
  - `markAppointment(branchId, user, id, { version, patch: { status } }, actor)` — scope: without `appointments.write`, the appointment's `designerId` must be the user (else 404); booked only; `date > today` → 422 `APPOINTMENT_NOT_DUE` `'You can mark this from the day of the appointment'`.
  - `getAppointment(branchId, user, id) → lean | 404` (same scope).
- Produces (`json.js`): `toAppointmentJson(a, { designers, customers, enquiries, garments })` → `{ id, type, date, time, minutes, start, end, status, designer: { id, name }, customer: { id, name, phone } | null, enquiry: { id, name, phone } | null, garments: [{ id, garmentNo, description }], note, cancelReason, statusAt, statusBy: { id, name } | null, createdAt, version }` — **no budget**; an enquiry converted later shows `customer` from `convertedCustomerId` as well.
- Produces (`routes.js`): `appointmentsRouter()` at `/v1/appointments`: `POST /` (`appointments.write`, `idempotent()`) → 201 `{ appointment }`; `GET /:id` (`appointments.own`, scoped); `PATCH /:id` (`appointments.write`) → `{ appointment }`; `POST /:id/cancel` (`appointments.write`); `POST /:id/mark` (`appointments.own`, scoped).

- [ ] **Step 1: Write the failing tests** — `appointments-book.test.js`: `a consultation is booked with the default length from settings` (60 min, `end`, `date`); `a length can be chosen`; `an enquiry's appointment moves it to appointment booked`; `a lost enquiry cannot be booked`; `an overlapping booking is refused with the booked slot` (422 `SLOT_TAKEN` details); `back-to-back bookings are allowed`; `another designer is free at the same time`; `cancelled appointments free their slot`; `concurrent bookings of one slot book exactly one` (`Promise.all` of 2 — and of 5 — different keys → one 201, rest 422; one appointment in the DB); `concurrent bookings of adjacent slots both succeed`; `double tap with one key books once`; `a move into a slot booked meanwhile is refused` (two orders of the race, M4 Tasks 3–4 ruling: book commits before the move's lock → move 422; move commits first → booking 422); `moving to another day or designer checks the new day`; `a past time is refused for booking and moving`; `a fitting names the customer's own garments only` (other customer's garment, a cancelled garment → 400); `a closed appointment cannot be moved or cancelled`; `done and didn't come are allowed from the appointment's day`; `a designer can mark their own appointment but not another's` (404); `an inactive designer cannot be booked`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/appointments-book.test.js` → FAIL.
- [ ] **Step 3: Implement**; mount `appointmentsRouter()` at `/v1/appointments` in `app.js`.
- [ ] **Step 4: Run** `npx vitest run apps/api/test/appointments-book.test.js apps/api/test/enquiries.test.js apps/api/test/orders-read.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): book, move, cancel and mark appointments without double-booking (M7 Task 5)`

---

### Task 6: API — designer day view, appointment lists and M8 figures

**Files:**
- Create: `apps/api/src/modules/appointments/queries.js`
- Modify: `apps/api/src/modules/appointments/{service.js,routes.js}`, `apps/api/src/modules/enquiries/{queries.js,routes.js}`
- Test: `apps/api/test/appointments-read.test.js`

**Interfaces:**
- Consumes: Task 5; `listDesigners`, `paginate`, `readSettings`.
- Produces (`appointments/queries.js`, re-exported by `service.js`):
  - `appointmentsForDay(branchId, user, { date, designerId }) → { date, openingTime, closingTime, designers: [{ id, name, appointments: [json] }] }` — `by_day` / `by_designer_day`, sorted by `start`; without `appointments.write` only the user's own column (a `designerId` query cannot widen it); with it, every active designer is listed, even with no appointments, plus inactive designers who have appointments that day. Cancelled appointments are left out; done/no-show stay (greyed in the UI). **M8 tile 6 (today's calendar) and tile 1 (today's fittings: `type === 'fitting'`).**
  - `listAppointments(branchId, user, { from, to, designerId, customerId, enquiryId, status, cursor, limit }) → { items, nextCursor }` — scoped like the day view; `customerId` also matches appointments whose enquiry was converted to that customer (`enquiryId ∈ ids of the customer's converted enquiries`, via `enquiries/service.enquiryIdsForCustomer(branchId, customerId)`); sort `start` asc for future, desc when `to < today`.
  - `appointmentCounts(branchId, { from, to, designerId }) → { booked, completed, no_show, cancelled, byType: { consultation, measurement, fitting, pickup } }` — one aggregate on `by_day`. **M8.**
- Produces (`enquiries/queries.js`): `enquiryIdsForCustomer(branchId, customerId) → [ObjectId]` (index `converted_customer`, created in Task 3's model); `enquiryConversionBySource(branchId, { from, to }) → [{ source, total, converted, lost, open }]` — one `$group` on `by_date` by `enquiryDate`. **M8 tile 8 and the enquiry conversion report.**
- Produces (routes, declared before `/:id`): `GET /v1/appointments/day?date=&designerId=` (`appointments.own`); `GET /v1/appointments` (`appointments.own`, `appointmentListQuery`); M8 functions have no route yet.
- M8 note (comment at the top of both `queries.js`): tile 6 = `appointmentsForDay(today)`; tile 1 "today's fittings" = its fitting cards; tile 8 = `enquiryConversionBySource`; follow-ups due = `followUpsDue`.

- [ ] **Step 1: Write the failing tests** — `the day view is the IST day` (an 23:30 IST booking on day D is in D, a 00:15 booking on D+1 is not); `the day view lists every active designer, busy or free`; `cancelled appointments are left out of the day`; `a designer's day shows only their own column`; `a customer's appointments include those booked while they were an enquiry`; `lists page without repeats`; `appointment counts by status and type`; `enquiry conversion by source counts converted, lost and open`; `appointment queries use indexes` (`explain` of the day view, designer day, customer list, reminders range, conversion `$match` has no `COLLSCAN`).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/appointments-read.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/appointments-read.test.js apps/api/test/appointments-book.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): designer day view, appointment lists and front-office figures for the dashboard (M7 Task 6)`

---

### Task 7: API — appointment messages and reminders

**Files:**
- Create: `apps/api/src/modules/appointments/{notifications.js,reminders.js,jobs.js}`
- Modify: `apps/api/src/core/notify/recipients.js`, `apps/api/src/modules/production/notifications.js`, `apps/api/src/modules/appointments/service.js`, `apps/api/src/jobs.js`
- Test: `apps/api/test/appointments-notify.test.js`, `apps/api/test/production-notify.test.js` (still passes)

**Interfaces:**
- Consumes: Tasks 5–6; `defineEvent`, `emit`, `getRule`, `getQuietHours`, `nextAllowedTime`, `defineJob`, `listBranchIds`, `reminderDue`, `appointmentWhen`, `APPOINTMENT_TYPE_LABELS`.
- Produces (`core/notify/recipients.js`): the `designer` resolver (data.designerId, active designer of the branch via `isActiveDesigner`), removed from `production/notifications.js` (Decision 15).
- Produces (`notifications.js`): events (client: `email`; designer: `in_app` + `email`):
  - `appointment.booked` — client subject `'Your appointment on {when}'`, body `'Hello {customerName},\n\nYour {type} at Vastrasanskara is booked for {when} with {designerName}.\n\nIf you need to change it, please call us.'`; designer `'New appointment: {when}'` / `'{type} with {customerName} on {when}.'`.
  - `appointment.changed` — client `'Your appointment has moved to {when}'` / `'Hello {customerName},\n\nYour {type} has moved from {previousWhen} to {when} with {designerName}.'`; designer `'Appointment moved: {when}'` / `'{type} with {customerName} moved from {previousWhen} to {when}.'`.
  - `appointment.cancelled` — client `'Your appointment on {when} is cancelled'` / `'Hello {customerName},\n\nYour {type} on {when} is cancelled. Please call us to book another time.'`; designer `'Appointment cancelled: {when}'` / `'{type} with {customerName} on {when} is cancelled.'`.
  - `appointment.reminder` — client `'Reminder: your appointment {whenRelative}'` / `'Hello {customerName},\n\nA reminder of your {type} at Vastrasanskara {whenRelative} ({when}) with {designerName}.'`; designer `'Reminder: {type} with {customerName} at {time}'` / same in-app. `whenRelative` = "tomorrow" / "today".
  - `emitAppointmentEvent(event, appointment, { previous, refId, sequence, includeClient = true }, session)` — `data = { designerId, customerId: includeClient ? (customerId ?? enquiry.convertedCustomerId ?? null) : null }`; vars `{ customerName, type, when, previousWhen, designerName, time, whenRelative, link: '/appointments?date=<date>' }`. Names from `getCustomerNames`/`getEnquiryParties`/`getUserNames`; no phone in vars.
- Produces (`service.js`): book → `appointment.booked` (ref `<id>`); move with time/designer change → `appointment.changed` (ref `<id>:<version>`), and when the designer changed, `appointment.cancelled` to the old designer only (ref `<id>:moved:<version>`, `includeClient: false`, `data.designerId` = old); cancel → `appointment.cancelled` (ref `<id>`). All inside the write's transaction.
- Produces (`reminders.js`): `runAppointmentReminders() → { queued }` — for each branch: `Appointment.find({ branchId, status: 'booked', start: { $gt: now, $lte: now + 24 h } })` (`reminders` index); `kind = reminderDue(...)`; `day` → `emit` sequence 1, `soon` → sequence 2 with `includeClient = !clientQuietNow`, where `clientQuietNow` = `nextAllowedTime(now, quietHours[ch]) > now` for any client channel of `getRule(branchId, 'appointment.reminder').channels`; ref `<id>:<start ISO>`; each emit in its own `withTransaction`. Logs only counts.
- Produces (`jobs.js`): `defineJob('appointments-reminders', { schedule: '*/15 * * * *', handler: () => runAppointmentReminders() })`; imported from `apps/api/src/jobs.js`.

- [ ] **Step 1: Write the failing tests** — `appointments-notify.test.js` (fake clock via `vi.spyOn(clock, 'now')`, outbox rows asserted): `booking tells the client and the designer`; `a client without consent gets nothing; the designer still does`; `an enquiry's appointment tells only the designer`; `after conversion the customer gets the reminders`; `moving tells both and a new designer replaces the old` (old designer gets a cancellation, client gets one "moved" message); `cancelling tells both`; `done and didn't come send nothing`; `the day reminder goes 24 hours before`; `a late booking skips the day-before reminder` (booked 3 h ahead → only the 2 h reminder); `the two-hour reminder skips the client in quiet hours` (10:00 appointment, job at 08:00 IST → designer row only; 14:00 appointment at 12:00 → both); `re-running reminders queues nothing new`; `moving an appointment re-arms its reminders`; `cancelled appointments get no reminders`; `reminder messages carry no phone number`; `the reminders job is registered every 15 minutes`. `production-notify.test.js`: existing designer tests pass unchanged.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/appointments-notify.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/api/test/appointments-notify.test.js apps/api/test/production-notify.test.js apps/api/test/production-daily.test.js apps/api/test/jobs.test.js apps/api/test/appointments-book.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(api): appointment messages and day-before and two-hour reminders (M7 Task 7)`

---

### Task 8: API — permission matrix and the enquiry-to-order journey

**Files:**
- Modify: `apps/api/src/modules/{enquiries,appointments}/routes.js` (only if the matrix finds a wrong guard)
- Test: `apps/api/test/front-office-permissions.test.js`

**Interfaces:**
- Consumes: Tasks 3–7; `helpers/frontOffice.js`; the `declared(prefix, router)` pattern from `billing-permissions.test.js`.
- Produces: a route table `[method, path, permission]` for every `/v1/enquiries` and `/v1/appointments` route, asserted equal to the routers' declared routes.

- [ ] **Step 1: Write the failing tests** — `designers are refused every enquiry route` (403 on each row); `designers are refused booking, moving and cancelling`; `designers see only their own appointments` (GET another designer's appointment → 404; day view with another `designerId` → own column only; list filtered); `operations and admins are allowed every front-office route` (status ≠ 403); `no appointment response carries a budget` (deep key scan of every appointment response for `budget`, `price`, `amount` for all roles); `an enquiry from phone call to order` (create enquiry → log a call → book a consultation (enquiry `appointment_booked`, outbox has the designer row) → mark done on the day → convert (customer created) → `POST /v1/orders` with `enquiryId` → enquiry converted with order number, absent from follow-ups → the customer's appointment list contains the consultation → `enquiryConversionBySource` counts 1 converted).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/front-office-permissions.test.js` → FAIL until the table is written and any wrong guard fixed.
- [ ] **Step 3: Implement** the table; fix guards it exposes.
- [ ] **Step 4: Run** `npx vitest run --project api && npm run lint` → PASS.
- [ ] **Step 5: Commit** `test(api): front-office permission matrix and enquiry to order journey (M7 Task 8)`

---

### Task 9: Web — quick enquiry capture, follow-ups today and the enquiry page

**Files:**
- Create: `apps/web/src/features/enquiries/{enquiriesApi.js,enquiryForm.js,NewEnquiryPage.jsx,PhoneCheck.jsx,InterestChips.jsx,FollowUpChips.jsx,EnquiriesPage.jsx,EnquiryPage.jsx,LogCallDialog.jsx,LostDialog.jsx}`, `apps/web/src/test/frontOffice.js`
- Modify: `apps/web/src/App.jsx`, `apps/web/src/layout/navItems.js`, `apps/web/src/lib/errorMessages.js`, `apps/web/src/test/server.js`
- Test: `apps/web/src/features/enquiries/enquiryForm.test.js`, `apps/web/src/features/enquiries/enquiries.test.jsx`, `apps/web/src/lib/errorMessages.test.js`

**Interfaces:**
- Consumes: Task 3 routes; `enquirySchema` (inline errors), `CUSTOMER_SOURCES`, `LOST_REASONS`, `addDaysYmd`; `useSettings` (garment types); `displayPhone` (CustomersPage); `ResponsiveTable`, `LoadMore`, `EmptyState`, `DateLabel`, `StatusBadge`, `PageHeader`, `ReasonDialog`.
- Produces:
  - `enquiriesApi.js`: `ENQUIRIES_KEY = ['enquiries']`; `useEnquiries({ view, q })` (infinite), `useEnquiry(id)`, `usePhoneCheck(phone)` (enabled when the phone parses), `useFollowUpCount()`, `useCreateEnquiry()` (`{ body, key }` with `idempotencyKey`), `useUpdateEnquiry(id)`, `useLogCall(id)`, `useMarkLost(id)`, `useReopenEnquiry(id)`; mutations invalidate `ENQUIRIES_KEY`.
  - `enquiryForm.js` (pure): `emptyEnquiryForm(today)` (`followUpDate = tomorrow`, `source 'walk_in'`), `followUpChoices(today) → [{ label: 'Today'|'Tomorrow'|'In 3 days'|'Next week', date }]`, `formToEnquiryBody(form)` (rupees → paise, empty budget → null), `sourceLabel(key)` (Instagram, Referral, Walk-in, Website, Film industry, Other).
  - `/enquiries/new` → `NewEnquiryPage` (`enquiries.write`), one screen at 390 px: **Phone** first (`type="tel"`, autofocus) with `PhoneCheck` under it — "Already a customer: Priya Sharma" (link) / "Open enquiry: Priya — open it" (button; save disabled while an open enquiry is shown); **Name**; **Interested in** (`InterestChips`: garment-type chips + "Details (optional)"); **Budget (rough)** ₹ optional; **How did they hear of us?** source chips; **Call back on** (`FollowUpChips`, Tomorrow selected, "Pick a date"); **Note (optional)**; sticky "Save enquiry". Idempotency-Key made on open, reused on retry. Success → `/enquiries/:id` with "Enquiry saved". `ENQUIRY_EXISTS` → "There is already an open enquiry for this phone." with "Open it".
  - `/enquiries` → `EnquiriesPage`: chips "Follow-ups today (N)" (default when N > 0, else "Open"), "New", "Appointment booked", "Converted", "Not interested", "All"; search by name or phone; rows: name, phone (tap = `tel:` link), interest, call-back date (red "Overdue" when past), status badge; "New enquiry" button (header on desktop, fixed bottom on phones). Empty follow-ups: "No calls due today."
  - `/enquiries/:id` → `EnquiryPage`: name, phone with a big "Call" button (`tel:`), interest chips + details, budget, source, occasion date, call-back date, status; actions (open enquiries): "Log a call" → `LogCallDialog` (what they said, next call-back `FollowUpChips` + "No more calls"), "Book appointment" (→ `/appointments/new?enquiryId=`), "Convert to order" (Task 10), "Edit", "Not interested" → `LostDialog` (reason chips `LOST_REASONS` + text when "Other"); lost: "Reopen"; converted: "Order VS/ORD/… " link and the customer link. Activity log newest first ("Called — wants a lehenga by March").
  - Nav: `{ label: 'Enquiries', path: '/enquiries', permission: 'enquiries.write', icon: IconPhoneCall, phone: 'more' }` after Customers.
  - `errorMessages`: `ENQUIRY_EXISTS` 'There is already an open enquiry for this phone.', `ENQUIRY_CLOSED` 'This enquiry is closed. Reopen it first.', `ENQUIRY_CUSTOMER_MISMATCH` 'This enquiry belongs to a different customer.'; the form's own text for `IDEMPOTENCY_IN_PROGRESS`/`IDEMPOTENCY_KEY_REUSED`: 'This enquiry may already be saved. Check Enquiries before trying again.'

- [ ] **Step 1: Write the failing tests** — `enquiryForm.test.js`: `call back defaults to tomorrow`; `follow-up choices are today, tomorrow, in 3 days and next week`; `the budget is sent in paise and may be empty`. `enquiries.test.jsx`: `saves a phone enquiry with one key` (POST body asserted); `a known phone shows the customer's name`; `an open enquiry for the phone blocks a duplicate and links to it`; `follow-ups today are shown first with overdue ones marked`; `logging a call sends the note and the next date`; `not interested needs a reason`; `a lost enquiry can be reopened`; `designers have no Enquiries menu and are sent away from /enquiries`. `errorMessages.test.js`: `every enquiry error code has a plain message`.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement**; routes in `App.jsx` behind `RequirePermission permission="enquiries.write"`; MSW defaults in `test/server.js` (`GET /v1/enquiries` empty, `/v1/enquiries/follow-ups/count` `{ count: 0, overdue: 0 }`), fixtures in `test/frontOffice.js`.
- [ ] **Step 4: Run** `npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Visual check** at 390 and 1280 px (new enquiry with the "already a customer" note, follow-ups list, enquiry page with log, dialogs) with the M4 visual harness (`.superpowers/sdd/2026-10-30-m4-billing/` scripts copied into this plan's workspace). Time the happy path by hand at 390 px: phone, name, one chip, save ≤ 15 s.
- [ ] **Step 6: Commit** `feat(web): quick enquiry capture, follow-ups today and the enquiry page (M7 Task 9)`

---

### Task 10: Web — convert an enquiry to an order, pre-filled

**Files:**
- Create: `apps/web/src/features/enquiries/ConvertDialog.jsx`
- Modify: `apps/web/src/features/enquiries/{enquiriesApi.js,EnquiryPage.jsx}`, `apps/web/src/features/orders/NewOrderPage.jsx`, `apps/web/src/test/server.js`
- Test: `apps/web/src/features/enquiries/convert.test.jsx`, `apps/web/src/features/orders/NewOrderPage.test.jsx`

**Interfaces:**
- Consumes: Task 4 routes; `usePhoneCheck`; `orderBody`, `freshDraft`/`loadDraft`, `DRAFT_KEY`, `newGarment` (NewOrderPage / GarmentsStep).
- Produces:
  - `enquiriesApi.js`: `useConvertEnquiry(id)` → `POST /v1/enquiries/:id/convert`.
  - `ConvertDialog({ enquiry })`: when `usePhoneCheck` finds a customer — "Priya Sharma already has this phone. Use her?" with "Yes, use Priya" (sends `customerId`) / "No, this is someone else" (shows a note: the phone must differ; "Edit the enquiry phone"); else "We'll add Priya as a customer." with "Continue". Success → `navigate('/orders/new?enquiry=<id>')`. An enquiry that already has `convertedCustomer` skips the dialog ("Continue to order").
  - `NewOrderPage`: with `?enquiry=<id>` and no saved draft for that enquiry, fetches `GET /v1/enquiries/:id` and seeds a fresh draft: `customer = convertedCustomer {id, name, phone}`, `enquiryId`, `expectedBudget` (rupees), `occasionDate`, `notes = interest`, `garments = garmentTypes.map(type => newGarment({ type }))` (one blank line when none), starting on the **Garments** step; a banner "From enquiry: Priya Sharma" with "Not from an enquiry" (clears `enquiryId`). `orderBody` sends `enquiryId` (null otherwise). Success with an enquiry: the enquiries cache is invalidated. `ENQUIRY_CLOSED`/`ENQUIRY_CUSTOMER_MISMATCH` show their plain messages and keep the draft.
  - `orderBody(draft, latest)` gains `enquiryId: draft.enquiryId ?? null`; `freshDraft()` gains `enquiryId: null`; `newGarment(fields = {})` accepts preset fields (if it does not already).

- [ ] **Step 1: Write the failing tests** — `convert.test.jsx`: `a known phone offers the existing customer`; `a new caller becomes a customer and opens New order`; `an enquiry with a customer goes straight to the order`. `NewOrderPage.test.jsx`: `an order from an enquiry starts on garments with the customer, budget, occasion and garment types filled in`; `the order is sent with the enquiry id`; `"Not from an enquiry" drops the link`; `an order without an enquiry sends enquiryId null`.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project web && npm run lint` → PASS.
- [ ] **Step 5: Visual check** at 390 px (convert dialog both cases, New order banner on the Garments step).
- [ ] **Step 6: Commit** `feat(web): convert an enquiry to a customer and a pre-filled order (M7 Task 10)`

---

### Task 11: Web — book appointments, designer day view, move, cancel, mark; Home, entry points, settings

**Files:**
- Create: `apps/web/src/features/appointments/{appointmentsApi.js,bookingForm.js,BookAppointmentPage.jsx,PartyPicker.jsx,TimeChips.jsx,AppointmentsPage.jsx,DayColumn.jsx,AppointmentCard.jsx,MoveDialog.jsx,CancelDialog.jsx,PartyAppointments.jsx}`
- Modify: `apps/web/src/App.jsx`, `apps/web/src/layout/navItems.js`, `apps/web/src/features/home/HomePage.jsx`, `apps/web/src/features/customers/CustomerPage.jsx`, `apps/web/src/features/enquiries/EnquiryPage.jsx`, `apps/web/src/features/orders/GarmentPanel.jsx`, `apps/web/src/features/settings/AppointmentsTab.jsx`, `apps/web/src/lib/errorMessages.js`, `apps/web/src/test/server.js`
- Test: `apps/web/src/features/appointments/bookingForm.test.js`, `apps/web/src/features/appointments/appointments.test.jsx`, `apps/web/src/features/home/HomePage.test.jsx`, `apps/web/src/features/settings/SettingsPage.test.jsx`, `apps/web/src/lib/errorMessages.test.js`

**Interfaces:**
- Consumes: Tasks 5–7 routes; `freeStartTimes`, `appointmentWindow`, `appointmentWhen`, `APPOINTMENT_TYPES`, `APPOINTMENT_TYPE_LABELS`, `SLOT_STEP_MINUTES`; `useDesigners`, `useOrder` (ordersApi); `useCustomers`; `useEnquiries`; `useSettings`.
- Produces:
  - `appointmentsApi.js`: `APPOINTMENTS_KEY = ['appointments']`; `useDay(date, designerId?)`, `useAppointments(filters)` (infinite), `useAppointment(id)`, `useBookAppointment()` (`{ body, key }`), `useMoveAppointment(id)`, `useCancelAppointment(id)`, `useMarkAppointment(id)`; mutations invalidate `APPOINTMENTS_KEY` and `ENQUIRIES_KEY`.
  - `bookingForm.js` (pure): `bookingDefaults(searchParams, { settings, today })` (type, party, designer, date, time, garmentIds from `?type&customerId|enquiryId&designerId&date&time&garmentId`); `timeChoices(day, { designerId, minutes, settings, now })` → `freeStartTimes` over that designer's booked appointments from `openingTime` to `closingTime`; `bookingBody(form)`; `dayChoices(today)` → Today, Tomorrow, the next 5 days (weekday labels), "Pick a date".
  - `/appointments/new` → `BookAppointmentPage` (`appointments.write`), one screen: **Who** (`PartyPicker`: one search box over customers and open enquiries, "Customer"/"Enquiry" tags; preset hides it and shows the name with "Change"); **What for** (type chips; default Consultation, Fitting when `garmentId` given); **Designer** (chips of `useDesigners`; default per Decision 10); **Day** (`dayChoices`); **Time** (`TimeChips`: free quarter hours only, "Another time" reveals a time input); **How long** ("60 minutes" from settings, "Change"); **Garments** (fitting with a customer: the customer's in-progress garments as checkboxes, preset one checked); **Note (optional)**; sticky "Book for Sat 7 Nov, 11:30 am". Idempotency-Key per page open. `SLOT_TAKEN` → "That time was just booked. Pick another time." and the day refetches; success → `/appointments?date=<date>` with "Booked".
  - `/appointments` → `AppointmentsPage` (`appointments.own`): date switcher "‹ Today, Sat 7 Nov ›" + "Pick a date"; phones: designer chips (front desk; "All" stacks columns), designers see their own day only; desktop: one `DayColumn` per designer side by side. `DayColumn`: cards in time order with free gaps between them shown as "Free 11:00–12:30" rows; tapping a free row (front desk) opens `/appointments/new?designerId&date&time`. `AppointmentCard`: time–end, type, who (name; phone as `tel:` link), garments, note; done/no-show greyed with a badge; actions — front desk: "Move" (`MoveDialog`: day, time chips, length, designer), "Cancel appointment" (`CancelDialog`, optional reason, "The client and designer will be told."); from the day itself: "Done" / "Didn't come" (designer on own, front desk on all).
  - `PartyAppointments({ customerId | enquiryId })` — "Appointments" section with upcoming first and "Book appointment"; used on `CustomerPage` and `EnquiryPage`.
  - `GarmentPanel`: at stage `trials_fittings`, users with `appointments.write` see "Book a fitting" → `/appointments/new?type=fitting&customerId&designerId=<order designer>&garmentId`.
  - `HomePage`: buttons "New enquiry" (`enquiries.write`) and "Book appointment" (`appointments.write`) under the greeting; sections "Follow-ups today" (≤ 5 rows from `useEnquiries({ view: 'follow_ups' })`, "See all") and "Today's appointments" (`useDay(today)`: all designers for front desk, own for designers; empty: "No appointments today.").
  - Nav: `{ label: 'Appointments', path: '/appointments', permission: 'appointments.own', icon: IconCalendarEvent, phone: 'more' }` after Enquiries.
  - `AppointmentsTab`: adds "Appointments start at" (`openingTime`, time input) above the lengths, with help "Free times are offered from here until closing time."
  - `errorMessages`: `SLOT_TAKEN` 'That time is already booked for this designer. Pick another time.', `APPOINTMENT_IN_PAST` 'This time has already passed.', `APPOINTMENT_CLOSED` 'This appointment is closed and cannot be changed.', `APPOINTMENT_NOT_DUE` 'You can mark this from the day of the appointment.'

- [ ] **Step 1: Write the failing tests** — `bookingForm.test.js`: `only free times within opening hours are offered`; `today offers no past times`; `the length comes from settings for the type`; `links pre-fill the form`. `appointments.test.jsx`: `books a consultation for an enquiry with one key` (POST body asserted); `a fitting from a garment preselects the customer, designer and garment`; `a slot taken meanwhile asks for another time and refreshes the day`; `the day view shows each designer's appointments and free gaps`; `tapping a free gap starts a booking at that time`; `moving an appointment offers free times only`; `cancelling tells who will be told`; `done and didn't come appear from the appointment's day`; `designers see only their own day and cannot book`. `HomePage.test.jsx`: `front desk sees follow-ups today and today's appointments`; `designers see their own appointments today`. `SettingsPage.test.jsx`: `the appointments tab sets the opening time`. `errorMessages.test.js`: `every appointment error code has a plain message`.
- [ ] **Step 2: Run** `npx vitest run --project web` → FAIL.
- [ ] **Step 3: Implement**; routes in `App.jsx`: `/appointments` behind `appointments.own`, `/appointments/new` behind `appointments.write`.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS (whole suite).
- [ ] **Step 5: Visual check** at 390 and 1280 px (booking form with time chips, day view with two designers and gaps, move dialog, Home sections, customer and enquiry appointment sections, garment "Book a fitting").
- [ ] **Step 6: Commit** `feat(web): book appointments on a designer day view, move, cancel and mark them (M7 Task 11)`

---

## Not in M7 (later milestones)

- Dashboard tiles 1 (today's fittings), 6 (today's calendar by designer) and 8 (enquiries: conversion and source) with drill-downs, and the "enquiry conversion by source" report — M8 (M7 provides `appointmentsForDay`, `appointmentCounts`, `followUpsDue`, `enquiryConversionBySource` and the indexes).
- Playwright E2E "enquiry → appointment → convert" on a phone viewport (spec §12) — with the M8/M9 E2E setup; M7 covers it as an API journey test (Task 8) and web tests.
- Google Calendar export (spec §7.2, waits for the client), WhatsApp/SMS reminders (adapters, spec §8.2), designer working hours and leave, recurring appointments, online self-booking, erasing old lost enquiries (DPDP retention policy to agree with the owner), importing past enquiries — later / M9 if wanted.
- Go-live: none specific to M7.
