# Market data providers

## Binance USD-M Futures
Uses public `/fapi/v1/klines` data. No API key is needed for public candles. This adapter is read-only and does not include order endpoints.

## OANDA v20
Uses the instrument candles endpoint with midpoint prices. Set `OANDA_API_TOKEN` and choose the practice or live base URL explicitly. Broker account availability and regional restrictions apply. The adapter does not access account orders or place trades.

## Twelve Data
Fallback forex time-series adapter. Set `TWELVE_DATA_API_KEY`. Check plan limits and symbol coverage before enabling broad polling.

All providers normalize into timestamped OHLCV candles. Consumers must persist only completed candles for strategy evaluation, retain provider provenance, monitor staleness, and handle rate limits. Do not merge candle series from different providers without recording the source change.
