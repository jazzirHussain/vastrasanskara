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
