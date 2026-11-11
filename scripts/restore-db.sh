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

echo "Restoring $FILE into the configured signal_engine database..."
gunzip -c "$FILE" | docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
echo "Restore complete. Run migrations, then start the API and workers."
