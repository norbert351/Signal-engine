# Local development and API guide

## Start the stack

1. Copy `.env.example` to `.env`.
2. Set a long random `ADMIN_API_KEY`.
3. Add either OANDA practice credentials or a Twelve Data key for forex candles. Binance public candles work without credentials.
4. Add Telegram bot and destination credentials if notifications are wanted.
5. Run `docker compose up --build`.

The API runs at `http://localhost:4000/api/v1`. Research service health runs at `http://localhost:8000/health`. PostgreSQL migrations and candidate/disabled-strategy seeds run before the API starts.

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

`POST /backtests` accepts a strategy key/version, entry bars, higher-timeframe trend bars, strategy parameters, and execution cost assumptions. Bars use millisecond Unix timestamps and decimal-compatible OHLC values. The worker sends jobs to the Python research service, which generates EMA pullback or breakout/retest setups from historical candles, enters on the next bar open, applies costs, resolves same-bar stop/target ambiguity stop-first, and reports train, validation, and out-of-sample metrics.

Example dataset:
```json
{
  "strategyKey": "ema-trend-pullback",
  "strategyVersion": 1,
  "timeframe": "5m",
  "dataset": {
    "strategyParams": {"emaFast": 20, "emaSlow": 50, "atrPeriod": 14, "minRewardRisk": 2},
    "bars": [{"timestamp": 1760000000000, "open": "100", "high": "102", "low": "99", "close": "101"}],
    "trendBars": [{"timestamp": 1759999000000, "open": "98", "high": "103", "low": "97", "close": "102"}]
  },
  "assumptions": {"fee_bps_per_side": 5, "spread_bps": 2, "slippage_bps": 2, "funding_bps_per_8h": 0}
}
```

The example contains too few candles to produce a useful backtest. Supply a complete, source-documented history for both timeframes. Do not use fabricated or incomplete candles.

## Safety boundaries

- The exchange adapter uses public market-data endpoints only.
- No exchange order-placement or withdrawal code exists.
- Strategies are seeded disabled and unapproved.
- Paper outcomes begin only with candles after a signal's publication time.
- Backtests are estimates, not proof of future returns. Review provider coverage, missing candles, spread/funding assumptions, out-of-sample trade count, drawdown, and robustness before approval.
