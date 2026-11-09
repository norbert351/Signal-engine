# Signal Engine

Signal Engine is a rule-based market analysis and trading signal backend for crypto perpetual futures and forex. It publishes signals for manual review and paper tracking. It does not execute trades.

## Implemented backend foundation

- pnpm/Turborepo monorepo with NestJS API and TypeScript packages.
- PostgreSQL schema and ordered SQL migrations for instruments, OHLCV candles, versioned strategies, signals, events, backtests, Telegram outbox, system health, and paper trades.
- Binance USD-M Futures public candle adapter with paginated historical backfill.
- OANDA v20 and Twelve Data forex adapters with historical range support.
- EMA trend-pullback and range breakout/retest rule evaluators for 5m/15m and 4h/1d analysis.
- Signal validation, reward/risk checks, duplicate protection, expiry, and stale-candle rejection.
- BullMQ workers for ingestion, scanning, paper tracking, backtest execution, and Telegram delivery.
- Python research API with next-bar-open backtests, cost assumptions, conservative stop-first same-candle handling, non-overlapping positions, and train/validation/out-of-sample reports.
- Telegram outbox with delivery claims, retries, and deduplication.
- Admin-protected strategy approval, activation, and backtest submission endpoints.
- Docker Compose services for PostgreSQL, Redis, API, workers, and research.
- GitHub Actions workflows for TypeScript build/typecheck/tests and Python tests.

## Important limitations

This repository has been populated through GitHub commits, but the full build has not yet been executed in a local runtime. GitHub Actions has not yet returned a verified run. The API and workers need integration testing against real provider credentials and a running PostgreSQL/Redis stack before production use. Strategy configurations are seeded disabled and unapproved. They require a completed out-of-sample backtest and an explicit admin review note before activation.

The candidate universe starts with 10 crypto perpetual symbols and 10 forex pairs. Provider availability, contract listing, spreads, data gaps, and account/regional access must be checked. Historical results are estimates, not guarantees of future performance.

## Getting started

See [Local development and API guide](docs/development.md), [Architecture](docs/architecture.md), and [Market data providers](docs/data-providers.md).
