# Phase 4 — Signal Engine Validation, Backtesting, Optimization & Strategy Readiness

**Project:** Signal Engine (`build/full-market-scanner`)
**Date:** 2026-11-15 (remediation + revalidation cycle)
**Mode:** Read-only validation plus remediation changes on the feature branch; **no live trading, no broker/wallet connections, no order execution, no funds moved, no paid API credits used, no main Telegram delivery enabled, no production strategy activation/approval**.

**Baseline preserved:** `docs/phase-4-validation-report.v1-baseline.md` (unchanged). This document supersedes it as the current working report and records P1–P5 remediation/revalidation evidence.

---

## 1. Executive summary

| Area | Status | Notes |
|---|---|---|
| **P1 — TS/Python strategy parity** | **PASS (fixture parity)** | 96 validated fixtures across all six strategies; **6/6 `PARITY_OK`**, 0 material differences, 150 positive signals, 0 negative signals. Parity is implementation agreement only, not proof of profitability or independent correctness. |
| **P2 — Backtest realism / cost integrity** | **PASS (scoped)** | Explicit, versioned `costs-v1` assumptions are required end-to-end; zero costs are allowed explicitly; malformed/negative/missing/changed costs are rejected; retries reuse identical payloads; persisted assumptions are verifiable. |
| **P3 — Backtest pipeline reliability** | **PASS (scoped)** | Claim-token finishing, stale-running reclaim, bounded transient retry, durable progress stages, and failure classification are implemented and tested. Progress still does not extend the 15-minute lease; no resource-limit benchmark was added. |
| **P4 — Data sufficiency** | **ACCEPTED (evidence-limited)** | BTCUSDT 1h evidence was refreshed to 13,515 contiguous hourly bars through `2026-11-15T02:59:59.999Z`. Only BTCUSDT 1h qualifies as primary sufficient evidence; the other 149 P4 series remain the prior snapshot. |
| **P5 — Test workflows / environment** | **PASS** | DB integration 10 passed; research 36 passed; root suite 104 passed / 4 skipped (DB integration separately 10 passed); parity 6/6; forced typecheck/build passed; `docker compose config` passed. |
| **Strategy production readiness** | **NO-GO for all six** | Revalidation runs completed on BTCUSDT 1h with explicit costs, but all six failed promotion criteria on performance/trade-count/coverage grounds. All strategies remain `enabled=false, approved=false`. |

**Revalidation gate:** The six-strategy BTCUSDT 1h revalidation was executed and completed. **No strategy satisfies the promotion gate.** Revalidation used the internally stored BTCUSDT 1h dataset, not independent external market data. See section 8.

---

## 2. Environment & runtime observed

- VPS: Ubuntu 6.8.0 x86_64, 4 vCPU, ~7.8 GiB RAM, 4.0 GiB swap, 96G disk. Host load/memory pressure was noted in the earlier baseline cycle.
- Docker 29.8.1 / Compose v5.5.1; Node v22.23.2; pnpm 10.20.0; Python 3.12.3.
- Branch `build/full-market-scanner`; changes remain uncommitted at report time.
- API health at report time: `ok`, database `ok` (8 ms latency), `tradingExecution:false`.
- Research container healthy; worker-backtests running; `docker compose config --quiet` passed.
- Runtime posture: all six strategy configs `enabled=false, approved=false`; no main Telegram chat IDs configured; no paid Twelve Data credits used in this cycle.

---

## 3. P1 — TypeScript/Python parity (PASS on fixtures)

### Artifacts
- Rules spec: `docs/strategy-specs/strategy-rules.md`
- Deterministic harness: `tests/parity/run-ts.mjs`, `tests/parity/run-py.py`, `tests/parity/compare.mjs`
- Fixtures: `tests/parity/fixtures/*.json` (96 fixtures)
- Matrix: `docs/parity-matrix.json`
- CI: `.github/workflows/ci.yml` includes `parity-checks` (core build, research install, TS/Python runners, comparator).

### Method
- Identical deterministic OHLCV bars and trend context are fed to TS `evaluateStrategy`/`scoreOpportunity` (`packages/core/dist`) and Python `evaluate_at` (research runtime in Docker).
- Comparisons cover fixture identity/category, evaluation count, signal presence/index, strategy key/version, trigger close time, timeframe, direction, entry, stop, targets, RR, score, score factors, rationale, invalidation, and evidence.
- Numeric tolerance: `1e-8`. Required score-factor keys are checked explicitly. Negative and edge fixtures must emit no signals.
- `generate_setups` is now also covered by the parity-fixture regression test, because the parity comparator exercises `evaluate_at`, not the setup-generation path.

### Results

| Strategy | Fixtures | Positive fixtures | Positive signals | Comparisons | Material diffs | Status |
|---|---:|---:|---:|---:|---:|---|
| `ema-trend-pullback` | 17 | 8 | 8 | 2,361 | 0 | **PARITY_OK** |
| `range-breakout-retest` | 16 | 8 | 8 | 1,011 | 0 | **PARITY_OK** |
| `support-resistance-rejection` | 16 | 8 | 8 | 1,316 | 0 | **PARITY_OK** |
| `market-structure-continuation` | 14 | 8 | 110 | 966 | 0 | **PARITY_OK** |
| `trend-reversal-momentum` | 16 | 8 | 8 | 1,111 | 0 | **PARITY_OK** |
| `volatility-expansion-breakout` | 17 | 8 | 8 | 1,378 | 0 | **PARITY_OK** |
| **Total** | **96** | **48** | **150** | **8,143** | **0** | **PARITY_OK** |

- Negative fixtures: 17; all emitted 0 signals. Edge fixtures: 31.
- `market-structure-continuation` has 110 positive signals because its fixture emits multiple continuation events; the other strategies have 8 each.

### Runtime bug found and fixed during revalidation
- First revalidation batch failed with research HTTP 500 because `generate_setups` constructed `Setup(...)` without the required `risk_fraction`. Fixed in `services/research/signal_engine_research/strategies.py` with `risk_fraction=Decimal("0.01")`, matching the API/setup contract.
- Added a regression in `services/research/tests/test_strategies.py`: for each `*-long-valid.json` fixture, append a next bar, call `generate_setups`, and assert non-empty setups, `risk_fraction == Decimal("0.01")`, and `target2 is not None`.
- Parity fixtures did not catch this because the comparator uses `evaluate_at`, not `generate_setups`.

### Performance correction
- The parity rewrite made `generate_setups` evaluate every historical prefix (`O(n²)`), causing revalidation timeouts.
- `generate_setups` now uses a bounded 1,000-bar warmup window and `bisect_right` for the trend window. Output equivalence was checked on the last 2,000 and 4,000 BTCUSDT bars: 418 and 817 setups, respectively, with **zero missing/extra/value differences** versus full-prefix evaluation.
- This is a bounded-warmup implementation, validated on the available BTCUSDT window; it is not a formal proof that every arbitrary parameter set is insensitive to longer warmup.

**Conclusion:** Fixture-level parity is established for all six strategies. Production readiness is still **NO-GO** for strategy-performance and data-coverage reasons, not parity.

---

## 4. P2 — Cost integrity (PASS, scoped)

### Implemented safeguards
- Research models/API require explicit `fee_bps_per_side`, `spread_bps`, `slippage_bps`, and `funding_bps_per_8h`; responses echo `costs-v1`, `explicit=true`, and effective assumptions.
- API rejects missing/non-finite/negative costs. Numeric strings are normalized; booleans and malformed values are rejected. Explicit zero is allowed.
- Worker validates costs before execution, sends the same payload on retry, rejects research-service cost changes, and persists effective assumptions on success.
- Failures with missing/empty legacy assumptions are labeled `legacyCostDataUnverified`; no costs are invented. Historical runs are preserved without destructive migration.
- Database tests prove claim-token-scoped finishing and stale-worker rejection, including that a stale worker cannot finish a reclaimed run.

### Verification
- API tests: **12 passed** (including missing/invalid/zero/negative/malformed/changed cost cases).
- Worker tests: **27 passed** (including identical retry payload, bounded retry, progress without cost mutation, classification).
- DB integration: **10 passed** (claim/stale/finish invariants).
- Revalidation evidence: all six completed runs report `costModelVersion: costs-v1` and `assumptions.explicit: true` with the exact submitted costs (`5/2/2/0` bps).

### Remaining limits
- This is code-level and regression-test evidence, not an external financial audit.
- Legacy historical runs are preserved and labeled only through the implemented new-run/failure paths; no mass historical relabel migration was performed.
- No claim is made that every possible caller outside the API/worker/admin paths has been enumerated.

---

## 5. P3 — Pipeline reliability (PASS, scoped)

### Implemented safeguards
- Backtests are claimed atomically; workers finish only with their active claim token.
- Stale running jobs are reclaimed after 15 minutes, with cleared start/completion markers; stale workers cannot overwrite newer results.
- `finishBacktest` returns whether the finish succeeded; stale finishes are counted as `stale`, not success.
- Progress stages include `running`, `reclaimed`, `retry`, `completed`, and `failed`.
- Failure classes distinguish timeout, transient infrastructure, research service, validation, data, strategy, database, resource, and generic invalid request/data. Transient failures get at most two attempts with 1-second backoff.
- Revalidation exercised the repair path: a missing-argument bug, request timeouts, retries, reclaim, and sequential reprocessing were all observed; after correction, all six jobs completed.

### Verification
- DB integration **10 passed**, including queued-claim uniqueness and stale reclaim.
- Worker **27 passed**, including retry attempts, retry progress, cost immutability, and non-retry of invalid requests.
- Revalidation completed six jobs after the performance fix; no completed run was later replaced by a stale worker.

### Remaining limits
- Progress updates do not extend the 15-minute lease.
- No explicit memory/CPU resource-limit benchmark or long-duration stress test was added.
- Failure-mode tests are deterministic mocks/integration tests, not a full production fault-injection campaign.
- Structured logs are secret-safe by inspection/test, but no formal logging audit was performed.

---

## 6. P4 — Data sufficiency (ACCEPTED, limited)

- Artifacts: `docs/p4-data-sufficiency.json` (150 series), `docs/p4-data-sufficiency-matrix.md`.
- **BTCUSDT 1h refreshed 2026-11-15** from the database: **13,515 bars**, **13,515 complete**, **0 missing hourly bars**, first open `2025-05-01T00:00:00Z`, last close `2026-11-15T02:59:59.999Z`, span **563.125 days**, age **0.595h** at observation (`2026-11-15T03:35:43Z`). Old artifact: 13,447 bars / 560.2917 days / last close `2026-11-12T06:59:59.999Z`.
- Matrix header and BTCUSDT row were updated; JSON `validation_sufficiency` is `yes (primary evidence only)` with reason `deep contiguous history (~563d, refreshed 2026-11-15)`.
- **Only BTCUSDT 1h is refreshed.** The other 149 series remain the prior 2026-11-12 snapshot. No broad multi-instrument/forex validation is claimed.
- Known remaining data issues: `binance_usdm:BTCUSDT 15m` 1 gap; `twelve_data:XAU_USD 1d` 54 gaps; most non-BTC intraday series shallow; Twelve Data 1m/5m/15m budget-limited/stale.
- Revalidation used stored BTCUSDT 1h candles. It did not consume paid Twelve Data credits and is not independent-vendor evidence.

---

## 7. P5 — Test workflows / environment (PASS)

| Workflow | Command / evidence | Result |
|---|---|---|
| DB integration | `bash scripts/test-db-integration.sh` (isolated temp DB, cleanup, prod-URL guard) | **10 passed** |
| Research (Python) | Docker research image, full repo mount, `python -m pytest -q` | **36 passed in 2.13s** |
| Core (TS) | Root `pnpm test --force` | **23 passed** |
| Market data (TS) | Root `pnpm test --force` | **42 passed, 4 skipped** |
| API (TS) | Root `pnpm test --force` | **12 passed** |
| Worker (TS) | Root `pnpm test --force` | **27 passed** |
| Root summary | `pnpm test --force` (no cache) | **104 passed, 4 skipped; 10 DB tests skipped in root and run separately** |
| Parity | TS runner + Python runner + comparator | **6/6 `PARITY_OK`, 96 fixtures, 0 material diffs** |
| Typecheck | `pnpm typecheck --force` | **8 tasks successful** |
| Build | `pnpm build --force` | **5 tasks successful** |
| Compose config | `docker compose config --quiet` | **PASS** |

### Tooling note
- Optional Python `ruff`/`mypy` dev commands are not clean on the existing codebase (pre-existing style findings and relative-import resolution errors). They are not used as the authoritative gate; research `pytest`, TS typecheck/build, and the parity comparator are.
- The CI parity job is configured but was not executed on a remote CI runner in this cycle; the same commands were run locally.

---

## 8. Revalidation & strategy classifications

### Revalidation setup
- Instrument: `BTCUSDT` crypto perpetual, instrument ID `2466ead0-57e5-40b2-8a0a-a277fc8e55c3`.
- Timeframe: `1h`; trend context: `4h`.
- Costs: `fee_bps_per_side=5`, `spread_bps=2`, `slippage_bps=2`, `funding_bps_per_8h=0` (explicit, `costs-v1`).
- Parameters: version-1 strategy snapshots.
- Windows:
  - `ema-trend-pullback`, `range-breakout-retest`, `volatility-expansion-breakout`: `2025-07-01T00:00:00.000Z` → `2026-10-15T00:00:00.000Z`.
  - `support-resistance-rejection`, `market-structure-continuation`, `trend-reversal-momentum`: `2025-09-01T00:00:00.000Z` → `2026-11-01T00:00:00.000Z`.
- Data source: internally stored BTCUSDT 1h candles (not independent external data).

### Completed run evidence

| Strategy | Run ID | Total trades | OOS trades | Win rate | Net return | Profit factor | Max DD | OOS net return |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `ema-trend-pullback` | `dca69392-2e65-496f-849e-84430045b5dd` | 499 | 98 | 38.28% | -56.09% | 0.737 | 58.57% | -23.78% |
| `market-structure-continuation` | `9fe06737-2030-4730-a951-683246c9c5e8` | 354 | 76 | 39.83% | -30.61% | 0.843 | 31.47% | -7.84% |
| `range-breakout-retest` | `a394f7ea-c05e-4a70-bb5a-e285b2e924a4` | 117 | 21 | 30.77% | -17.59% | 0.685 | 17.90% | -4.37% |
| `support-resistance-rejection` | `e6ce1ea3-0436-4e37-8138-569d69b66afc` | 382 | 65 | 33.25% | -55.46% | 0.599 | 55.68% | -8.55% |
| `trend-reversal-momentum` | `2acd7250-7da4-4ecc-be71-fd5478a09d16` | 260 | 58 | 38.08% | -38.43% | 0.704 | 38.99% | -10.43% |
| `volatility-expansion-breakout` | `3977bad5-4699-4f15-80ba-03502a4b7d90` | 19 | 3 | 42.11% | -3.95% | 0.681 | 9.98% | +4.33% |

All runs are `costs-v1` with explicit assumptions. Evaluation bars were 11,304 for the three July-window runs and 10,224 for the three September-window runs; OOS bars were 2,262 and 2,046, respectively.

### Gate assessment
Original acceptance criteria (unchanged): ≥30 OOS trades and ≥100 total, positive costed OOS expectancy, OOS profit factor ≥1.15, overall profit factor ≥1.0, max drawdown ≤20%, stability across train/validation/OOS, adequate coverage, implementation parity, and reproducibility.

| Strategy | Classification | Reason |
|---|---|---|
| `ema-trend-pullback` | **Failed validation / NO-GO** | Overall net -56.09%, PF 0.737, DD 58.57%; OOS net -23.78%. |
| `market-structure-continuation` | **Failed validation / NO-GO** | Overall net -30.61%, PF 0.843, DD 31.47%; OOS net -7.84%. |
| `range-breakout-retest` | **Failed validation / NO-GO** | Overall net -17.59%, PF 0.685; OOS net -4.37%. |
| `support-resistance-rejection` | **Failed validation / NO-GO** | Overall net -55.46%, PF 0.599, DD 55.68%; OOS net -8.55%. |
| `trend-reversal-momentum` | **Failed validation / NO-GO** | Overall net -38.43%, PF 0.704, DD 38.99%; OOS net -10.43%. |
| `volatility-expansion-breakout` | **Failed validation / NO-GO** | Only 19 total / 3 OOS trades (below 100/30 or 30/10 thresholds); overall net -3.95%, PF 0.681. Positive OOS is not credible with 3 trades. |

**No strategy is eligible for promotion.** All remain disabled and unapproved.

### Preserved failure history
- The first revalidation batch failed with research HTTP 500 due to the missing `risk_fraction` argument; those failed rows remain preserved.
- The second batch exposed timeouts/retries for the July-window jobs before the performance correction; failed rows remain preserved.
- Successful replacement runs are the six runs listed above. Historical baseline runs and failed/legacy records were not deleted.

---

## 9. Remaining blockers and limits

1. **Strategy performance:** Every strategy is net-negative overall; most also breach the 20% drawdown limit. `volatility-expansion-breakout` lacks sufficient trade count. No promotion evidence exists.
2. **Data coverage:** Only BTCUSDT 1h is primary-sufficient. No broad multi-instrument/forex claim; BTCUSDT 15m and XAU_USD 1d gaps remain; forex intraday history is shallow.
3. **Independence/reproducibility:** Revalidation used one stored BTCUSDT dataset and one run per strategy. Independent-vendor data and repeat-run reproducibility are not established.
4. **Warmup approximation:** `generate_setups` uses a bounded 1,000-bar warmup; output equivalence was checked on 2,000/4,000 BTCUSDT bars, but not formally proven for every parameter set.
5. **P2/P3 scope:** Cost and pipeline fixes are verified with unit/integration tests and revalidation, not an external audit or prolonged production fault-injection campaign.
6. **Optional tooling:** Ruff/mypy are not clean on the existing Python codebase and were not used as passing gates.

---

## 10. Safety & compliance statement

- No trades executed, no trading accounts/wallets connected, no orders placed, no funds transferred.
- No production strategy enabled or approved; no production signals, no main Telegram deliveries, no paper trades initiated for promotion.
- No paid API upgrades or additional live Twelve Data credit usage; revalidation read stored candles from the local database.
- No unrelated VPS/host changes, no force-push/merge, no destructive DB operations/migrations; historical candles, signals, strategies, and backtest records were preserved.
- Baseline report `docs/phase-4-validation-report.v1-baseline.md` is unchanged.

**Phase 4 remediation/revalidation is complete for the current evidence scope. Strategy promotion remains NO-GO. Do not proceed to Phase 5 or production strategy activation without explicit approval.**
