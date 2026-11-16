#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${BACKUP_FILE:-$BACKUP_DIR/signal_engine_${STAMP}.sql.gz}"
TMP_FILE="${FILE}.tmp"

mkdir -p "$BACKUP_DIR"

cleanup_tmp() {
  rm -f "$TMP_FILE"
}
trap cleanup_tmp EXIT

if [ -n "${BACKUP_DATABASE_URL:-}" ]; then
  pg_dump --dbname="$BACKUP_DATABASE_URL" --clean --if-exists --no-owner --no-privileges | gzip -c > "$TMP_FILE"
else
  docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges' | gzip -c > "$TMP_FILE"
fi

if [ ! -s "$TMP_FILE" ]; then
  echo "Backup failed: $TMP_FILE is empty" >&2
  exit 1
fi

if ! gzip -t "$TMP_FILE"; then
  echo "Backup failed: $TMP_FILE failed gzip integrity check" >&2
  exit 1
fi

if ! gunzip -c "$TMP_FILE" | grep -q "PostgreSQL database dump complete"; then
  echo "Backup failed: $TMP_FILE does not contain complete pg_dump footer" >&2
  exit 1
fi

mv "$TMP_FILE" "$FILE"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$FILE")" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256")
fi

find "$BACKUP_DIR" -name 'signal_engine_*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -delete
find "$BACKUP_DIR" -name 'signal_engine_*.sql.gz.sha256' -type f -mtime "+${RETENTION_DAYS}" -delete
echo "Backup verified and written: $FILE"
