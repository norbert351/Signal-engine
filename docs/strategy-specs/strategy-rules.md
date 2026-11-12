# Phase 4 Strategy Rule Specification (Parity Baseline)

Purpose: define intended, deterministic rules for TS (`packages/core/src/strategies.ts`) and Python (`services/research/signal_engine_research/strategies.py`) parity. Any material divergence blocks production readiness for that strategy.

## Shared conventions
- **Data:** only completed candles; timestamps strictly increasing; OHLC valid. Entry evaluation uses last completed entry candle; higher-timeframe (trend) candles must have `closeTime <= trigger closeTime` (no lookahead).
- **Trend filter:** `emaFast`/`emaSlow` on trend candles; `long` when `emaFast > emaSlow && close > emaFast`, `short` when `emaFast < emaSlow && close < emaFast`, else no directional trend. Strategies requiring aligned trend reject `range`.
- **ATR:** Wilder-style ATR over `atrPeriod` on entry candles; required and > 0.
- **Targets:** two targets from entry risk `R = |entry-stop|` at `minRewardRisk * R` (T1) and `target2Multiple * R` (T2), 50/50 allocation in backtest model.
- **RR gate:** `reward/risk(entry,stop,T1) >= minRewardRisk`.
- **Stop:** must be on valid side of entry and reflect structural/ATR logic per strategy; never widened beyond invalid side.
- **Determinism/tolerances:** compare booleans/direction/trigger time exactly; prices/ratios compared with absolute tolerance `1e-8` (or instrument precision where applicable) after normalization; Decimal-string and float representations considered equal within tolerance.

## Strategies

### 1. `ema-trend-pullback` (v1)
- HTF trend aligned long/short (not range).
- Pullback: prior bar touched/reclaimed fast EMA zone (`prior.low <= emaFast[prior]*1.002` long / `prior.high >= emaFast[prior]*0.998` short) and trigger bar closes back through fast EMA in trend direction with confirming body (`close > emaFast && close > open` long / `close < emaFast && close < open` short).
- Stop: min/max of recent structural extreme over `atrPeriod` bars and `close ± atr*stopAtrMultiple`.

### 2. `range-breakout-retest` (v1)
- HTF trend aligned.
- Prior `rangeLookback` bars (excluding breakout and trigger) define range high/low; breakout bar closes beyond range in trend direction; trigger bar retests broken boundary within `atr*retestToleranceAtr` and closes back outside with confirming body.
- Stop: beyond retest extreme/boundary by tolerance.

### 3. `support-resistance-rejection` (v1)
- HTF trend aligned.
- Confirmed S/R from completed swing pivots (`swingLeft/swingRight`) within `srLookback`, clustered by `srTolerancePct`; relevant level on trade side of price (support below for long, resistance above for short). Trigger rejects level within `atr*srToleranceAtr`, closes on correct side with rejection candle.
- Stop: beyond rejection wick/level buffer (`atr*0.25`).

### 4. `market-structure-continuation` (v1)
- HTF trend aligned; entry structure trend matches HTF (higher-high/higher-low for up, lower-high/lower-low for down) from confirmed swings.
- Recent break-of-structure event in direction (`BOS_UP`/`BOS_DOWN`) within recent window (<= 6 bars since event) after confirmation; continuation on trigger.
- Stop: last structural swing extreme or ATR-based fallback, on valid side.

### 5. `trend-reversal-momentum` (v1)
- Confirmed change-of-character (`CHOCH_UP`/`CHOCH_DOWN`) in recent window.
- Momentum confirmation: RSI(14) crosses 50 in reversal direction (`prior <= 50 < now` for long, `prior >= 50 > now` for short) OR MACD histogram aligned (>0 long, <0 short) on completed bars.
- HTF exhaustion: HTF not already strongly in new direction and HTF RSI indicates exhaustion (`<=48` for long reversal candidate, `>=52` for short), evaluated only on HTF candles closed by trigger time.
- Stop: structural swing extreme or ATR-based fallback.

### 6. `volatility-expansion-breakout` (v1)
- HTF trend aligned.
- ATR expansion: current ATR / average of prior ATRs >= `volatilityExpansion`.
- Bollinger(`bollingerPeriod`,`bollingerMultiplier`) width expansion vs prior width >= 5%.
- Relative volume (`volumeLookback`) >= `minRelativeVolume` (real volume when available, else range proxy consistently).
- Close breaks Bollinger band and prior `rangeLookback` range extreme in trend direction.
- Stop: trigger extreme or `close ± atr*stopAtrMultiple`.

## Known divergence areas to resolve
- S/R detection/clustering/tolerance and level selection.
- Market structure swing confirmation, trend classification, BOS/CHOCH event timing and continuation window.
- Reversal momentum (RSI+MACD), HTF RSI alignment/no-lookahead and exhaustion criteria.
- Volatility expansion inputs (ATR history window, relative volume definition) and breakout confirmation.
- Indicator implementations (EMA/RSI/MACD/Bollinger/ATR/volume ratio) must be numerically consistent within tolerance.

## Parity acceptance
Per strategy, on identical deterministic fixtures: same trigger eligibility, direction, entry, stop, T1/T2, RR (within tolerance), and no lookahead. Unresolved material difference => `BLOCKED` for production readiness.
