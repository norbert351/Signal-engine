# Signal Engine

Signal Engine is a rule-based market analysis and trading signal backend for crypto perpetual futures and forex. It publishes signals for manual review and paper tracking. It does not execute trades and has no order-placement or withdrawal endpoints.

## Implemented backend foundation

- pnpm/Turborepo monorepo with NestJS API and TypeScript packages.
- PostgreSQL schema and ordered SQL migrations for instruments, OHLCV candles, versioned strategies, signals, events, backtests, Telegram outbox, system health/alerts, paper trades, and backfill progress.
- Binance USD-M perpetual futures public candle adapter with paginated historical backfill for a fixed 20-pair USDT universe.
- OANDA v20 midpoint candle adapter with historical range support for EUR/USD, GBP/USD, USD/JPY, EUR/JPY, and XAU/USD.
- Six rule families: EMA trend pullback, range breakout retest, support/resistance rejection, market-structure continuation, trend-reversal momentum, and volatility-expansion breakout.
- Closed-candle ingestion and scan plans for 1m/5m, 5m/15m, 15m/1h, 1h/4h, and 4h/1d entry/confirmation pairs.
- Signal validation, reward/risk checks, duplicate protection, opposite-direction conflict suppression, expiry, stale-candle rejection, and higher-timeframe close-time guards against lookahead.
- BullMQ workers for ingestion, scanning, paper tracking, backtest execution, Telegram delivery, and monitoring.
- Python research API with historical strategy generation, indicator warmup, next-bar-open entries, two partial targets, fees, spread, slippage, directional funding, conservative stop-first same-candle handling, non-overlapping positions, optional setup expiry, per-instrument/timeframe/style breakdowns, and train/validation/out-of-sample reports.
- Telegram outbox with delivery claims, retries, deduplication, and token redaction in stored errors.
- Admin-protected strategy versioning, backtest submission, approval, and activation endpoints with minimum trade-count gates.
- Read-only API with cursor pagination, component health, alert history, candle freshness, notification backlog, backfill progress/requests, retention controls, a static OpenAPI document, and a small HTML API index.
- Docker Compose services with resource limits, healthchecks, migrations, persistent volumes, and loopback-bound API; database backup/restore scripts; GitHub Actions workflows for TypeScript, PostgreSQL integration, and Python tests.

## Important limitations

- Binance ingestion is live-testable with public data. OANDA requires `OANDA_API_TOKEN`; without it forex/gold ingestion is skipped and reported as degraded.
- Telegram delivery requires `TELEGRAM_BOT_TOKEN` and a chat ID. Without them notifications are not enqueued and the outbox remains empty.
- Strategy configurations are seeded disabled and unapproved. Activation requires a completed backtest for the same key/version, an out-of-sample segment, minimum total/OOS trade counts, and an explicit human review note.
- Backtests are estimates. Provider coverage, missing candles, spread/funding assumptions, out-of-sample trade count, drawdown, and robustness must be reviewed before approval.
- The API binds to `127.0.0.1:4400` by default so it can sit behind the existing nginx reverse proxy. Do not expose it directly to the internet.

## Getting started

See [Local development and API guide](docs/development.md), [Architecture](docs/architecture.md), and [Market data providers](docs/data-providers.md).
