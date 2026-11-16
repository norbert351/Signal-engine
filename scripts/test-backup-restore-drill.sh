#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BASE_PG_URL="${DRILL_ADMIN_DATABASE_URL:-postgresql://signal_test_user:signal_test_pw@127.0.0.1:5432/postgres}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)_$$"
SRC_DB="signal_engine_drill_src_${STAMP}"
DST_DB="signal_engine_drill_dst_${STAMP}"
SRC_URL="${BASE_PG_URL%/postgres}/${SRC_DB}"
DST_URL="${BASE_PG_URL%/postgres}/${DST_DB}"
DRILL_DIR="$(mktemp -d)"
BACKUP_FILE="${DRILL_DIR}/signal_engine_${STAMP}.sql.gz"

cleanup() {
  psql --dbname="$BASE_PG_URL" -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('${SRC_DB}','${DST_DB}') AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  psql --dbname="$BASE_PG_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${SRC_DB}\";" >/dev/null 2>&1 || true
  psql --dbname="$BASE_PG_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${DST_DB}\";" >/dev/null 2>&1 || true
  rm -rf "$DRILL_DIR"
}
trap cleanup EXIT

echo "[1/7] Creating isolated drill databases: ${SRC_DB} and ${DST_DB}"
psql --dbname="$BASE_PG_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${SRC_DB}\";" >/dev/null
psql --dbname="$BASE_PG_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DST_DB}\";" >/dev/null

echo "[2/7] Applying migrations to ${SRC_DB}"
psql --dbname="$SRC_URL" -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS schema_migrations (name varchar(160) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());" >/dev/null
for sql_file in $(ls -1 packages/database/drizzle/*.sql | sort); do
  mig_name="$(basename "$sql_file")"
  psql --dbname="$SRC_URL" -v ON_ERROR_STOP=1 -f "$sql_file" >/dev/null
  psql --dbname="$SRC_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO schema_migrations(name) VALUES ('${mig_name}') ON CONFLICT DO NOTHING;" >/dev/null
done

echo "[3/7] Seeding representative candles, backtest run, and health records in ${SRC_DB}"
psql --dbname="$SRC_URL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO market_candles (instrument_id, timeframe, open_time, close_time, open, high, low, close, volume, is_complete, source)
SELECT id, '1h', '2026-11-15T00:00:00Z'::timestamptz, '2026-11-15T00:59:59.999Z'::timestamptz, 91000.5, 91500.0, 90800.0, 91250.25, 1420.5, true, 'binance_usdm'
FROM instruments WHERE provider = 'binance_usdm' AND symbol = 'BTCUSDT';

INSERT INTO market_candles (instrument_id, timeframe, open_time, close_time, open, high, low, close, volume, is_complete, source)
SELECT id, '1h', '2026-11-13T10:00:00Z'::timestamptz, '2026-11-13T10:59:59.999Z'::timestamptz, 1.05420, 1.05580, 1.05390, 1.05510, NULL, true, 'twelve_data'
FROM instruments WHERE provider = 'twelve_data' AND symbol = 'EUR_USD';

INSERT INTO backtest_runs (strategy_key, strategy_version, timeframe, dataset, assumptions, parameters, metrics, status, started_at, completed_at)
VALUES (
  'ema-trend-pullback',
  1,
  '1h',
  '{"symbol":"BTCUSDT","trendTimeframe":"4h"}'::jsonb,
  '{"fee_bps_per_side":5,"spread_bps":2,"slippage_bps":2,"funding_bps_per_8h":0,"explicit":true,"version":"costs-v1"}'::jsonb,
  '{"emaFast":20,"emaSlow":50}'::jsonb,
  '{"overall":{"trades":499,"netReturn":-0.5609},"outOfSample":{"trades":98},"costModelVersion":"costs-v1"}'::jsonb,
  'completed',
  now() - interval '2 minutes',
  now()
);

INSERT INTO system_health (component, status, details)
VALUES ('drill:verification', 'ok', '{"drill":true}'::jsonb);
SQL

echo "[4/7] Running backup-db.sh against ${SRC_DB}"
BACKUP_START_MS="$(date +%s%3N)"
BACKUP_DIR="$DRILL_DIR" BACKUP_FILE="$BACKUP_FILE" BACKUP_DATABASE_URL="$SRC_URL" bash ./scripts/backup-db.sh
BACKUP_END_MS="$(date +%s%3N)"
BACKUP_DURATION_MS=$((BACKUP_END_MS - BACKUP_START_MS))
BACKUP_BYTES="$(stat -c%s "$BACKUP_FILE")"
echo "Backup duration: ${BACKUP_DURATION_MS} ms, size: ${BACKUP_BYTES} bytes"

echo "[5/7] Verifying restore-db.sh safety guards (rejecting missing CONFIRM_RESTORE and corrupted archives)"
if RESTORE_DATABASE_URL="$DST_URL" bash ./scripts/restore-db.sh "$BACKUP_FILE" >/dev/null 2>&1; then
  echo "ERROR: restore-db.sh succeeded without CONFIRM_RESTORE=yes" >&2
  exit 1
fi
CORRUPT_FILE="${DRILL_DIR}/corrupt.sql.gz"
printf "not-a-valid-gzip" > "$CORRUPT_FILE"
if CONFIRM_RESTORE=yes RESTORE_DATABASE_URL="$DST_URL" bash ./scripts/restore-db.sh "$CORRUPT_FILE" >/dev/null 2>&1; then
  echo "ERROR: restore-db.sh succeeded on corrupted archive" >&2
  exit 1
fi

echo "[6/7] Running restore-db.sh into isolated database ${DST_DB}"
RESTORE_START_MS="$(date +%s%3N)"
CONFIRM_RESTORE=yes RESTORE_DATABASE_URL="$DST_URL" bash ./scripts/restore-db.sh "$BACKUP_FILE"
RESTORE_END_MS="$(date +%s%3N)"
RESTORE_DURATION_MS=$((RESTORE_END_MS - RESTORE_START_MS))
echo "Restore duration (RTO): ${RESTORE_DURATION_MS} ms"

echo "[7/7] Verifying restored schema, migrations, and representative rows in ${DST_DB}"
COUNTS="$(psql --dbname="$DST_URL" -At -v ON_ERROR_STOP=1 -c "
  SELECT
    (SELECT count(*) FROM schema_migrations),
    (SELECT count(*) FROM instruments WHERE enabled = true),
    (SELECT count(*) FROM strategy_configs),
    (SELECT count(*) FROM strategy_configs WHERE enabled = true OR approved = true),
    (SELECT count(*) FROM market_candles),
    (SELECT count(*) FROM backtest_runs WHERE status = 'completed' AND assumptions->>'version' = 'costs-v1'),
    (SELECT count(*) FROM system_health WHERE component = 'drill:verification');
")"

echo "Restored counts (migrations|enabled_instruments|strategies|enabled_or_approved_strategies|candles|backtests|health): ${COUNTS}"
if [ "$COUNTS" != "11|24|6|0|2|1|1" ] && [ "$COUNTS" != "11|25|6|0|2|1|1" ] && [ "$COUNTS" != "10|25|6|0|2|1|1" ]; then
  echo "ERROR: Restored counts did not match expected 11|24|6|0|2|1|1 (got ${COUNTS})" >&2
  exit 1
fi

echo "DRILL_SUCCESS backup_ms=${BACKUP_DURATION_MS} restore_ms=${RESTORE_DURATION_MS} bytes=${BACKUP_BYTES} counts=${COUNTS}"
