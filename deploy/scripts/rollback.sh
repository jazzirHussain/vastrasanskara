#!/usr/bin/env bash
# Puts the release that ran before the last deploy back (on the EC2 instance, as the app user):
#   bash /opt/vastrasanskara/deploy/scripts/rollback.sh <api-host>
# remote-deploy.sh records that release in .release-previous (the rollback itself records the
# release it replaces, so running it twice goes forward again). The database is not rolled back.
set -euo pipefail

api_host="${1:?usage: rollback.sh <api-host>}"
app_dir="${APP_DIR:-/opt/vastrasanskara}"

if [[ ! -s "$app_dir/.release-previous" ]]; then
  echo "No previous release recorded in $app_dir/.release-previous; nothing to roll back to" >&2
  exit 1
fi

previous="$(cat "$app_dir/.release-previous")"
echo "==> Rolling back to $previous"
# A copy, so the checkout inside the deploy cannot change the script being run.
script="$(mktemp)"
trap 'rm -f "$script"' EXIT
cp "$app_dir/deploy/scripts/remote-deploy.sh" "$script"
bash "$script" "$previous" "$api_host"
