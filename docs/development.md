# Local development, operations, and API guide

## Start the stack

1. Copy `.env.example` to `.env`.
2. Set a long random `ADMIN_API_KEY` (at least 16 characters) and a strong `POSTGRES_PASSWORD`.
3. Add an OANDA v20 personal access token and account ID for forex and XAU/USD candles. Binance USD-M public perpetual candles need no API key.
4. Add a Telegram bot token and destination chat ID(s) if notifications are wanted.
5. Run `docker compose up --build` or `./scripts/deploy.sh`.

The API runs on `127.0.0.1:4400` by default (`http://localhost:4400/api/v1`) and is intended to sit behind nginx. Research service health is at `http://localhost:8000/health`. PostgreSQL migrations and disabled strategy seeds run before the API and workers start. A static OpenAPI document is served at `/api/v1/openapi.json`, with a small HTML index at `/api/v1/docs`.

For a one-time historical backfill, set `RUN_INITIAL_BACKFILL=true` with valid `BACKFILL_START` and `BACKFILL_END` UTC timestamps before starting the ingestion worker. The ingestion worker also processes admin-requested backfills from the `backfill_progress` queue. Backfills are chunked (`BACKFILL_CHUNK_DAYS`, default 30) and resumable. Include at least 100 days before the evaluation window for indicator warmup. Start with a short range and monitor provider limits.

## Tests

- `pnpm build`, `pnpm typecheck`, and `pnpm test` cover the TypeScript workspace.
- `TEST_DATABASE_URL=postgresql://user:pass@host:5432/test_db pnpm --filter @signal-engine/database test` applies all migrations to that test database and runs repository integration tests. The suite drops and recreates the `public` schema, so only point it at a disposable database whose name contains `test`.
- Python tests run from `services/research` with `pip install -e ".[dev]" && python -m pytest -q`, or in Docker: `docker run --rm -v "$PWD":/app -w /app/services/research python:3.12-slim sh -c "pip install -q -e '.[dev]' && python -m pytest -q"`.

## Market scanner

The scanner evaluates the configured 20 USDT perpetual crypto instruments and five OANDA instruments: EUR/USD, GBP/USD, USD/JPY, EUR/JPY, and XAU/USD. It ingests and evaluates 1m, 5m, 15m, 1h, 4h, and 1d candles. Entry/confirmation pairs are 1m/5m, 5m/15m, 15m/1h, 1h/4h, and 4h/1d. Only completed, sufficiently recent candles and enabled, approved strategies can publish signals. Signals must pass stop-distance and minimum reward/risk checks. Duplicate signals are blocked by a deterministic key, and an opposite-direction open signal on the same symbol/timeframe suppresses a conflicting publication. If no strategy passes, no alert is sent.

All six strategy families are implemented: EMA trend pullback, range breakout retest, support/resistance rejection, market-structure continuation, trend-reversal momentum, and volatility-expansion breakout. They remain disabled until separately backtested and approved.

## Main API routes

- `GET /health`
- `GET /system/health`, `GET /system/alerts`, `GET /system/candles`, `GET /system/notifications`, `GET /system/backfills`
- `GET /instruments`
- `GET /signals?market=crypto_perpetual&symbol=BTCUSDT&status=PENDING&limit=50`
- `GET /signals/:id`
- `GET /strategies`, `GET /strategies/:id`
- `POST /strategies` (admin)
- `PATCH /strategies/:id/approval` with `{"approved":true,"note":"Reviewed completed out-of-sample report and accepted documented limitations."}` (admin)
- `PATCH /strategies/:id/enabled` with `{"enabled":true}` (admin)
- `POST /backtests`, `GET /backtests` (POST is admin)
- `GET /paper-trades`, `GET /paper-trades/summary`
- `POST /system/backfills`, `POST /system/backfills/:id/reset`, `POST /system/retention` (admin)
- `GET /openapi.json`, `GET /docs`

Admin routes require the `x-admin-api-key` header. A strategy must have a completed backtest for the same key/version with an out-of-sample segment, at least `MIN_BACKTEST_TRADES` total trades (default 30), at least `MIN_OOS_TRADES` out-of-sample trades (default 10), and a human approval note before it can be enabled. Approval and activation are separate actions.

## Backtest request shape

Preferred flow: use `GET /instruments` to find an instrument ID, then submit `POST /backtests` with `strategyKey`, `strategyVersion`, `instrumentId`, `timeframe`, `trendTimeframe`, `start`, `end`, and `assumptions`. Strategy parameters are snapshotted from the matching versioned strategy record in PostgreSQL. The worker loads stored candles with 100 days of indicator warmup before the requested evaluation window, includes volume, and passes the live expiry window for the timeframe. The research service generates setups using only candles available at each signal time, enters on the next bar open, models two partial targets, fees, spread, slippage, and directional funding, resolves same-bar stop/target ambiguity stop-first, prevents overlapping positions, exits at expiry, and reports train, validation, out-of-sample, walk-forward, and per-instrument/timeframe/style breakdowns.

A manual dataset containing `bars` and `trendBars` is also accepted for imported data. Bars use millisecond Unix open/close timestamps, decimal-compatible OHLC values, and optional `volume`.

## Monitoring and operations

The `worker-monitor` service writes component health, detects stale worker heartbeats, checks database/Redis/Binance/OANDA reachability, detects stale or missing candles (with forex weekend handling), tracks memory/CPU/disk, monitors notification and backfill failures, and deduplicates alerts. New and resolved alerts are sent through the Telegram outbox when configured. Delivered notifications and resolved alerts are pruned by the retention job (`RETENTION_NOTIFICATION_DAYS`, `RETENTION_ALERT_DAYS`).

Database backups:

```sh
./scripts/backup-db.sh
CONFIRM_RESTORE=yes ./scripts/restore-db.sh backups/signal_engine_<timestamp>.sql.gz
```

Stop the API and workers before restoring. Backups default to `./backups` and keep 14 days (`BACKUP_RETENTION_DAYS`).

## Safety boundaries

- Binance integration uses public USD-M Futures market-data endpoints only. No Binance API key is needed for candle retrieval.
- OANDA market-data requests use a personal access token. Keep it in a private environment variable.
- No exchange order-placement or withdrawal code exists. No trading permission is required.
- Strategies are seeded disabled and unapproved.
- Paper outcomes begin only with candles after a signal's publication time.
- Backtests are estimates, not proof of future returns. Review provider coverage, missing candles, spread/funding assumptions, out-of-sample trade count, drawdown, and robustness before approval.
