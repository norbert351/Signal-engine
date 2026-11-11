#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/signal_engine_${STAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' | gzip > "$FILE"

if [ ! -s "$FILE" ]; then
  echo "Backup failed: $FILE is empty" >&2
  rm -f "$FILE"
  exit 1
fi

find "$BACKUP_DIR" -name 'signal_engine_*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -delete
echo "Backup written: $FILE"
