# Restoring the database from a backup

The worker's `backup` job runs every 6 hours (00:00, 06:00, 12:00, 18:00 IST) and streams a
gzipped `mongodump` archive to the backups bucket at:

```
s3://<backups-bucket>/mongodump/YYYY/MM/DD/HHmm.archive.gz     (date and time in IST)
```

The bucket uses versioning and Object Lock, so backups cannot be deleted or overwritten
before their retention ends. A failed backup alerts the owners (in-app and email) and is
listed under the failed jobs in the admin area.

Tools needed on the machine doing the restore: AWS CLI with read access to the backups
bucket, and the MongoDB Database Tools (`mongorestore`).

## 1. Pick a backup

```bash
aws s3 ls s3://<backups-bucket>/mongodump/ --recursive | sort | tail -20
```

Choose the newest archive from before the problem started.

## 2. Download it

```bash
aws s3 cp s3://<backups-bucket>/mongodump/2026/10/22/0600.archive.gz ./restore.archive.gz
```

## 3. Keep the connection string off the command line

Write the target URI to a private config file instead of passing `--uri` (the command line
is visible to other users and processes on the machine):

```bash
umask 077
printf 'uri: "%s"\n' 'mongodb+srv://<user>:<password>@<cluster>/vastrasanskara' > restore-config.yaml
```

## 4. Rehearse on a scratch database first (recommended)

Restore into a separate database name and check it before touching production:

```bash
mongorestore --config=restore-config.yaml --archive=restore.archive.gz --gzip \
  --nsFrom='vastrasanskara.*' --nsTo='vastrasanskara_restore_check.*'
```

Look at a few collections (users, settings, auditLog) in the scratch database, then drop it.

## 5. Restore over production

1. Stop the API and the worker so nothing writes during the restore:
   `pm2 stop vs-api vs-worker`
2. Restore, replacing each collection with the backup's copy:

   ```bash
   mongorestore --config=restore-config.yaml --archive=restore.archive.gz --gzip --drop
   ```

3. Start the services again: `pm2 start vs-api vs-worker`
4. Delete the local files: `rm restore.archive.gz restore-config.yaml`

## 6. Verify

- `curl https://api.<domain>/v1/health` returns `{"db":"ok","worker":"ok"}` (the worker
  reports within a minute of starting).
- Sign in as an admin and check recent orders, invoices and settings look right for the
  backup's date and time.
- Run the admin "Verify audit trail" check (added in the billing milestone); it must report
  the chain as intact.

Anything entered after the backup's timestamp is lost and must be re-entered; tell the team
which time the data now reflects.

## Restore drill (do before go-live and every 3 months)

A backup is only proven when it has been restored. The drill does steps 1–4 above in one
command: it restores the newest backup into a scratch database (`<db>_restore_check`), counts
every collection, re-checks each branch's history (audit) chain, says how old the backup is, and
then drops the scratch database. Production is never touched.

Run it from the server (or any machine with the MongoDB Database Tools, AWS credentials that can
read the backups bucket, and network access to Atlas):

```bash
cd /opt/vastrasanskara
MONGO_URI="$(aws ssm get-parameter --with-decryption --name /vastrasanskara/prod/MONGO_URI --query Parameter.Value --output text)" \
BACKUPS_BUCKET=<backups-bucket> \
node apps/api/src/cli/restore-drill.js
```

Add `--keep` to leave the scratch database in place for a closer look (drop it afterwards in
Atlas). The connection string is read from the environment and passed to `mongorestore` in a
private temporary file; it never appears on the command line or in the report.

A good run ends like this and exits with code 0:

```
Backup: mongodump/2026/11/18/0600.archive.gz
Backup is 3 h old
  auditLog: 1840
  ...
  users: 6
Branch 6a1f…: 1840 history entries, unchanged
Newest history entry: 2026-11-18T00:28:41.000Z
The backup restores and its records check out
```

Write the date and the "Backup is … old" line in the go-live checklist notes (and every 3
months after).

### When the drill reports a problem (exit code 1)

- **"No backups found"** or **"The newest backup is N h old"** — backups are not running. Check
  the failed jobs in the admin area and the worker (`pm2 logs vs-worker`), fix, wait for the next
  6-hourly backup and run the drill again.
- **"Audit chain broken at entry N of branch …"** — the history in the backup was changed after
  it was written, or the backup is damaged. Run the admin "Check records" on production: if it
  also reports a break, treat it as a security incident (who has database access?); if
  production is fine, run the drill on the previous backup and report the damaged one.
- **"No users in the backup"** / **"No branches in the backup"** — the backup is empty or of the
  wrong database. Check `MONGO_URI` points at the production database name.
- **"The drill could not finish: …"** — usually `mongorestore` missing, wrong AWS credentials or
  no network access to Atlas. Fix and run again; nothing was changed in production.
