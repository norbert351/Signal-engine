# Backend implementation plan

Status: implemented. Remaining work is operational validation and strategy research, not missing backend code.

1. Repository and runtime foundation, environment validation, lint/typecheck/test conventions. Done.
2. PostgreSQL schema and migrations for instruments, candles, strategies, signals, events, backtests, notification outbox, paper trades, backfills, health, and alerts. Done.
3. Provider interfaces plus Binance USD-M futures and OANDA v20 adapters with normalization, pagination, retries, rate limits, and freshness checks. Done; OANDA requires credentials.
4. Closed-candle ingestion, resumable historical backfills, and BullMQ scheduling. Done.
5. Versioned strategy evaluation, six strategy families, risk calculations, signal validation, expiry, conflict suppression, and invalidation. Done.
6. Chronological Python backtester with transaction costs, funding, two targets, stop-first ambiguity handling, expiry, breakdowns, and train/validation/out-of-sample metrics. Done.
7. Paper outcome tracker and Telegram outbox/delivery worker. Done; Telegram requires credentials.
8. NestJS endpoints, admin authentication, rate limiting, OpenAPI document, observability, monitoring worker, retention, Docker deployment, CI, and PostgreSQL integration tests. Done.
9. Operational rollout: create production `.env`, run migrations, verify live Binance ingestion and limited backfill, run per-strategy backtests, review out-of-sample results, approve and enable only strategies that meet the documented gates. Pending deployment.

No strategy is enabled for publication until validation gates are met. No order execution is in scope.
