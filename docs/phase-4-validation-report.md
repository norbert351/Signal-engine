# Phase 4 — Signal Engine Validation, Backtesting, Optimization & Strategy Readiness

**Project:** Signal Engine (`build/full-market-scanner`)  
**Date:** 2026-11-12 (remediation cycle, in-progress)  
**Mode:** Read-only cycle + remediation changes on feature branch; **no live trading, no broker/wallet connections, no order execution, no funds moved, no paid API credits used, no main Telegram delivery enabled, no production strategy activation/approval**.

**Baseline preserved:** `docs/phase-4-validation-report.v1-baseline.md` (unchanged). This document supersedes it as the current working report and records P1–P5 remediation/revalidation evidence available so far.

---

## 1. Executive summary

| Area | Status | Notes |
|---|---|---|
| **P1 — TS/Python strategy parity** | **BLOCKED (5/6)** | Deterministic parity harness + fixtures + rule spec created (`docs/strategy-specs/strategy-rules.md`, `tests/parity/*`, `docs/parity-matrix.json`). **Only `ema-trend-pullback` parity-OK** on fixtures; `range-breakout-retest`, `support-resistance-rejection`, `market-structure-continuation`, `trend-reversal-momentum`, `volatility-expansion-breakout` have **material divergences** (missing signals / differing stop-target-event logic). Unresolved material differences block production readiness per strategy. |
| **P2 — Backtest realism / cost integrity** | **PARTIAL (remediated, verification incomplete)** | Research requires explicit cost fields and returns versioned/explicit `assumptions` with gross+net metrics/breakdowns/walk-forward; API enforces explicit non-negative cost payload; worker validates costs, classifies failures, bounded transient retry, persists classified failures and legacy/unverified labeling; DB finish path tightened. **Not complete:** exhaustive path audit, full missing/invalid/zero-negative/malformed/changed-cost + retry-immutability tests, end-to-end persisted-assumptions retrieval proof for all flows, historical empty-cost runs preserved/labeled in DB by migration policy (no destructive migration performed). |
| **P3 — Backtest pipeline reliability** | **PARTIAL (remediated, reproduction/tests incomplete)** | Bounded retry (transient, max 2 attempts) and failure classification added in worker; DB claim resets stale running jobs and clears `completedAt`; finish constrained to running jobs and can persist assumptions/progress markers. **Not complete:** controlled reproduction of historical 600s/headers-timeout/reset/ECONNREFUSED, worker-restart/dedup/partial-completion retry tests, full progress tracking, stale-worker-overwrite guarantees under all races, resource-bounding evidence, structured secret-safe logs audit. |
| **P4 — Data sufficiency** | **ACCEPTED (evidence-limited)** | `docs/p4-data-sufficiency.json` and `docs/p4-data-sufficiency-matrix.md` generated (150 series). **Only `BTCUSDT:1h` qualifies as primary sufficient evidence** (with scope limits). Most others shallow/limited; forex intraday very shallow and 1m/5m/15m budget-limited/stale; known gaps `binance_usdm:BTCUSDT 15m` and `twelve_data:XAU_USD 1d` unresolved. No broad multi-instrument/forex validation claim. |
| **P5 — Test workflows / environment** | **ACCEPTED** | DB integration workflow `scripts/test-db-integration.sh` (isolated temp DB + cleanup + prod-URL guard): **8 passed** on temp DB, guard skips on non-test/prod URL. Research Dockerfile includes tests/dev deps, clean `--no-cache` build `signal-engine-research:latest` (`44cb33cac2eb`): pytest **19 passed**. Core tests **23 passed**. |
| **Strategy production readiness** | **NO-GO for all** | Original acceptance criteria unchanged and unmet/unproven for production promotion. All 6 strategies remain `enabled=false, approved=false`. |

**Revalidation gate:** Not satisfied (P1 not established for 5/6, P2/P3 not fully verified, only BTCUSDT 1h has sufficient data). **No full/compliant strategy revalidation runs executed** in this remediation cycle. No new costed promotion evidence.

---

## 2. Environment & runtime (observed)

- VPS: Ubuntu 6.8.0 x86_64, 4 vCPU, ~7.8 GiB RAM, 4.0 GiB swap (~3.7 GiB used), 96G disk ~62% (high/variable load; non-SE host pressure noted previously).
- Docker 29.8.1 / Compose v5.5.1, Node v22.23.2, pnpm 10.20.0, Python 3.12.3.
- Branch `build/full-market-scanner` (feature), ahead of `origin/build/full-market-scanner`; baseline commit context includes `b6ad0aa`.
- Runtime posture unchanged: services healthy where applicable; `/api/v1/health` ok (`tradingExecution:false`); system previously degraded on forex freshness/budget; Twelve Data credit-aware (800/day); Telegram chat IDs empty; `PG_POOL_MAX=4`; all strategies disabled/unapproved.

---

## 3. P1 — TypeScript/Python parity (BLOCKED)

### Artifacts
- Intended rules spec: `docs/strategy-specs/strategy-rules.md`
- Deterministic harness: `tests/parity/run-ts.mjs`, `tests/parity/run-py.py`, `tests/parity/compare.mjs`, fixtures `tests/parity/fixtures/*.json` (13 fixtures across 6 strategies, valid/invalid/edge cases as initial set)
- Matrix: `docs/parity-matrix.json` (regenerated during remediation)

### Method
- Identical deterministic OHLCV bars and trend context fed to TS `evaluateStrategy` (`packages/core/dist`) and Python `generate_setups` (research runtime via Docker, mounted source/fixtures) at matching trigger evaluation.
- Compared direction, trigger eligibility/time/index alignment, entry, stop, targets, RR with numeric tolerance `1e-8` where comparable; material missing/extra signals or value diffs recorded.

### Results (per strategy)

| Strategy | Fixtures | Comparisons | Matches | Material diffs | Status | Notes |
|---|---:|---:|---:|---:|---|---|
| `ema-trend-pullback` | 4 | 2 | 2 | 0 | **PARITY_OK (fixtures)** | Signals match on current deterministic cases (long/short valid, invalid flat/no-setup). |
| `range-breakout-retest` | 2 | 1 | 0 | 1 | **BLOCKED** | Python signal missing/misaligned vs TS on valid fixture (trigger/index/condition differences in breakout/retest logic). |
| `support-resistance-rejection` | 2 | 1 | 0 | 1 | **BLOCKED** | Python signal missing vs TS; S/R clustering/tolerance/level selection diverge materially from TS `supportResistance` semantics. |
| `market-structure-continuation` | 2 | 15 | 0 | 15 | **BLOCKED** | Widespread stop/target/event-window differences (structural stop selection, BOS timing/window, continuation eligibility). |
| `trend-reversal-momentum` | 2 | 1 | 0 | 1 | **BLOCKED** | Python signal missing vs TS; divergence in CHOCH/RSI/MACD momentum confirmation and HTF exhaustion/no-lookahead handling. |
| `volatility-expansion-breakout` | 2 | 1 | 0 | 1 | **BLOCKED** | Python signal missing vs TS; divergence in ATR history/expansion, Bollinger/width/volume proxy, breakout confirmation. |

### Known divergence areas (unresolved)
- Indicator parity and numeric consistency (EMA/RSI/MACD/Bollinger/ATR/volume ratio, Wilder vs SMA where applicable).
- S/R detection, clustering, tolerance, and level relevance.
- Swing confirmation, structure trend/BOS/CHOCH event timing, continuation/reversal windows.
- HTF RSI/exhaustion and momentum confirmation rules.
- Float/Decimal normalization and edge-case behavior.

**Conclusion:** Production readiness **blocked** for 5/6 strategies. `ema-trend-pullback` shows fixture parity but requires broader fixture/regression coverage and independent rule verification before promotion. No blind-copy alignment performed; intended-rule verification remains required.

---

## 4. P2 — Cost integrity (PARTIAL)

### Implemented changes
- `services/research/signal_engine_research/models.py`, `api.py`: explicit required `CostModel` inputs (no silent defaults), `COST_MODEL_VERSION`/explicit assumptions echoed, gross + net metrics/breakdowns and gross/net walk-forward included in response.
- `apps/api/src/backtests.controller.ts`: rejects missing/invalid/non-finite/negative cost assumptions (`fee_bps_per_side`, `spread_bps`, `slippage_bps`, `funding_bps_per_8h` required).
- `apps/worker/src/backtests.ts`: validates explicit costs before execution, bounded transient retry (max 2), failure classification (`transient_infrastructure`/`data_or_validation`/`research_service_error`/`invalid_request_or_data`), persists failure metadata and legacy/unverified labeling when original assumptions absent; passes/persists effective assumptions.
- `packages/database/src/backtest-repository.ts`: `finishBacktest` constrained to running rows and can persist assumptions; stale running jobs reclaimed to queued.
- Research tests adjusted for explicit costs; pytest **19 passed**.

### Verification performed
- Unit/behavioral coverage via existing suites: engine cost reduction and backtest simulations run with explicit zero/costed models; API/worker/database builds succeeded.
- Manual code-path inspection of modified create/execute/persist paths in API, worker, research service.

### Gaps / not yet verified
- Exhaustive proof that **every** API/worker/admin path rejects bypass attempts (incl. malformed/nested payloads, zero/negative where inappropriate by policy, changed cost configs mid-retry) with automated tests.
- Confirmation that persisted cost-model version and full assumptions are retrievable for each run in all success/failure/legacy cases.
- Guarantee that retries never alter an existing run’s stored assumptions (idempotency/immutability contract not fully tested).
- Historical runs with missing/empty cost data: preserved (no destructive ops) but **not yet systematically relabeled in storage** as legacy/unverified except on new failures/paths; no migration added (none necessary/destructive avoided).

---

## 5. P3 — Pipeline reliability (PARTIAL)

### Implemented changes
- Worker: failure classification and bounded retry for transient request failures (2 attempts, 1s backoff); clearer failure payloads (`failureClassification`, `transient`, `failedAt`, `legacyCostDataUnverified`).
- DB: stale running reclaim (`>15m`) to queued with cleared start/completion markers; finish updates only running jobs (reduces late overwrite risk).

### Historical failures (baseline)
- 6/15 historical runs failed (timeouts, headers timeout, reset, `ECONNREFUSED`, “other side closed”), preserved as failed records.

### Gaps / not yet reproduced or proven
- Controlled reproduction of: 600s worker timeout, research headers timeout, connection reset/remote close, ECONNREFUSED, worker restart during running job, duplicate job delivery, retry after partial completion.
- End-to-end idempotency (no duplicate trades/metrics, no stale-worker overwrite of newer/completed results under races), durable progress tracking, bounded resource protection for long runs, and secret-safe logging guarantees not fully demonstrated with tests.

---

## 6. P4 — Data sufficiency (ACCEPTED, limited)

- Artifacts: `docs/p4-data-sufficiency.json`, `docs/p4-data-sufficiency-matrix.md` (150 series, 25 instruments, 6 TFs).
- **Primary sufficient evidence:** `BTCUSDT:1h` only (scope-limited).
- **Known issues:** `binance_usdm:BTCUSDT 15m` gap (1), `twelve_data:XAU_USD 1d` gap (54); most non-BTC intraday shallow; Twelve Data 1m/5m/15m budget-limited/stale and forex intraday history insufficient for robust validation.
- **Constraint:** usable history must respect gaps, sessions/weekends (forex/XAU), closed-candle-only evaluation, and freshness filters. **No broad multi-instrument/forex validation claimed.**

---

## 7. P5 — Test workflows (ACCEPTED)

| Workflow | Evidence | Result |
|---|---|---|
| DB integration (isolated) | `scripts/test-db-integration.sh`: creates `signal_engine_test_<ts>_<pid>`, runs `packages/database` vitest in `api` container, drops DB on exit; prod/non-test URL guard | **8 passed** (temp DB runs, e.g. `signal_engine_test_1794469283_3849884`); guard verified (skip on non-test DB) |
| Research (Python) | `services/research/Dockerfile` copies `tests`, installs `.[dev]`; `docker compose build --no-cache research` => `44cb33cac2eb`; run via `docker compose run --rm --no-deps -v $PWD/services/research:/app -w /app research python -m pytest -q` | **19 passed** |
| Core (TS) | `pnpm --filter @signal-engine/core test` | **23 passed** |

---

## 8. Revalidation & strategy classifications

- **No compliant new revalidation runs executed.** Gates unmet (P1 5/6 blocked, P2/P3 incomplete, data sufficiency limited to BTCUSDT 1h).
- Original acceptance criteria (unchanged): ≥30 OOS trades and ≥100 total, positive costed OOS expectancy, OOS PF ≥1.15 and overall PF ≥1.0, max DD ≤20%, stability across train/validation/OOS, adequate coverage, implementation parity, reproducibility.

| Strategy | P1 parity | Data (primary scope) | Costed/repro revalidation | Classification |
|---|---|---|---|---|
| `ema-trend-pullback` | Fixture-parity OK, broader/regression verification pending | BTCUSDT 1h only primary-sufficient; others limited | Not run (gates/incomplete evidence) | **Insufficient evidence (blocked for promotion)** |
| `range-breakout-retest` | **BLOCKED** | BTCUSDT 1h limited as primary context only | Not run | **Failed validation / blocked (parity)** |
| `support-resistance-rejection` | **BLOCKED** | BTCUSDT 1h limited | Not run | **Failed validation / blocked (parity)** |
| `market-structure-continuation` | **BLOCKED** | BTCUSDT 1h limited | Not run | **Failed validation / blocked (parity)** |
| `trend-reversal-momentum` | **BLOCKED** | BTCUSDT 1h limited | Not run | **Failed validation / blocked (parity)** |
| `volatility-expansion-breakout` | **BLOCKED** | BTCUSDT 1h limited | Not run | **Failed validation / blocked (parity)** |

Historical baseline runs remain preserved (including failures and runs with empty/legacy assumptions) and must be treated as legacy/unverified where costs/assumptions are missing.

---

## 9. Remaining blockers

1. **P1:** Resolve material TS/Python divergences for 5 strategies against intended spec with explicit tolerances; expand deterministic fixtures/edge cases/regressions; produce passing parity per strategy.
2. **P2:** Complete path audit and automated tests for cost validation/immutability across retries; prove persisted versioned assumptions retrievable everywhere; formal legacy-unverified labeling policy for historical empty-cost records (non-destructive).
3. **P3:** Reproduce historical failure modes and prove idempotent, duplicate-safe, stale-safe, progress-tracked, bounded execution with secret-safe logs.
4. **P4/Data:** BTCUSDT 15m/XAU 1d gaps and forex intraday insufficiency/freshness constraints limit evidence (no extra Twelve Data credits used).
5. **Revalidation:** Cannot promote any strategy without gates satisfied; only BTCUSDT 1h eligible as primary evidence when gates pass.

---

## 10. Safety & compliance statement

- No trades executed, no trading accounts/wallets connected, no orders placed, no funds transferred.
- No production strategy enabled or approved; no production signals, no Telegram deliveries to main chats, no paper trades initiated for promotion.
- No paid API upgrades or additional live Twelve Data credit usage.
- No unrelated VPS/host changes, no force-push/merge, no destructive DB operations/migrations; historical data/backtest records preserved.
- Baseline report `docs/phase-4-validation-report.v1-baseline.md` unchanged.

**Phase 4 remediation/revalidation cycle stopped here pending review. Do not proceed to Phase 5 or production strategy activation without explicit approval.**
