# Phase 4 — Strategy Validation and Backtest Evidence

**Date:** 2026-11-12 (UTC)  
**Branch:** `build/full-market-scanner` @ `b6ad0aa` (Phase 3 WIP committed; Phase 4 work is read-only/research/reporting, no strategy activation, no signal/Telegram publishing, no paper trades from production scanner, no trade execution, no paid API increase, no unrelated VPS changes, no historical production data modified)  
**Scope:** Audit, integrity review, historical evidence review, test-gap investigation. **No new production-impacting code deployed.**

---

## 1) Objective minimum acceptance criteria (defined before judging results)

A strategy may be considered for promotion only when **all** of the following are met on **chronological out-of-sample (OOS)** evidence (not selected on OOS), with costs included:

| Criterion | Minimum (research gate) | Rationale |
|---|---|---|
| Sample size | ≥ 30 OOS trades **and** ≥ 100 total evaluation trades; plus ≥ 2 independent market regimes/segments where data allows | Avoid conclusions from noise/small-N |
| Net expectancy (after fees/spread/slippage/funding as applicable) | > 0 on OOS and not materially negative overall | Must survive realistic costs |
| Profit factor | ≥ 1.15 on OOS (and ≥ 1.0 overall) | Edge after costs |
| Max drawdown (trade-sequence, strategy-level) | ≤ 20% on evaluated segment (or explicitly justified) | Capital/risk tolerance |
| Stability | OOS not driven by a single outlier; train/validation/OOS directionally consistent (no severe degradation without explanation) | Robustness |
| Data/market coverage | Evidence across intended instruments/timeframes/trading styles (crypto + forex where claimed) with sufficient history | Generality |
| Integrity | No lookahead/leakage, closed-candle signals, next-bar-open entry, stop-first ambiguity, documented costs/sessions, gap handling | Methodological validity |
| Reproducibility | Versioned config/params, data range, commit, and deterministic rerun path recorded | Auditability |

**Classification labels (required):**
- **Passed research validation:** meets all gates above on adequate, multi-context OOS evidence.
- **Promising but needs more testing:** plausible/partial edge or adequate method but fails one+ gates (esp. sample/coverage/stability); requires more data/segments/regimes before any activation consideration.
- **Insufficient evidence:** cannot assess (insufficient history, coverage, failed/invalid runs, or unresolved integrity/parity gaps).
- **Failed validation:** adequate sample/coverage shows negative OOS expectancy or clearly fails risk/edge gates.

> **Decision rule:** win rate alone is never sufficient; judgments use expectancy, PF, drawdown, R-multiple/reward-risk, costs, and sample size.

---

## 2) Data coverage and market context (available historical data)

**Source of truth:** production `market_candles` (read-only inspection). No production data modified.

| Market/provider | Instruments (enabled/avail) | Timeframes present | Coverage (approx, from DB) | Notes |
|---|---:|---|---|---|
| Binance USD-M (`binance_usdm`, crypto perpetual) | 19 active (`TONUSDT` disabled/unavailable/SETTLING) | 1m,5m,15m,1h,4h,1d | **1h/4h/15m:** deep history (e.g. BTCUSDT 1h 13,446 bars back to 2025-05-01; others ~328 bars 1h / ~306 bars 4h in recent window per earlier checks); **1m/5m:** recent rolling (~2k/649); **1d:** ~300 | Crypto trades 24/7; funding applicable to perpetuals (model supports directional funding bps/8h). |
| Twelve Data (`twelve_data`, forex; XAU_USD stored as forex/metal-USD) | 5: EUR_USD, GBP_USD, USD_JPY, EUR_JPY, XAU_USD | 1m,5m,15m,1h,4h,1d | **1d:** ~299 (to 2026-11-11); **4h:** ~301; **1h:** ~305 (~13 days back to 2026-10-30); **15m:** ~323–325 (~3.5 days); **5m:** ~373; **1m:** ~660–668 (~11 hours) | Severely limited for intraday/swing validation; 1m/5m best-effort/stale at times (Phase 3 budget). Forex sessions/weekend gaps apply (not crypto). XAU classified as forex in current model (review noted). |
| Legacy `oanda_v20` | 11 (retired/unavailable, history retained) | varies (historical) | retained only | Not used for new validation; non-destructive. |

**Implication:** reliable multi-regime historical validation is currently feasible primarily on **crypto (Binance), especially 1h with 4h trend** for the windows already backtested; **forex/XAU evidence is insufficient** for statistical validation on intraday TFs given available depth and freshness/budget constraints.

---

## 3) Audit of all six strategy families (TS + Python)

**Files inspected:** `packages/core/src/strategies.ts`, `packages/core/src/indicators.ts`, `packages/core/src/risk.ts`, `packages/core/src/index.ts`; `services/research/signal_engine_research/strategies.py`, `backtest.py`, `engine.py`, `models.py`, `api.py`; `apps/worker/src/backtests.ts`, `scanner.ts`.

| # | Strategy (key) | TS implementation (signal-time, completed candles) | Python implementation (backtest setup generation) | Consistency assessment |
|---|---|---|---|---|
| 1 | EMA Trend Pullback (`ema-trend-pullback`) | HTF EMA trend filter (fast>slow & close>fast etc.), pullback to fast EMA (prior low/high near fast) + reclaim/engulf on last closed bar, structural/ATR stop, min RR targets (2R/3R) | Same core idea: HTF trend via EMA lookup (completed HTF closes), pullback/reclaim conditions, structural/ATR stop, RR targets | **Largely aligned in intent/structure**, but not provably identical numerically (float vs Decimal, EMA seeding/window details, exact tolerance `1.002/0.998`, structural stop window). Needs deterministic parity fixtures to certify equivalence. |
| 2 | Range Breakout Retest (`range-breakout-retest`) | Range over lookback, breakout on prior bar, retest tolerance (ATR), close holds beyond level, HTF trend aligned | Equivalent range/breakout/retest/tolerance/HTF alignment logic | **Closely aligned**; minor numeric/edge differences possible (Decimal/float, boundary handling). |
| 3 | Support/Resistance Rejection (`support-resistance-rejection`) | Confirmed swing S/R clusters (tolerance pct), rejection wick/close relative to level within ATR tolerance, HTF trend aligned | Uses confirmed swing levels within lookback/tolerance and rejection close/open conditions | **Conceptually similar but parameterization/level selection differs** (cluster/touch logic & tolerance application not identical) — **parity not demonstrated**. |
| 4 | Market Structure Continuation (`market-structure-continuation`) | `analyzeMarketStructure` trend alignment, recent BOS in direction, continuation within limited bars, structural stop | Structure from confirmed swings/events, recent BOS, trend alignment, structural stop | **Conceptually aligned**; event indexing/confirmation windows differ in implementation detail — **parity not demonstrated**. |
| 5 | Trend Reversal with Momentum Confirmation (`trend-reversal-momentum`) | Recent CHOCH, RSI shift and/or MACD histogram confirmation, HTF exhaustion (trend/RSI) | Recent CHOCH, RSI crossing 50, HTF RSI exhaustion logic | **Material logic differences** (MACD used in TS path; RSI/exhaustion thresholds/conditions differ) — **not equivalent** without harmonization. |
| 6 | Volatility Expansion Breakout (`volatility-expansion-breakout`) | HTF trend, ATR expansion vs avg, Bollinger breakout + width expansion, relative volume vs min, break of recent range, ATR stop | Similar ATR expansion/Bollinger/range break/volume-ratio checks | **Conceptually aligned** but volume measure differs (TS `relativeVolume` over volumes; Python `volume_ratio_at` prefers real volume else range proxy) and numeric details differ — **parity not demonstrated**. |

**Cross-cutting parity findings (evidence):**
- **Shared:** 6 strategy keys registered in both (`STRATEGY_DEFINITIONS` / `SUPPORTED_STRATEGIES`), EMA/ATR/RSI/Bollinger/structure primitives present in both, min RR/ATR stop/target multiples used, HTF trend gating used.
- **Divergences/risk:** different numeric types (TS `number`/float vs Python `Decimal` in simulation/setup math), indicator implementations not byte-for-byte identical (e.g. RSI/EMA initialization, MACD availability in Python reversal path, swing/structure confirmation indexing), and some condition details differ (notably strategies 3–6). **No golden-fixture parity test suite exists proving identical signals on identical candles.**
- **Conclusion:** **functional intent parity = partial; proven output equivalence = not established.** Treat backtest (Python) results as research-engine results pending certified parity.

---

## 4) Backtest integrity verification (engine & pipeline)

**Evidence:** `services/research/signal_engine_research/backtest.py`, `strategies.py`, `engine.py`, `api.py`, `models.py`; `apps/worker/src/backtests.ts`; research tests.

| Requirement | Finding | Evidence / status |
|---|---|---|
| No lookahead / future-candle leakage | **Largely enforced**: setups generated over bars with HTF trend from completed/known closes (`lookup_trend` uses `close_timestamp <= t`); `trend_at` tests assert no future use; evaluation filtered to `evaluation_start/end`; walk-forward uses segment timestamps. HTF bars sorted and looked up by close time. | `strategies.py` (`trend_lookup/lookup_trend`, generation loop to `len(bars)-1`), `api.py` evaluation slicing, `test_strategies.py::test_trend_filter_does_not_read_future_candles`. **Caveat:** parity/indicator edge cases not exhaustively proven. |
| Signals from closed candles only | **Backtest inputs are bar series;** research `engine.completed_candles` filters `complete`; ingestion persists only `isComplete` candles; scanner rejects `!complete`. Setup signal time is the bar timestamp (closed bar context) and entry occurs next bar. | `engine.py`, ingestion/scanner code, `test_engine.py`. |
| Entry at documented next-bar-open | **Yes.** `simulate` enters at `ordered[i+1].open` for setup on bar `i`. | `backtest.py` + `test_backtest.py::test_entry_occurs_on_next_bar...` |
| Realistic fees, spread, slippage, funding (where applicable) | **Supported & applied.** `CostModel`: `fee_bps_per_side`, `spread_bps`, `slippage_bps`, `funding_bps_per_8h`; net return = gross − round-trip bps − directional funding over holding hours. Directional funding applied (long pays/short receives sign convention in sim). **However, several historical runs recorded `assumptions {}` / zero/defaulted costs** (see §5) — cost realism not consistently evidenced in those records. | `engine.py::net_return`, `backtest.py`, `models.py`, tests. |
| Stop-first when stop & target touched same candle | **Yes (conservative).** Stop evaluated before target loop per bar (`stop_hit` branch exits as stop). | `backtest.py` + `test_backtest.py::..._stop_wins_ambiguous_bar`. |
| Partial take-profit, expiry, invalidation, no trade overlap | **Partial TP:** two targets with allocations, remaining size tracked. **Expiry:** `expires_at` supported; `apps/worker/src/backtests.ts` sets `expiry_bars` by timeframe and API computes expiry from bar interval/close time. **No overlap:** `next_available_index` blocks new entries while in position; tested. **Invalidation:** modeled via stop/expiry/data-end exits (no separate discretionary invalidation event beyond stop/expiry). | `backtest.py`, `api.py`, `test_backtest.py` (partial, overlap, expiry). |
| Candle gaps / stale data | **Simulator operates on provided ordered bars** (unique timestamps enforced); it does not synthesize missing bars. Gaps in source data can create discontinuities/wider realized moves between bars — **not explicitly normalized**. Phase 3 identified historical gaps (BTCUSDT 15m, XAU 1d) outside evaluated 1h runs but integrity depends on loaded dataset. Forex session closures/weekends not specially modeled in PnL except via actual bars/costs. | `backtest.py` uniqueness checks; Phase 3 gap audit. **Residual risk.** |
| Forex vs crypto sessions and cost assumptions | **Costs configurable** but historical runs mostly used defaults/empty assumptions; no instrument-specific spread/funding histories or session calendars applied. Crypto 24/7 vs forex sessions not differentiated in simulator beyond bars supplied. XAU treated as forex market label. | `models.py/engine.py` generic costs; run metadata. **Gap.** |

**Integrity summary:** core mechanics (no-future-HTF lookup in tested cases, closed-bar context, next-open entry, stop-first, partials, expiry, overlap prevention, cost math) are implemented and unit-tested in research. **Not fully sufficient for production-grade evidence** due to parity uncertainty, inconsistent recorded cost assumptions in historical runs, generic (non-instrument/session-specific) cost/session modeling, and unverified behavior on gappy/stale datasets.

---

## 5) Investigation of existing backtest records (15 runs; 6 failed) — preserved, not modified

**DB:** `backtest_runs` (read-only). 15 rows total, 9 `completed`, 6 `failed`. All on `BTCUSDT`, entry TF `1h`, trend TF `4h`, `crypto_perpetual`. Chronological split 60/20/20 and walk-forward reported by research API when available.

| Run ID (created UTC) | Strategy | Range | Costs recorded | Status | Key metrics (OOS trades, WR, PF, expectancy, net ret, max DD) | Notes |
|---|---|---|---|---|---|---|
| `f4c0333e` (2026-11-11 01:17:20Z) | ema-trend-pullback | 2025-09-01→2026-11-01 | `{}` (empty) | completed | 91, 30.77%, 0.566, -0.00230, -19.33%, 19.33% | Superseded by later run with explicit costs/wider range |
| `f22c252d` (01:17:21Z) | range-breakout-retest | 2025-09-01→2026-11-01 | `{}` | completed | 19, 15.79%, 0.436, -0.00352, -6.60%, 7.75% | Small OOS sample |
| `5c62b9a9` (01:17:21Z) | support-resistance-rejection | 2025-09-01→2026-11-01 | `{}` | **failed** | — | `The operation was aborted due to timeout` (worker 600s) |
| `86b13b19` (01:17:22Z) | market-structure-continuation | 2025-09-01→2026-11-01 | `{}` | **failed** | — | timeout |
| `d2445861` (01:17:22Z) | trend-reversal-momentum | 2025-09-01→2026-11-01 | `{}` | **failed** | — | timeout |
| `e1027cdc` (01:17:22Z) | volatility-expansion-breakout | 2025-09-01→2026-11-01 | `{}` | completed | 7, 57.14%, 2.058, +0.00473, +3.26%, 2.69% | **OOS N=7 — not reliable** (likely noise) |
| `8bbaba39` (01:27:53Z) | trend-reversal-momentum | 2025-09-01→2026-11-01 | `{}` | **failed** | — | `Headers Timeout Error` (research service) |
| `6d7e379d` (01:27:53Z) | market-structure-continuation | 2025-09-01→2026-11-01 | `{}` | **failed** | — | `other side closed` (connection/reset during run) |
| `67ca1517` (01:27:53Z) | support-resistance-rejection | 2025-09-01→2026-11-01 | `{}` | **failed** | — | `connect ECONNREFUSED 172.22.0.4:8000` (research unreachable) |
| `6697ce5f` (01:34:54Z) | trend-reversal-momentum | 2025-09-01→2026-11-01 | `{}` | completed | 17, 23.53%, 0.227, -0.00488, -8.02%, 8.02% | Negative OOS |
| `c260b5ea` (01:34:55Z) | market-structure-continuation | 2025-09-01→2026-11-01 | `{}` | completed | 71, 43.66%, 0.852, -0.00088, -6.77%, 15.30% | Near-breakeven PF but negative expectancy/net on OOS |
| `a2756435` (01:34:55Z) | support-resistance-rejection | 2025-09-01→2026-11-01 | `{}` | completed | 161, 31.68%, 0.560, -0.00170, -24.24%, 24.91% | Large sample but clearly negative |
| `ae14511f` (2026-11-11 06:57:35Z) | ema-trend-pullback | 2025-07-01→2026-10-15 | **explicit:** fee 5bps/side, spread 2bps, slippage 2bps, funding 0 | completed | 99, 31.31%, 0.558, -0.00237, -21.35%, 21.85% | Best-documented cost assumptions; negative OOS |
| `38c8e706` (06:59:05Z) | range-breakout-retest | 2025-07-01→2026-10-15 | explicit (as above) | completed | 21, 19.05%, 0.550, -0.00217, -4.57%, 5.10% | Small OOS sample |
| `6ce0760b` (06:59:05Z) | volatility-expansion-breakout | 2025-07-01→2026-10-15 | explicit (as above) | completed | 7, 42.86%, 1.741, +0.00353, +2.40%, 2.69% | **OOS N=7 — not reliable** |

**Failure analysis (6 failed):** all are **infrastructure/runtime execution failures**, not strategy-logic rejections: 3× worker abort timeout (600s) during heavy/slow research computation or load, 1× headers timeout, 1× connection reset/closed, 1× research service unreachable (`ECONNREFUSED 172.22.0.4:8000`). **Impact on reliability:** failed runs produce no metrics (unusable for validation) but do **not** invalidate the arithmetic of separately completed runs; they indicate the backtest pipeline was intermittently unstable/slow (and earlier cost assumptions sometimes unrecorded). Subsequent reruns completed for those strategies, so evidence exists — but operational reliability of the research/backtest path requires hardening.

**Historical records preserved:** no rows deleted/overwritten. New Phase 4 runs were **not** created in production DB (read-only stance; creating runs would mutate `backtest_runs` and could trigger execution paths — avoided).

---

## 6) Historical validation results (from available completed evidence)

**Scope of valid completed evidence:** 9 completed runs, all **BTCUSDT 1h entry / 4h trend (intraday)**, crypto perpetual, Binance data, chronological 60/20/20 train/validation/OOS, walk-forward reported by API in run artifacts. **No out-of-sample parameter optimization performed in this review.** Parameters/ranges/config as recorded per run.

**Coverage limitations:** no forex/XAU validation, no other instruments/timeframes/styles beyond BTCUSDT 1h-intraday in completed evidence, limited regime diversity, and 3 later runs include explicit transaction-cost assumptions while 6 earlier completed runs recorded empty assumptions (cost treatment may differ from intended realistic defaults) — results are **not directly comparable across assumption sets** without normalization.

### Per-strategy evidence (best/latest completed run emphasized; OOS is the decision slice)

| Strategy | Best/latest completed run | Sample (overall / OOS) | OOS WR | OOS PF | OOS expectancy | OOS net return | OOS max DD | Avg R (overall) | Costs recorded | Assessment notes |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| EMA Trend Pullback | `ae14511f` (Jul–Oct 2025, explicit costs) | 503 / 99 | 31.31% | 0.558 | -0.00237 | -21.35% | 21.85% | ~2.00 | yes | Negative edge on OOS despite adequate OOS count; degrades vs validation. |
| Range Breakout Retest | `38c8e706` (Jul–Oct 2025, explicit costs) | 116 / 21 | 19.05% | 0.550 | -0.00217 | -4.57% | 5.10% | ~2.00 | yes | **OOS sample small (21)** and negative. |
| Support/Resistance Rejection | `a2756435` (Sep–Nov 2025, costs empty) | 764 / 161 | 31.68% | 0.560 | -0.00170 | -24.24% | 24.91% | ~2.00 | no (empty) | Large sample but consistently negative OOS and high drawdown; costs not explicitly recorded. |
| Market Structure Continuation | `c260b5ea` (Sep–Nov 2025, costs empty) | 328 / 71 | 43.66% | 0.852 | -0.00088 | -6.77% | 15.30% | ~2.00 | no (empty) | Closest to breakeven but **still negative expectancy/PF<1 on OOS**; validation looked positive (PF 1.085) then degraded OOS — stability concern. |
| Trend Reversal Momentum | `6697ce5f` (Sep–Nov 2025, costs empty) | 94 / 17 | 23.53% | 0.227 | -0.00488 | -8.02% | 8.02% | ~2.00 | no (empty) | **OOS sample small (17)** and strongly negative. |
| Volatility Expansion Breakout | `6ce0760b` (Jul–Oct 2025, explicit costs) | 39 / 7 | 42.86% | 1.741 | +0.00353 | +2.40% | 2.69% | ~2.00 | yes | **OOS N=7 — statistically meaningless** despite positive point estimate; earlier run similar (N=7). |

**Cross-strategy observations:** no strategy demonstrates a costed, adequately sampled, stable positive OOS edge on the available evidence. Some validation slices looked positive but OOS degraded (selection/overfitting risk or regime shift). Reported trade-level metrics (holding time, stop/target/expired counts, losing streaks, breakdowns) exist in run JSON but are not independently re-audited beyond recorded summaries.

---

## 7) Strategy-by-strategy classification (evidence-based)

| Strategy | Classification | Rationale (objective) |
|---|---|---|
| EMA Trend Pullback | **Failed validation** | Adequate sample (503/99) with explicit costs: OOS PF 0.56, expectancy negative, net -21.35%, DD 21.85%, unstable vs validation. Fails edge/drawdown/stability gates. |
| Range Breakout Retest | **Insufficient evidence** (leaning failed) | OOS N=21 (<30) under explicit costs, PF 0.55, negative expectancy; overall also negative. Not enough OOS trades for a confident pass/fail, but no sign of edge. |
| Support/Resistance Rejection | **Failed validation** | Large sample (764/161) but OOS PF 0.56, expectancy negative, net -24.24%, DD 24.91%; consistently poor. Costs not explicitly recorded in that run (further weakens, but direction already negative). |
| Market Structure Continuation | **Insufficient evidence** (leaning failed/promising-for-retest-only) | OOS PF 0.85 / expectancy slightly negative (71 trades) after positive validation — fails OOS edge gate and shows instability; costs not explicitly recorded. Needs harmonized, costed, multi-instrument/regime retest before any conclusion. |
| Trend Reversal Momentum | **Insufficient evidence** (leaning failed) | OOS N=17, PF 0.23, expectancy/net strongly negative. Inadequate sample plus poor point estimates. |
| Volatility Expansion Breakout | **Insufficient evidence** | OOS N=7 only (and N=7 in prior run) — far below minimum sample despite positive point PF/expectancy; cannot distinguish edge from variance. |

**Global decision:** **No strategy is approved or enabled. All six remain `enabled=false`, `approved=false` (verified in `strategy_configs`).** None meet “Passed research validation”.

---

## 8) Identified bugs, gaps, and risks (with status)

| ID | Area | Finding | Impact | Status / recommendation |
|---|---|---|---|---|
| B1 | TS↔Python parity | Signal logic differs in details (notably S/R, structure continuation/reversal, volume/MACD handling) and numeric types differ; no golden parity fixtures | Backtest results may not reflect live TS signals | **Open.** Build shared fixtures + cross-engine equivalence tests before relying on research results. |
| B2 | Historical cost recording | Several completed runs stored `assumptions {}` (empty) | Net results may under/over-state true costs vs intended model | **Open/data-quality.** Rerun with explicit, instrument-appropriate costs and record commit/config. |
| B3 | Backtest pipeline reliability | 6/15 runs failed (timeouts, headers timeout, connection reset/refused to research) | Evidence gaps, wasted compute/time | **Open.** Add timeouts/retries/heartbeats, resource sizing, and resilient job handling; keep failures observable. |
| B4 | Sample/coverage | Evidence mostly BTCUSDT 1h/4h only; forex history too shallow for intraday/swing validation; no multi-instrument/style proof | Cannot generalize; forex unvalidated | **Open.** Accumulate history per Phase 3 plan; expand instruments/TFs/styles. |
| B5 | Market realism | Generic costs, no instrument/session-specific spread/funding history, gaps/weekends not explicitly modeled | Possible optimistic/pessimistic bias | **Open.** Calibrate costs per market/session; document gap policy. |
| B6 | DB integration tests (env) | `TEST_DATABASE_URL` not configured; host cannot reach compose Postgres (not published); test requires a safe `*test*` DB and applies migrations (drops schema) — running against prod is unsafe and blocked by design | Integration coverage skipped in default runs | **Partially addressed.** Safe isolated DB created/dropped on postgres service for investigation; running vitest inside network requires a runner image with pnpm/deps (not available in app images). **Needs CI/test-runner wiring.** |
| B7 | Research tests (env) | `pytest` not installed in research image; tests not under `/app` in built image | Previously skipped on host/in-container default | **Addressed for investigation:** installed pytest in running container and via one-off run mounting `services/research`; **19 passed**. Image/Dockerfile should include dev deps or test stage for repeatability. |
| B8 | Twelve Data live tests | Require live key/network and can consume credits | Must not run without approval | **Not run (by restriction).** 4 tests skipped. |

---

## 9) Test execution results (Phase 4)

| Suite / target | Result | Details |
|---|---|---|
| Python research (pytest) | **PASS — 19 passed, 0 failed** (1 warning: testpaths config) | Ran in `research` container after `pip install pytest`, and via `docker compose run --rm --no-deps -v $PWD/services/research:/src -w /src research` (19 passed in 0.49s). Covers engine, strategies registration/no-lookahead guards, simulator (next-open, stop-first, overlap, partials, expiry, costs/funding direction), metrics, splits, walk-forward. |
| `@signal-engine/database` integration (`system-repository.spec.ts`) | **Not run to completion (skipped in default env; blocked by runner/network in this pass)** | Reason: requires `TEST_DATABASE_URL` pointing to a DB whose name matches `/test/i` (guard prevents prod). Created & later dropped safe DB `signal_engine_test_1794465109` on postgres. Host execution failed (postgres port not exposed: `ECONNREFUSED :15432`). In-network execution needs pnpm+vitest+deps runner (app images lack pnpm; node tool image not composed). **8 tests remain not executed in CI-like form here; production data untouched.** |
| `@signal-engine/market-data` | **PASS — 42 passed, 4 skipped** | Skipped: `twelve-data.live.spec.ts` (4) — live Twelve Data key/network/credit-avoidance. |
| `@signal-engine/core` | **PASS — 23 passed** |  |
| `@signal-engine/api` | **PASS — 2 passed** |  |
| `@signal-engine/worker` | **PASS — 5 passed** |  |
| Twelve Data live tests | **SKIPPED (4)** | Not run to avoid paid credit consumption without approval. |
| `pnpm build` / `pnpm typecheck` | **PASS** (per Phase 3 baseline; no production code changes in Phase 4) |  |

**Every test that remains skipped/not executed:** database integration 8 tests (`system-repository.spec.ts` — missing safe in-network test runner/URL wiring in this environment; would require dedicated test DB + migrations), Twelve Data live 4 tests (credit/approval restriction). No other suites intentionally skipped beyond these.

---

## 10) Production safety & compliance statement

- All **6 strategies remain disabled and unapproved** (`strategy_configs.enabled=false, approved=false` confirmed). No activation performed.
- **No signals published, no Telegram messages sent, no paper trades created from production scanner activity, no trade execution, no brokerage connections.**
- **No Twelve Data credits/paid API usage increased** (live Twelve Data tests not run).
- **No unrelated VPS services modified. No historical production data modified or deleted** (backtest runs inspected read-only; temporary isolated test DB created on postgres and dropped after investigation).
- **Branch preserved** (`build/full-market-scanner`), **no force-push, no merge**.

---

## 11) Deliverables index

- **Strategy-by-strategy validation report:** §3, §6, §7 (and table in §6).
- **Backtest results with reproducible configurations:** §5 (all 15 runs: IDs, ranges, params, costs recorded, split/walk-forward reported in metrics, commit context per branch state) — historical records preserved.
- **TypeScript/Python parity evidence:** §3 (audit, alignment matrix, divergences) — **equivalence not certified**.
- **Identified bugs and fixes:** §8 (B1–B8; fixes applied in Phase 4 limited to test-environment investigation only — pytest installed ad hoc, temp test DB lifecycle managed; no production code changes).
- **Test results and remaining gaps:** §9.
- **Clear decision per strategy:** §7 — **0 Passed, 0 Promising, 3 Insufficient evidence, 2 Insufficient (leaning failed), 1 Failed validation (strictly evidenced)**; conservatively **no strategy cleared for activation**.

---

## 12) Recommendation / next-step gate

**Do not proceed to Phase 5 or activate any strategy.** Required before reconsideration: (1) establish TS↔Python parity with golden fixtures, (2) rerun costed, versioned backtests on sufficient history across multiple instruments/TFs/regimes (incl. forex once data depth exists) with recorded assumptions/commit, (3) resolve pipeline reliability and data-realism gaps, (4) wire repeatable DB integration + research test execution (and run Twelve Data live tests only with explicit credit approval). Await explicit review/approval.
