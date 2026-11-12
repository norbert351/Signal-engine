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

The `/time_series` endpoint costs one API credit per symbol request; `/symbol_search` also consumes a credit, while `/api_usage` is free. The ingestion worker reads `/api_usage`, respects the plan's per-minute and daily limits, and enforces a self-imposed daily credit budget (`FOREX_DAILY_CREDIT_BUDGET`, default 640). Only series whose last stored completed candle is older than the configured per-timeframe poll interval are refreshed, so unchanged history is never re-downloaded. The free/basic plan (8 credits/minute, 800 credits/day) cannot support live 1-minute scalping across all five instruments; the default poll schedule prioritizes 15m/1h/4h/1d candles and the scanner safely skips any timeframe whose data is stale.

## Data handling

All provider candles are normalized into timestamped OHLCV records. Strategy evaluation uses completed candles only, retains provider provenance, checks staleness, and must backfill gaps. Crypto and Forex candles remain separate provider/instrument series. Do not merge candles from different providers without recording the source change.

Market data access is read-only. No exchange trading credentials, wallet keys, order placement, or automated execution are part of Signal Engine.
