#!/usr/bin/env bash
# Runs on the EC2 instance (via SSM Run Command from the deploy workflow) as the app user:
#   bash /opt/vastrasanskara/deploy/scripts/remote-deploy.sh <git-sha> <api-host>
# Checks out the commit, installs production dependencies, writes .env from SSM Parameter
# Store, reloads both pm2 apps and waits for /v1/health to report db and worker ok.
#
# Everything lives in main(): bash parses the whole function before running it, so the
# `git reset` below can safely replace this file while it runs.

main() {
  set -euo pipefail

  local sha="${1:?usage: remote-deploy.sh <git-sha> <api-host>}"
  local api_host="${2:?usage: remote-deploy.sh <git-sha> <api-host>}"
  local app_dir="${APP_DIR:-/opt/vastrasanskara}"
  local ssm_path="${SSM_PATH:-/vastrasanskara/prod}"
  local region="${AWS_REGION:-ap-south-1}"

  cd "$app_dir"

  echo "==> Checking out $sha"
  git fetch --quiet origin
  git reset --hard "$sha"

  echo "==> Installing production dependencies"
  npm ci --omit=dev --no-audit --no-fund

  echo "==> Writing .env from SSM $ssm_path"
  write_env "$ssm_path" "$region"

  echo "==> Reloading pm2 apps"
  pm2 startOrReload deploy/ecosystem.config.cjs --update-env
  pm2 save

  echo "==> Waiting for https://$api_host/v1/health"
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS "https://$api_host/v1/health"; then
      echo
      echo "==> Deployed $sha"
      return 0
    fi
    sleep 3
  done
  echo "Health check failed after 90 s" >&2
  pm2 logs --nostream --lines 50 >&2 || true
  return 1
}

# Every parameter under the path becomes KEY="value" (KEY = last path segment).
write_env() {
  local ssm_path="$1" region="$2"
  local tmp
  tmp="$(mktemp .env.XXXXXX)"
  chmod 600 "$tmp"
  aws ssm get-parameters-by-path \
    --region "$region" \
    --path "$ssm_path" \
    --recursive \
    --with-decryption \
    --query 'Parameters[*].[Name,Value]' \
    --output text |
    while IFS=$'\t' read -r name value; do
      # dotenv takes double-quoted values literally (no unescaping), so a " cannot be stored.
      if [[ "$value" == *'"'* ]]; then
        echo "SSM parameter $name contains a double quote; remove it" >&2
        exit 1
      fi
      printf '%s="%s"\n' "${name##*/}" "$value"
    done >"$tmp"
  if ! grep -q '^MONGO_URI=' "$tmp"; then
    rm -f "$tmp"
    echo "SSM path $ssm_path returned no MONGO_URI; refusing to write .env" >&2
    return 1
  fi
  mv "$tmp" .env
}

# On one line so bash has read it before main runs (main may replace this file).
main "$@"; exit $?
