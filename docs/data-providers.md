# Market data providers

## Binance USD-M perpetual futures

Signal Engine reads public USD-M perpetual futures market data through Binance's `/fapi/v1/klines` endpoint. No Binance API key is required for public candles. The adapter is read-only and does not include account, order, or execution endpoints.

The configured universe is 20 USDT perpetual pairs. The worker collects completed OHLCV candles and supports historical range backfills.

## OANDA v20

OANDA is the sole configured Forex and metals market-data provider. Signal Engine reads midpoint candles from the v20 instrument candles endpoint. Set `OANDA_API_TOKEN` and configure `OANDA_BASE_URL` for the intended OANDA environment. The example environment uses the practice pricing host; switch `OANDA_BASE_URL` to the live host for production data. OANDA account eligibility and regional availability apply.

The configured instruments are EUR/USD, GBP/USD, USD/JPY, EUR/JPY, and XAU/USD. XAU/USD is gold quoted in US dollars. The provider uses OANDA instrument codes such as `EUR_USD` and `XAU_USD`.

## Data handling

All provider candles are normalized into timestamped OHLCV records. Strategy evaluation uses completed candles only, retains provider provenance, checks staleness, and must backfill gaps. Crypto and Forex candles remain separate provider/instrument series. Do not merge candles from different providers without recording the source change.

Market data access is read-only. No exchange trading credentials, wallet keys, order placement, or automated execution are part of Signal Engine.
