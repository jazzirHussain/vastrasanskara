# Production infrastructure — setup checklist

Do these in order. `<domain>` is the business domain (e.g. `vastrasanskara.in`):
the web app is served at `app.<domain>` and the API at `api.<domain>`. Region is
`ap-south-1` (Mumbai) except the CloudFront certificate, which must be in `us-east-1`.

```
browser ──► CloudFront (app.<domain>) ──► S3 web bucket (static React build)
   │
   └──────► nginx on EC2 (api.<domain>) ──► pm2: vs-api (Express) + vs-worker (Agenda)
                                              │
                         MongoDB Atlas ◄──────┤──► S3 files bucket, S3 backups bucket
                                              └──► SES (email), SSM (config), CloudWatch
```

## 1. Domain and certificates

1. In the DNS provider, keep the zone ready; records are added in steps 2 and 5.
2. In **ACM (us-east-1)** request a certificate for `app.<domain>` (DNS validation) and add
   the validation CNAME. CloudFront can only use certificates from us-east-1.

## 2. Web hosting (S3 + CloudFront)

1. Create a **private** S3 bucket for the web build (block all public access).
2. Create a CloudFront distribution:
   - Origin: the web bucket with **Origin Access Control (OAC)**; apply the bucket policy
     CloudFront offers.
   - Alternate domain `app.<domain>`, the ACM certificate from step 1, HTTPS only
     (redirect HTTP), default root object `index.html`.
   - Custom error responses: **403 and 404 → `/index.html`, response code 200** (client-side
     routes such as `/settings` must load the app).
   - Response headers policy:
     - `Strict-Transport-Security: max-age=63072000; includeSubDomains`
     - `Content-Security-Policy: default-src 'self'; connect-src 'self' https://api.<domain> https://*.s3.ap-south-1.amazonaws.com; img-src 'self' data: https://*.s3.ap-south-1.amazonaws.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`
       (`style-src 'unsafe-inline'` is needed by Mantine's runtime styles; `frame-ancestors 'none'`
       stops other sites showing the app inside a frame)
     - `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`
3. DNS: `app.<domain>` CNAME (or alias) → the CloudFront domain.

## 3. Storage buckets

1. **Files bucket** (customer photos, logos, PDFs): private, versioning on, default
   encryption on, and **Object Lock enabled at creation** (it cannot be turned on later)
   with **no default retention**: the app itself locks each bill, receipt and credit note PDF
   for 8 years in compliance mode (`FILES_OBJECT_LOCK=true`, step 7); other files stay
   deletable. CORS (the checksum header is how S3 refuses an upload whose bytes changed on
   the way):

   ```json
   [{ "AllowedOrigins": ["https://app.<domain>"], "AllowedMethods": ["PUT", "GET"],
      "AllowedHeaders": ["Content-Type", "x-amz-checksum-sha256"], "MaxAgeSeconds": 3000 }]
   ```

   Lifecycle rules. S3 rules match a key prefix, not a pattern, and keys start with the
   branch id, so add the first two once per branch (`<branchId>` is printed by `bootstrap.js`
   and is the first part of every key in the bucket):
   - prefix `<branchId>/reports/` — expire current versions after **90 days** (generated
     report files; the report can be run again);
   - prefix `<branchId>/import_file/` — expire current versions after **30 days** (uploaded
     import spreadsheets; what they added is in the database);
   - whole bucket — expire **noncurrent versions after 90 days** (locked PDFs are kept anyway:
     a version under retention cannot be deleted until it ends).

2. **Backups bucket**: private, versioning on, **Object Lock enabled at creation** (it
   cannot be turned on later) with a default retention in **compliance** mode (e.g. 35 days),
   lifecycle: transition to Glacier after 30 days, expire after 8 years.

## 4. Database (MongoDB Atlas)

1. Create an **M0** cluster in **AWS / ap-south-1**.
2. Create a database user with read/write on the `vastrasanskara` database only.
3. Network access: add the EC2 **Elastic IP** (step 5) only — no `0.0.0.0/0`.
4. Copy the connection string (`mongodb+srv://…/vastrasanskara?retryWrites=true&w=majority`)
   for the SSM parameter `MONGO_URI`.
5. Check the cluster's MongoDB version is **7.0 or later** (cluster overview). The API and
   worker refuse to start on an older version or without transactions.
6. Audit entries that cannot be changed: run `node apps/api/src/cli/atlas-role.js` (from a
   checkout, any machine) and create its output as a **custom role** under Database Access →
   Custom Roles, then give the app's database user that role instead of read/write. If the
   cluster tier does not offer custom roles (M0 may not), keep read/write and write down
   "custom audit role: not available on M0" in the go-live runbook; the audit hash chain
   still shows any change (Accounts → Check records).

## 5. Server (EC2)

1. Launch **t4g.small**, Amazon Linux 2023 **arm64**, 30 GB gp3 (encrypted), with an
   **Elastic IP**.
2. Security group: inbound **80 and 443** from anywhere; **no port 22** (use SSM Session
   Manager for shell access).
3. **IAM instance role** with:
   - `AmazonSSMManagedInstanceCore` (Session Manager and Run Command)
   - S3 files bucket: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and
     `s3:PutObjectRetention` (to lock bill PDFs) on `arn:aws:s3:::<files>/*`
   - S3 backups bucket: `s3:PutObject` and `s3:AbortMultipartUpload` only on
     `arn:aws:s3:::<backups>/*` (the server can write backups, and clean up a failed large
     upload, but never read or delete them)
   - SES: `ses:SendEmail` and `ses:SendRawEmail` (the app uses the SES v2 SendEmail API)
   - SSM: `ssm:GetParametersByPath` on `arn:aws:ssm:ap-south-1:<account>:parameter/vastrasanskara/prod*`
     plus `kms:Decrypt` for the key used by the SecureString parameters
   - `CloudWatchAgentServerPolicy`
4. DNS: `api.<domain>` A record → the Elastic IP.
5. Connect with Session Manager and install the software:

   ```bash
   sudo dnf install -y git nginx
   # Node 22 LTS
   curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs
   sudo npm install -g pm2
   # MongoDB Database Tools (arm64 RPM from mongodb.com/try/download/database-tools) — for backups
   sudo dnf install -y ./mongodb-database-tools-amazon2023-aarch64-*.rpm
   # certbot
   sudo dnf install -y certbot
   ```

6. App user and checkout:

   ```bash
   sudo useradd --create-home deploy
   sudo mkdir -p /opt/vastrasanskara && sudo chown deploy: /opt/vastrasanskara
   sudo -iu deploy git clone https://github.com/<org>/vastrasanskara.git /opt/vastrasanskara
   sudo env PATH=$PATH pm2 startup systemd -u deploy --hp /home/deploy   # start pm2 on boot
   ```

   (For a private repository, add a read-only deploy key for the `deploy` user.)

7. nginx and TLS:

   ```bash
   sudo mkdir -p /var/www/certbot
   sudo cp /opt/vastrasanskara/deploy/nginx/api.conf /etc/nginx/conf.d/api.conf
   sudo sed -i 's/api.example.com/api.<domain>/g' /etc/nginx/conf.d/api.conf
   # First certificate: temporarily comment out the 443 server block, then
   sudo systemctl enable --now nginx
   sudo certbot certonly --webroot -w /var/www/certbot -d api.<domain>
   # restore the 443 block
   sudo nginx -t && sudo systemctl reload nginx
   sudo systemctl enable --now certbot-renew.timer
   ```

## 6. Email (SES)

1. Verify the domain identity `<domain>` in SES (ap-south-1) with **Easy DKIM**; add the
   three DKIM CNAMEs.
2. DNS: SPF `v=spf1 include:amazonses.com ~all` (merge with any existing SPF record) and
   DMARC `_dmarc.<domain>` TXT `v=DMARC1; p=quarantine; rua=mailto:dmarc@<domain>`.
3. Request **production access** (leave the sandbox) — until approved, SES only sends to
   verified addresses.

## 7. Configuration (SSM Parameter Store)

Create one parameter per key in `.env.example` under `/vastrasanskara/prod/` (SecureString
for secrets). `remote-deploy.sh` writes them to `/opt/vastrasanskara/.env` on every deploy,
each value in single quotes, so a value must not contain a single quote (`'`): the deploy
stops and names the parameter. The deploy also adds `RELEASE_SHA` (the commit being
deployed) itself; do not create it here.

| Parameter | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `4000` |
| `MONGO_URI` (SecureString) | Atlas connection string from step 4 |
| `APP_ORIGIN` | `https://app.<domain>` |
| `API_ORIGIN` | `https://api.<domain>` |
| `SESSION_SECRET` (SecureString) | 48+ random characters: `openssl rand -base64 48` |
| `AWS_REGION` | `ap-south-1` |
| `FILES_BUCKET` / `BACKUPS_BUCKET` | bucket names from step 3 |
| `MAIL_ADAPTER` | `ses` |
| `MAIL_FROM` | `Vastrasanskara <no-reply@<domain>>` |
| `STORAGE_ADAPTER` | `s3` |
| `FILES_OBJECT_LOCK` | `true` (the files bucket was created with Object Lock, step 3) |

## 8. Monitoring and recovery

1. Install the **CloudWatch agent** and ship pm2 logs (`/home/deploy/.pm2/logs/*.log`).
2. **Route 53 health check** (or CloudWatch Synthetics) on `https://api.<domain>/v1/health`
   with an alarm to the owner's email; it fails when the database is down or the worker has
   stopped.
3. **Failed background jobs**: on the pm2 log group, a metric filter with the pattern
   `{ $.level = 50 && $.job = * }` (an error line from a job, logged as
   `job <name> failed: …`), and an alarm on any count in 5 minutes that emails the owner.
   The app also shows a "Background job failed" notification to admins.
4. EC2 **status check alarm with auto-recovery**.
5. **Data Lifecycle Manager**: daily EBS snapshots, keep 7.
6. Database backups run from the worker every 6 hours to the backups bucket — see
   `docs/ops/restore.md` for restoring.

## 9. GitHub deployment

1. In AWS IAM, add GitHub as an **OIDC identity provider**
   (`token.actions.githubusercontent.com`) and create a role trusted only for
   `repo:<org>/vastrasanskara:environment:production`, allowed to:
   `s3:ListBucket`/`s3:PutObject`/`s3:DeleteObject` on the web bucket,
   `cloudfront:CreateInvalidation` on the distribution,
   `ssm:SendCommand` (document `AWS-RunShellScript`, the instance) and
   `ssm:GetCommandInvocation`.
2. In GitHub: create the `production` environment; secret `AWS_DEPLOY_ROLE_ARN`; variables
   `API_HOST` (`api.<domain>`), `WEB_BUCKET`, `CLOUDFRONT_DISTRIBUTION_ID`, `INSTANCE_ID`.
3. Push to `main`. The Deploy workflow runs CI (tests and the phone-sized e2e journeys),
   then deploys the API over SSM → `remote-deploy.sh`, which records the running release,
   installs, writes `.env`, migrates the database, reloads pm2 and waits until the new
   worker reports this commit and health is ok. The workflow polls the SSM command for up
   to 15 minutes, then uploads the web build, invalidates CloudFront and checks health.
4. To put the previous release back (on the instance, Session Manager):
   `sudo -iu deploy bash /opt/vastrasanskara/deploy/scripts/rollback.sh api.<domain>`.

## 10. First run

1. After the first successful deploy, create the branch and the owner account (once):

   ```bash
   sudo -iu deploy
   cd /opt/vastrasanskara
   BOOTSTRAP_BRANCH_NAME="Vastrasanskara" BOOTSTRAP_LEGAL_NAME="…" BOOTSTRAP_STATE_CODE="29" \
   BOOTSTRAP_GSTIN="…" BOOTSTRAP_ADMIN_NAME="…" BOOTSTRAP_ADMIN_EMAIL="…" \
   BOOTSTRAP_ADMIN_PASSWORD="…" node apps/api/src/cli/bootstrap.js
   ```

   (Prefix the command with a space so it is not saved in shell history.)
2. Check: `curl https://api.<domain>/v1/health` → `{"db":"ok","worker":"ok"}`;
   `https://app.<domain>/login` loads; logging in works and the browser's session cookie is
   named `__Host-sid`.
