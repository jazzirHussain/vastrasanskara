#!/usr/bin/env bash
# Runs on the EC2 instance (via SSM Run Command from the deploy workflow) as the app user:
#   bash /opt/vastrasanskara/deploy/scripts/remote-deploy.sh <git-sha> <api-host>
# Records the running release (for rollback.sh), checks out the commit, installs production
# dependencies, writes .env from SSM Parameter Store, migrates the database, reloads both pm2
# apps, waits until the new worker reports this release and the API is healthy, then checks
# the public health URL.
#
# Everything lives in functions: bash parses a whole function before running it, so the
# `git reset` below can safely replace this file while it runs. Sourcing the file (tests)
# defines the functions without running main.

main() {
  set -euo pipefail

  local sha="${1:?usage: remote-deploy.sh <git-sha> <api-host>}"
  local api_host="${2:?usage: remote-deploy.sh <git-sha> <api-host>}"
  local app_dir="${APP_DIR:-/opt/vastrasanskara}"
  local ssm_path="${SSM_PATH:-/vastrasanskara/prod}"
  local region="${AWS_REGION:-ap-south-1}"

  cd "$app_dir"

  local current
  current="$(git rev-parse HEAD 2>/dev/null || true)"
  if [[ -n "$current" && "$current" != "$sha" ]]; then
    echo "==> Recording the running release $current for rollback"
    printf '%s\n' "$current" >.release-previous
  fi

  echo "==> Checking out $sha"
  git fetch --quiet origin
  git reset --hard "$sha"

  echo "==> Installing production dependencies"
  npm ci --omit=dev --no-audit --no-fund

  echo "==> Writing .env from SSM $ssm_path"
  write_env "$ssm_path" "$region" "$sha"

  echo "==> Migrating the database"
  node apps/api/src/cli/migrate.js

  echo "==> Making sure pm2 rotates its logs"
  if ! pm2 describe pm2-logrotate >/dev/null 2>&1; then
    pm2 install pm2-logrotate
  fi
  pm2 set pm2-logrotate:max_size 10M >/dev/null
  pm2 set pm2-logrotate:retain 14 >/dev/null
  pm2 set pm2-logrotate:compress true >/dev/null

  echo "==> Reloading pm2 apps"
  pm2 startOrReload deploy/ecosystem.config.cjs --update-env
  pm2 save

  echo "==> Waiting for release $sha to report"
  if ! node apps/api/src/cli/wait-ready.js "$sha"; then
    pm2 logs --nostream --lines 50 >&2 || true
    return 1
  fi

  echo "==> Checking https://$api_host/v1/health"
  curl -fsS "https://$api_host/v1/health"
  echo
  echo "==> Deployed $sha"
}

# Every parameter under the path becomes KEY='value' (KEY = last path segment), plus
# RELEASE_SHA. dotenv takes single-quoted values literally, so a value holding ' is refused.
# Runs in a subshell so its trap removes the temp file however it ends.
write_env() (
  set -euo pipefail
  local ssm_path="$1" region="$2" sha="$3"
  local tmp
  tmp="$(mktemp .env.XXXXXX)"
  trap 'rm -f "$tmp"' EXIT
  chmod 600 "$tmp"

  local params
  params="$(aws ssm get-parameters-by-path \
    --region "$region" \
    --path "$ssm_path" \
    --recursive \
    --with-decryption \
    --query 'Parameters[*].[Name,Value]' \
    --output text)"

  local name value
  while IFS=$'\t' read -r name value; do
    [[ -z "$name" ]] && continue
    if [[ "$value" == *"'"* ]]; then
      echo "SSM parameter $name contains a single quote ('); remove it" >&2
      exit 1
    fi
    printf "%s='%s'\n" "${name##*/}" "$value"
  done <<<"$params" >"$tmp"

  if ! grep -q '^MONGO_URI=' "$tmp"; then
    echo "SSM path $ssm_path returned no MONGO_URI; refusing to write .env" >&2
    exit 1
  fi
  printf "RELEASE_SHA='%s'\n" "$sha" >>"$tmp"
  mv "$tmp" .env
)

# On one line so bash has read it before main runs (main may replace this file).
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; exit $?; fi
