#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.example and set strong secrets first." >&2
  exit 1
fi

read_env() {
  sed -n "s/^${1}=//p" .env | tail -1 | tr -d '\r'
}

PG_PW="$(read_env POSTGRES_PASSWORD)"
ADMIN_KEY="$(read_env ADMIN_API_KEY)"
TD_KEY="$(read_env TWELVE_DATA_API_KEY)"

if [ -z "$PG_PW" ] || [ "$PG_PW" = "replace-with-a-strong-password" ]; then
  echo "Deployment blocked: POSTGRES_PASSWORD must be set to a strong non-default value in .env" >&2
  exit 1
fi
if [ -z "$ADMIN_KEY" ] || [ "${#ADMIN_KEY}" -lt 16 ] || [ "$ADMIN_KEY" = "replace-with-a-long-random-secret-at-least-16-chars" ]; then
  echo "Deployment blocked: ADMIN_API_KEY must be at least 16 characters and non-default" >&2
  exit 1
fi
if [ -z "$TD_KEY" ] || [ "$TD_KEY" = "replace-with-your-twelve-data-api-key" ]; then
  echo "Deployment blocked: TWELVE_DATA_API_KEY must be set in .env" >&2
  exit 1
fi

echo "Validating Docker Compose configuration..."
docker compose config --quiet

if [ "${SKIP_PRE_DEPLOY_BACKUP:-false}" != "true" ]; then
  if docker compose ps --status running --services 2>/dev/null | grep -qx "postgres"; then
    echo "Creating pre-deployment database backup..."
    bash ./scripts/backup-db.sh
  fi
fi

APP_SERVICES=(research api worker-ingestion worker-scanner worker-paper worker-notifications worker-backtests worker-monitor)
if [ "$#" -gt 0 ]; then
  TARGET_SERVICES=("$@")
else
  TARGET_SERVICES=("${APP_SERVICES[@]}")
fi

echo "Ensuring PostgreSQL and Redis are running..."
docker compose up -d --no-recreate postgres redis

echo "Building target services: ${TARGET_SERVICES[*]}"
docker compose build migrate "${TARGET_SERVICES[@]}"

echo "Applying database migrations..."
docker compose run --rm migrate

echo "Recreating target Signal Engine services: ${TARGET_SERVICES[*]}"
docker compose up -d "${TARGET_SERVICES[@]}"
docker compose ps

PORT="$(read_env API_PORT)"
PORT="${PORT:-4400}"
HEALTHY=false
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 2
done

if [ "$HEALTHY" != "true" ]; then
  echo "API did not become healthy in time. Inspect: docker compose logs api" >&2
  exit 1
fi

if curl -fsS "http://127.0.0.1:${PORT}/api/v1/strategies" | grep -Eq '"enabled"\s*:\s*true|"approved"\s*:\s*true'; then
  echo "CRITICAL: One or more strategies reported enabled=true or approved=true after deployment!" >&2
  exit 1
fi

echo "API healthy on http://127.0.0.1:${PORT}/api/v1/health and all strategies verified disabled/unapproved."
