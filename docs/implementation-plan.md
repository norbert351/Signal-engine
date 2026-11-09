# Backend implementation plan

1. Repository and runtime foundation, environment validation, lint/typecheck/test conventions.
2. PostgreSQL schema and migrations for instruments, candles, strategies, signals, events, backtests, notification outbox, and health.
3. Provider interfaces plus Binance futures and OANDA/Twelve Data adapters with normalization, retries, rate limits, and freshness checks.
4. Closed-candle ingestion and BullMQ scheduling.
5. Versioned strategy evaluation, risk calculations, signal validation, expiry, and invalidation.
6. Chronological Python backtester with transaction-cost model and report metrics.
7. Paper outcome tracker and Telegram outbox/delivery worker.
8. NestJS endpoints, admin authentication, observability, Docker deployment, CI, and integration tests.

No strategy is enabled for publication until validation gates are met. No order execution is in scope.
