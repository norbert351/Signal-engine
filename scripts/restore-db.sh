#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Usage: CONFIRM_RESTORE=yes $0 backups/signal_engine_<timestamp>.sql.gz" >&2
  exit 1
fi
if [ "${CONFIRM_RESTORE:-}" != "yes" ]; then
  echo "Refusing to restore without CONFIRM_RESTORE=yes." >&2
  echo "Stop the API and workers first, then re-run with CONFIRM_RESTORE=yes." >&2
  exit 1
fi

if ! gzip -t "$FILE"; then
  echo "Refusing to restore: $FILE failed gzip integrity verification." >&2
  exit 1
fi

if ! gunzip -c "$FILE" | grep -q "PostgreSQL database dump complete"; then
  echo "Refusing to restore: $FILE is incomplete (missing pg_dump completion marker)." >&2
  exit 1
fi

if [ -f "${FILE}.sha256" ] && command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" >/dev/null)
fi

if [ -n "${RESTORE_DATABASE_URL:-}" ]; then
  echo "Restoring $FILE into isolated target URL..."
  gunzip -c "$FILE" | psql -v ON_ERROR_STOP=1 --dbname="$RESTORE_DATABASE_URL" >/dev/null
  echo "Isolated restore complete."
  exit 0
fi

TARGET_DB="${TARGET_DB:-}"
if [ -z "$TARGET_DB" ] && [ "${ALLOW_LIVE_RESTORE:-}" != "yes" ]; then
  RUNNING="$(docker compose ps --status running --services 2>/dev/null | grep -E '^(api|worker-)' || true)"
  if [ -n "$RUNNING" ]; then
    echo "Refusing to restore into primary database while services are running: $RUNNING" >&2
    echo "Stop api and worker-* first or set TARGET_DB=<isolated_db> for a restore drill." >&2
    exit 1
  fi
fi

echo "Restoring $FILE into ${TARGET_DB:-configured signal_engine database}..."
if [ -n "$TARGET_DB" ]; then
  gunzip -c "$FILE" | docker compose exec -T -e TARGET_DB="$TARGET_DB" postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$TARGET_DB"' >/dev/null
else
  gunzip -c "$FILE" | docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null
fi
echo "Restore complete. Run migrations if needed, then start the API and workers."
