# Market data providers

## Binance USD-M perpetual futures

Signal Engine reads public USD-M perpetual futures market data through Binance's `/fapi/v1/klines` endpoint. No Binance API key is required for public candles. The adapter is read-only and does not include account, order, or execution endpoints.

The configured universe is 20 USDT perpetual pairs. The worker collects completed OHLCV candles and supports historical range backfills.

## Twelve Data (Forex and gold)

Twelve Data is the sole configured Forex and metals market-data provider. Signal Engine reads candles from the read-only `/time_series` endpoint and verifies symbols with `/symbol_search`. Set `TWELVE_DATA_API_KEY` in the environment. No brokerage account, account ID, or trading credentials are used, and there is no order or execution endpoint.

The configured instruments are EUR/USD, GBP/USD, USD/JPY, EUR/JPY, and XAU/USD. XAU/USD is gold quoted in US dollars. Signal Engine stores these internally as `EUR_USD`, `GBP_USD`, `USD_JPY`, `EUR_JPY`, and `XAU_USD` and sends the slash form to Twelve Data.

Supported intervals map as `1m→1min`, `5m→5min`, `15m→15min`, `1h→1h`, `4h→4h`, `1d→1day`. Intraday candles are requested with `timezone=UTC`. Daily candles are returned in exchange-local time and, for spot forex/metals, as date-only labels; Signal Engine anchors each daily candle at UTC midnight of the labelled date rather than interpreting an exchange-local datetime as UTC.

Forex and metals candles do not include volume. Signal Engine stores `NULL` volume and never fabricates it. Volume-dependent strategies treat missing volume as unavailable and do not generate signals from it.

### API credits and quota

The `/time_series` endpoint costs one API credit per symbol request; `/symbol_search` also consumes a credit, while `/api_usage` is free. The ingestion worker reads `/api_usage`, respects the plan's per-minute and daily limits, and enforces a self-imposed daily budget (`FOREX_DAILY_CREDIT_BUDGET`, default 640) with a safety margin (`FOREX_CREDIT_SAFETY_MARGIN`, default 80) so the daily allowance is never exhausted. Only series whose last stored completed candle is older than the configured per-timeframe poll interval are refreshed, so unchanged history is never re-downloaded.

**Realistic budget (Basic plan: 8 credits/min, 800 credits/day, 5 forex instruments):** `/time_series` costs 1 credit per symbol request. With safety margin `FOREX_CREDIT_SAFETY_MARGIN=80` and self-budget `FOREX_DAILY_CREDIT_BUDGET=640`, the effective ceiling is `min(640, 800-80)=640` credits/day (ingestion pauses at/under the margin; allowance never exhausted).

| Timeframe | Poll interval | Requests/symbol/day | Credits/day (5 symbols) | Role |
|---|---:|---:|---:|---|
| 1d | 1440m | 1 | 5 | reliable swing confirmation |
| 4h | 240m | 6 | 30 | reliable intraday/swing |
| 1h | 60m | 24 | 120 | reliable intraday |
| 15m | 30m | 48 | 240 | reliable intraday (prioritized) |
| 5m | 360m | 4 | 20 | best-effort only |
| 1m | 720m | 2 | 10 | best-effort only |
| **Total (steady state)** | | | **425** | within 640 budget |

Reliable 15m/1h/4h/1d coverage is prioritized (~395 credits/day) and fits the plan with headroom. **1m/5m forex freshness is best-effort and not guaranteed** on this plan: sustaining closed-candle freshness for 5 symbols would require ~7,200 (1m) or ~1,440 (5m) credits/day, far above plan limits. When budget/margin/quota is reached, ingestion pauses and reports quota state in health; the scanner rejects stale/incomplete candles, so no signals are generated from stale forex data. True low-timeframe forex scalping requires higher plan/credits (not assumed).

## Data handling

All provider candles are normalized into timestamped OHLCV records. Strategy evaluation uses completed candles only, retains provider provenance, checks staleness, and must backfill gaps. Crypto and Forex candles remain separate provider/instrument series. Do not merge candles from different providers without recording the source change.

Market data access is read-only. No exchange trading credentials, wallet keys, order placement, or automated execution are part of Signal Engine.
