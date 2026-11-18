# Going live — runbook

Three parts, in order. Tick each box as it is done and write the date beside it.

- **Operator**: the person who sets up AWS, Atlas, DNS and GitHub. The app never does
  these, and neither does an AI agent working in the repository. The detail for each step is
  in [infrastructure.md](infrastructure.md); the section number is given in brackets.
- **Owner**: the business owner (or the admin they choose), working in the app.
- **Accountant**: the business's accountant.
- **Staff**: front desk, designers and admins.

---

## Part 1 — Operator: the production setup

### Domain, certificates and web hosting

- [ ] **Operator** — DNS zone ready for `<domain>`; nothing points at the app yet (§1).
- [ ] **Operator** — ACM certificate for `app.<domain>` in **us-east-1**, validated (§1).
- [ ] **Operator** — Private web bucket, CloudFront distribution with OAC, error responses
      403/404 → `/index.html` (200), and the **response headers policy** including
      `frame-ancestors 'none'` in the CSP (§2).
- [ ] **Operator** — DNS: `app.<domain>` → CloudFront (§2).

### Storage

- [ ] **Operator** — Files bucket created **with Object Lock** (no default retention),
      versioning and encryption on; CORS allows `Content-Type` **and
      `x-amz-checksum-sha256`** (uploads fail without it) (§3).
- [ ] **Operator** — Files bucket lifecycle: `<branchId>/reports/` expire 90 days,
      `<branchId>/import_file/` expire 30 days, noncurrent versions 90 days. (The branch id
      comes from `bootstrap.js` in Part 1's last steps; add these two rules then.) (§3)
- [ ] **Operator** — Backups bucket created **with Object Lock**, compliance retention
      (e.g. 35 days), lifecycle to Glacier after 30 days, expire after 8 years (§3).

### Database

- [ ] **Operator** — Atlas M0 cluster in AWS ap-south-1; database user for `vastrasanskara`
      only; IP access list = the EC2 Elastic IP only (§4).
- [ ] **Operator** — Cluster version is **7.0 or later**. Version: ________ (§4).
- [ ] **Operator** — Custom audit role from `node apps/api/src/cli/atlas-role.js` applied to
      the app's user. Result: ☐ available and applied  ☐ **not available on M0** (kept
      read/write; the audit hash chain still shows changes) (§4).

### Server

- [ ] **Operator** — EC2 t4g.small (Amazon Linux 2023 arm64), Elastic IP, security group
      80/443 only (no 22), IAM instance role including `s3:PutObjectRetention` (files) and
      `s3:AbortMultipartUpload` (backups) (§5).
- [ ] **Operator** — DNS: `api.<domain>` A record → the Elastic IP (§5).
- [ ] **Operator** — Software installed (git, nginx, Node 22, pm2, MongoDB Database Tools,
      certbot), `deploy` user, checkout in `/opt/vastrasanskara`, pm2 startup (§5).
- [ ] **Operator** — nginx config installed, certificate issued, `nginx -t` passes,
      renewal timer on (§5).

### Email

- [ ] **Operator** — SES domain identity `<domain>` with Easy DKIM; DKIM CNAMEs, SPF and
      DMARC records published (§6).
- [ ] **Operator** — **SES production access requested** (leaves the sandbox). Approved on:
      ________. Until then, email only reaches verified addresses (§6).

### Configuration

- [ ] **Operator** — SSM parameters under `/vastrasanskara/prod/`, including
      `FILES_OBJECT_LOCK=true`. No value contains a single quote. `RELEASE_SHA` is **not**
      created (the deploy writes it) (§7).

### Monitoring and recovery

- [ ] **Operator** — CloudWatch agent shipping pm2 logs (§8).
- [ ] **Operator** — Health check on `https://api.<domain>/v1/health` with an alarm to the
      owner (§8).
- [ ] **Operator** — Failed-job metric filter `{ $.level = 50 && $.job = * }` and its alarm
      to the owner (§8).
- [ ] **Operator** — EC2 status-check alarm with auto-recovery; DLM daily snapshots, keep 7
      (§8).

### Deploying

- [ ] **Operator** — GitHub OIDC provider and deploy role; GitHub `production` environment,
      secret `AWS_DEPLOY_ROLE_ARN`, variables `API_HOST`, `WEB_BUCKET`,
      `CLOUDFRONT_DISTRIBUTION_ID`, `INSTANCE_ID` (§9).
- [ ] **Operator** — Merge to `main` and watch the **Deploy** workflow: CI (tests and the
      e2e journeys) passes, "Waiting for release … to report" passes, final health check
      passes.
- [ ] **Operator** — Run `bootstrap.js` **once** over Session Manager (§10). Note the branch
      id it prints, then add the two files-bucket lifecycle rules above.
- [ ] **Operator** — Check: health shows db and worker ok; `https://app.<domain>/login`
      loads; the owner can log in; the session cookie is `__Host-sid` (§10).
- [ ] **Operator** — After the first backup exists (within 6 hours): run the **restore
      drill** from the operator's machine ([restore.md](restore.md#restore-drill-do-before-go-live-and-every-3-months)).
      Result: ☐ passed ☐ failed. Date: ________. Repeat every 3 months.

---

## Part 2 — Owner: getting the business ready in the app

Open **Go live** in the menu (it shows until the business is live). Each item below is one
line of that checklist; the app ticks it when it is done.

- [ ] **Owner** — **Business details**: legal name, GSTIN, state, address, phone and logo as
      printed on bills (Settings → Business).
- [ ] **Owner** — **Bill numbers**: each number series (bills, receipts, credit notes,
      orders…) continues from the old book. Enter the next number for each, then confirm
      them on the Go live page.
- [ ] **Accountant** — Check the **price list**: HSN/SAC code, goods or service, and GST
      slab (with the higher slab above a price where it applies) for every item.
- [ ] **Owner** — **Price list** complete in the app, with the accountant's codes and rates
      (bring it in with the "Price list" template, or add items one by one).
- [ ] **Owner** — **Staff invited**: every front desk, designer and admin has an account
      with the right role and has set their password.
- [ ] **Owner** — **Bring in records**, in the order the **Bring in records** page shows:
      customers, vendors, workers, price list, stock, open orders, opening balances. Pick
      **one cut-over date** (usually the evening before the first live day) and use it for
      stock and opening balances.
- [ ] **Owner** — Compare the **opening balances** total (Owed to you, Advances held) with the
      paper ledger's total on the cut-over date. They match: ☐
- [ ] **Accountant** — Confirm **opening advances and GST** (plan Decision 12): a bill that
      uses an advance taken before the cut-over charges GST in full, with no deduction for
      tax the old system may already have paid on that advance. The "Advance held" rows of
      the opening balances import are the list to check. Agreed: ☐ (If not, tell the
      developer: an optional "GST already paid" column is the change.)
- [ ] **Accountant** — Confirm the open items from the design (§15): HSN/SAC and slabs per
      item (above), treatment of advances for service lines (receipt vouchers), and the
      B2CL threshold value.
- [ ] **Owner** — **Test email**: send it from the Go live page and check it arrived (and
      not in spam).
- [ ] **Owner** — **First backup**: the Go live page shows when the last backup ran; wait for
      one after the records are in.
- [ ] **Owner** — **Check records** (Accounts → Check records) shows no problems.

---

## Part 3 — Switching over

### Training (30 minutes per role, on a phone, with real records)

- [ ] **Staff — front desk**: find or add a customer; a phone enquiry and booking an
      appointment; a new order with garments, prices and pickup date; taking an advance;
      creating and issuing a bill; taking payment; sharing the bill PDF on WhatsApp; handing
      garments over.
- [ ] **Staff — designers**: Production list; opening an order; moving a garment through its
      stages (start, done, send to vendor and back); booking a fitting; adding photos and
      remarks.
- [ ] **Staff — admins**: Home and its drill-downs; expenses with bill photos; stock and
      purchases; reports and the month's GST pack; settings, staff and price list; check
      records.

### One week alongside paper

- [ ] **Owner** — For one week every order, bill and payment goes into the app **and** on the
      paper form as before.
- [ ] **Owner** — **Every day**: compare the day's bills and payments in the app with the
      paper. Differences found and fixed: ________.
- [ ] **Owner** — After the week, with no unexplained differences: press **"We are live"** on
      the Go live page and retire the paper form.

### First month-end

- [ ] **Owner** — Download the **GST pack** for the month (Reports) and send it to the accountant.
- [ ] **Accountant** — File the return.
- [ ] **Owner** — **Lock the month** (Accounts → Month locks) so its bills and payments can no longer change.

---

## If something goes wrong

- **A deploy broke something**: put the previous release back (Operator, Session Manager):
  `sudo -iu deploy bash /opt/vastrasanskara/deploy/scripts/rollback.sh api.<domain>`.
  The database is not rolled back. Then fix forward with a new commit to `main`.
- **Data lost or damaged**: restore a backup — [restore.md](restore.md). Stop staff entering
  records until it is done.
- **The app is down**: the health alarm emails the owner. Check
  `https://api.<domain>/v1/health`; on the instance, `sudo -iu deploy pm2 status` and
  `pm2 logs --lines 100`.
- **Emails not arriving**: check SES is out of the sandbox and the domain is verified; the
  test email on the Go live page shows the error if sending failed.
- **Who to call**:
  - App or server: ______________________ (developer / operator), phone ____________
  - AWS account owner: ______________________
  - Accountant: ______________________, phone ____________
