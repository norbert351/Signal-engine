# Signal Engine architecture

## Scope
Signal Engine produces explainable, rule-based analysis and publishes trade ideas for manual review. It does not connect to exchange order-placement endpoints and must never request trading or withdrawal permissions.

## Services
- NestJS API for read APIs, health, administration, signals, paper trades, and backtest orchestration. Binds to `127.0.0.1:4400` by default for use behind nginx.
- Market-data adapters normalize exchange and broker candles into common OHLCV.
- Ingestion worker collects closed candles, processes resumable historical backfills, and polls admin backfill requests.
- Scanner worker evaluates closed candles against enabled, approved, versioned strategies and suppresses conflicting open signals.
- Paper tracker tracks only signals after their publication timestamp.
- Backtest worker sends stored candle ranges and strategy parameter snapshots to the Python research service.
- Notification worker delivers Telegram messages through a persistent outbox with retries and deduplication.
- Monitor worker records component health, candle freshness, worker heartbeats, host resources, notification/backfill failures, and deduplicated alerts.
- PostgreSQL stores durable records. Redis/BullMQ handles queues, repeatable jobs, and coordination.

## Providers
Crypto: Binance USDⓈ-M Futures public market-data endpoints only. Forex and gold: OANDA v20 midpoint candles when account and regional access permit. Never commit provider credentials.

## Candidate universe
Crypto (20 USDT perpetuals): BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, LINKUSDT, AVAXUSDT, LTCUSDT, DOTUSDT, TRXUSDT, TONUSDT, SUIUSDT, NEARUSDT, APTUSDT, ARBUSDT, OPUSDT, UNIUSDT, BCHUSDT.

Forex and metals (5 OANDA instruments): EUR_USD, GBP_USD, USD_JPY, EUR_JPY, XAU_USD.

These are candidates, not a claim that every symbol is currently listed or liquid. Verify provider availability and liquidity at runtime.

## Timeframes and strategies
Ingested timeframes: 1m, 5m, 15m, 1h, 4h, 1d. Entry/confirmation pairs: 1m/5m, 5m/15m, 15m/1h, 1h/4h, 4h/1d. Only completed candles may trigger signals.

Implemented strategy families: EMA trend pullback, range breakout retest, support/resistance rejection, market-structure continuation, trend-reversal momentum, and volatility-expansion breakout. Configurations are versioned, parameter-hashed, disabled, and unapproved by default. None is presumed profitable.

## Signal lifecycle
Candidate -> validated -> published -> active -> target/stop/expired/invalidated. Persist immutable signal snapshots and append lifecycle events. Enforce data freshness, duplicate suppression, explicit entry type, expiry, opposite-direction conflict suppression, and minimum reward/risk policy.

## Research integrity
Backtests must be chronological and avoid lookahead. Model fees, spread, slippage, and perpetual funding where relevant. Resolve same-candle stop/target ambiguity conservatively (stop first). Store strategy version, parameters, provider, symbol, timeframe, date range, and cost assumptions. Separate training, validation, and untouched out-of-sample windows. The live scanner applies a per-timeframe expiry window, and the backtester receives the same window so results match production behavior.

## Persistence
Core tables: `instruments`, `candles`, `strategy_configs`, `signals`, `signal_events`, `backtest_runs`, `paper_trade_records`, `notification_outbox`, `notification_deliveries`, `backfill_progress`, `system_health`, `system_alerts`, and `worker_heartbeats`. Migrations are ordered SQL files applied by the `migrate` Compose service before API and workers start.

## Operations
All Compose services have restart policies and memory limits. The API has a healthcheck. PostgreSQL and Redis use named volumes. `scripts/backup-db.sh` and `scripts/restore-db.sh` handle compressed dumps. Retention prunes delivered notifications and resolved alerts. The monitor worker emits deduplicated alert and recovery notifications through the same Telegram outbox.
