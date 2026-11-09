# Signal Engine architecture

## Scope
Signal Engine produces explainable, rule-based analysis and publishes trade ideas for manual review. It does not connect to exchange order-placement endpoints and must never request trading or withdrawal permissions.

## Services
- NestJS API for read APIs, health, configuration administration, signals, and backtest orchestration.
- Market-data adapters normalize exchange and broker candles into common OHLCV.
- Scanner worker evaluates closed candles against enabled, versioned strategies.
- Backtest worker simulates chronologically with realistic costs and out-of-sample splits.
- Paper tracker tracks only signals after their publication timestamp.
- Notification worker delivers Telegram messages through a persistent outbox.
- PostgreSQL stores durable records. Redis/BullMQ handles queues and coordination.

## Providers
Crypto: Binance USDⓈ-M Futures public market-data endpoints only. Forex: OANDA v20 when account and regional access permit. Keep Twelve Data as an alternative. Never commit provider credentials.

## Candidate universe
Crypto: BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, LINKUSDT, AVAXUSDT, LTCUSDT, BCHUSDT, DOTUSDT, TRXUSDT, SUIUSDT, APTUSDT, NEARUSDT, UNIUSDT, ETCUSDT, FILUSDT, ARBUSDT.
Forex: EUR_USD, GBP_USD, USD_JPY, AUD_USD, USD_CAD, USD_CHF, NZD_USD, EUR_GBP, EUR_JPY, GBP_JPY.

These are candidates, not a claim that every symbol is currently listed or liquid. Verify provider availability and liquidity at runtime.

## Timeframes and strategies
Scalping research: 5m entry with 15m trend context. Swing research: 4h entry with 1d trend context. Only completed candles may trigger signals. Initial candidates are EMA trend-pullback and range breakout/retest. Configurations are versioned and disabled by default. Neither strategy is presumed profitable.

## Signal lifecycle
Candidate -> validated -> published -> active -> target/stop/expired/invalidated. Persist immutable signal snapshots and append lifecycle events. Enforce data freshness, duplicate suppression, explicit entry type, expiry, and minimum reward/risk policy.

## Research integrity
Backtests must be chronological and avoid lookahead. Model fees, spread, slippage, and perpetual funding where relevant. Resolve same-candle stop/target ambiguity conservatively. Store strategy version, parameters, provider, symbol, timeframe, date range, and cost assumptions. Separate training, validation, and untouched out-of-sample windows.
