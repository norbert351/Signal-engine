# Local development and API guide

## Start the stack

1. Copy `.env.example` to `.env`.
2. Set a long random `ADMIN_API_KEY`.
3. Add an OANDA v20 personal access token and account ID for Forex and XAU/USD market candles. Binance USD-M public perpetual candles need no API key.
4. Add a Telegram bot token and destination chat ID if notifications are wanted.
5. Run `docker compose up --build`.

The API runs at `http://localhost:4000/api/v1`. Research service health runs at `http://localhost:8000/health`. PostgreSQL migrations and disabled strategy seeds run before the API starts. For a one-time historical backfill, set `RUN_INITIAL_BACKFILL=true` with valid `BACKFILL_START` and `BACKFILL_END` UTC timestamps before starting the worker. Backfills are paginated and can take time. Include at least 100 days before the evaluation window for indicator warmup. Start with a short range and monitor provider limits.

## Market scanner

The scanner evaluates the configured 20 USDT perpetual crypto instruments and five OANDA instruments: EUR/USD, GBP/USD, USD/JPY, EUR/JPY and XAU/USD. It ingests and evaluates 1m, 5m, 15m, 1h, 4h and 1d candles. Entry scans run on 1m and 5m for scalping, 15m and 1h for intraday, and 4h for swing. Each entry timeframe is checked against a higher timeframe. Only completed, sufficiently recent candles and enabled, approved strategies can publish signals. Signals must pass the configured stop-distance and minimum reward/risk checks. Duplicate signals are blocked by a deterministic key. If no strategy passes, no alert is sent.

The scanner currently supports the EMA trend-pullback and range breakout/retest evaluators. Additional confluence filters and strategy families should be added and separately backtested before activation. A market scan is not a guarantee that an opportunity is profitable.

## Main API routes

- `GET /health`
- `GET /system/health`
- `GET /instruments`
- `GET /signals?market=crypto_perpetual&symbol=BTCUSDT&status=published&limit=50`
- `GET /strategies`
- `PATCH /strategies/:id/approval` with `{"approved":true,"note":"Reviewed completed out-of-sample report and accepted documented limitations."}`
- `PATCH /strategies/:id/enabled` with `{"enabled":true}`
- `POST /backtests`
- `GET /backtests`
- `GET /paper-trades`

Admin routes require the `x-admin-api-key` header. A strategy must have a completed backtest with an out-of-sample segment and a human approval note before it can be enabled. Approval and activation are separate actions.

## Backtest request shape

Preferred flow: use `GET /instruments` to find an instrument ID, then submit `POST /backtests` with `strategyKey`, `strategyVersion`, `instrumentId`, `timeframe`, `trendTimeframe`, `start`, `end` and `assumptions`. Strategy parameters are snapshotted from the matching versioned strategy record in PostgreSQL. The worker loads stored candles and includes 100 days of indicator warmup before the requested evaluation window. The research service generates EMA pullback or breakout/retest setups using only candles available at each signal time, enters on the next bar open, models two partial targets, fees, spread, slippage and directional funding, resolves same-bar stop/target ambiguity stop-first, prevents overlapping positions, and reports train, validation and out-of-sample metrics.

A manual dataset containing `bars` and `trendBars` is also accepted for imported data. Bars use millisecond Unix open and close timestamps and decimal-compatible OHLC values.

## Safety boundaries

- Binance integration uses public USD-M Futures market-data endpoints only. No Binance API key is needed for candle retrieval.
- OANDA market-data requests use a personal access token. Keep it in a private environment variable.
- No exchange order-placement or withdrawal code exists. No trading permission is required.
- Strategies are seeded disabled and unapproved.
- Paper outcomes begin only with candles after a signal's publication time.
- Backtests are estimates, not proof of future returns. Review provider coverage, missing candles, spread/funding assumptions, out-of-sample trade count, drawdown and robustness before approval.
