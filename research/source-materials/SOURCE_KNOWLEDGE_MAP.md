# Initial Source Knowledge Map

This is a preliminary map based on the uploaded source contents and table-of-contents material. It is not a replacement for full source inspection or page-level citation.

## Wade FX Setups
The document is organized around expansion/retracement, Fibonacci retracement, BMS, range high/low, failure swing/SMS, liquidity, order blocks, sessions and named setups. Extracted text describes expansion as an impulse move and retracement as its correction. It describes 50% and OTE levels 0.62, 0.705 and 0.79 as possible retracement areas. BMS is described as a close above/below a swing high/low, followed by waiting for a retracement and generally trading in the higher-timeframe BMS direction. Contents include BSL/SSL, stop hunts, high-impact news, bullish/bearish order blocks, Asian/London/New York sessions, AMD, Turtle Soup, SH+BMS+RTO and SMS+BMS+RTO.

Audit questions: causal swing confirmation, wick-vs-close semantics, objective OTE leg selection, liquidity sweep/reclaim definition, order-block boundaries/mitigation, session timezone/DST and news-event treatment.

## The Candlestick Trading Bible
The contents cover candle anatomy; engulfing, doji variants, morning/evening star, hammer, shooting star, harami and tweezers; market structure, trend/range, support/resistance, trendlines and top-down timeframes; pin bars, engulfing bars, inside bars and inside-bar false breakouts; and money management. The source treats candle formations in technical context. Keep variants separate and extract exact definitions and examples rather than assuming generic textbook definitions.

Audit questions: numerical body/wick criteria, closed-bar confirmation, context requirements, false-breakout/reclaim definition, overlapping-pattern deduplication.

## EmperorBTC Trading Manual
Inspect the entire manual. The user's separately supplied strategy image described Pivot Points, VWAP and Stoch RSI, including bullish Stoch RSI crossover, upward VWAP break and pivot support/resistance context, with volume/candlestick confirmation. This image description is a lead, not a complete formal specification. Find the matching manual pages and verify the exact rule sequence, indicator parameters, candle-close behavior and market/session assumptions. The manual's stop-loss section describes stop placement as technical invalidation, determined before entry, with each setup having its own invalidation.

Audit questions: VWAP anchor/reset, pivot formula variant, Stoch RSI parameters, trigger conjunction/order, volume compatibility across crypto/FX/metals.

## EmperorBTC Stop Loss Masterclass
Extracted opening text describes stop placement where structure indicates the anticipated thesis is invalid, and uses stop distance to calculate position size. An example uses 1% account risk and 4% stop distance to calculate notional exposure. This is educational arithmetic, not a recommendation to use leverage. Keep Signal Engine read-only.

Audit questions: risk sizing with tick/pip value, contract specs, fees/slippage, gap-through-stop, invalid distances and whether breakeven movement is independently tested.

## TradingWithRayner Trend Reversal Guide
The contents cover reversal mistakes, four market stages (accumulation, advancing, distribution, declining), higher-timeframe daily support, lower-timeframe 1-hour accumulation, support/resistance, breakout, pullback and stop loss. The text warns against catching a falling knife without structural invalidation and warns against entering on the first pullback. Treat stage labels as subjective until made causal and reproducible.

Audit questions: objective accumulation/distribution criteria, confirmation of base/structure transition, separate breakout vs pullback variants, no-lookahead stage labels.

## Smart Money Concepts in the Forex Market
The contents cover Forex mechanics, technical patterns, fundamentals, market cycle, BOS, imbalances, supply/demand zones and refinement, MTF analysis, RBD/RBR/DBR/DBD, supply/demand trading, lower-timeframe confirmation, capital and risk management. The text discusses supply/demand and economic/interest-rate factors as drivers of FX.

Audit questions: objective zone origin/base/impulse, proximal/distal boundaries, freshness/mitigation, imbalance definition, separate base-pattern labels, MTF synchronization and FX fundamental/event separation.

## Conflicts to preserve
- Wade's BMS/SMS vs SMC BOS vs engine BOS/CHOCH.
- Wick liquidity sweep vs confirmed candle close.
- Order block vs supply/demand zone vs imbalance/FVG.
- Rayner staged reversal vs structure-break reversal triggers.
- Candle-pattern confirmation vs VWAP/pivot/Stoch RSI confirmation.
- Source-specific structural invalidation vs generic fixed-distance stops.
- FX-specific SMC claims vs crypto-oriented EmperorBTC methods.

The engine already reports services for swings, BOS/CHOCH, liquidity, zones, order blocks, FVG, candlesticks, VWAP, pivots, Stoch RSI, regimes, sessions and MTF. Their existence does not prove source fidelity. Audit code, tests and causal behavior before marking anything implemented.
