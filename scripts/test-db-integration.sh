#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PW=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
DB_NAME="signal_engine_test_$(date +%s)_$$"
URL="postgresql://signal:${PW}@postgres:5432/${DB_NAME}"
echo "Creating isolated DB ${DB_NAME}"
docker compose exec -T postgres psql -U signal -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DB_NAME}\" OWNER signal;" >/dev/null
cleanup() {
  echo "Cleaning up ${DB_NAME}"
  docker compose exec -T postgres psql -U signal -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  docker compose exec -T postgres psql -U signal -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${DB_NAME}\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker compose exec -T -e TEST_DATABASE_URL="$URL" -e DATABASE_URL="$URL" api sh -lc 'cd /app/packages/database && node /app/node_modules/.pnpm/vitest@3.2.7_@types+node@22.20.5_tsx@4.23.15/node_modules/vitest/dist/cli.js run'
