# Signal Engine: Source-Grounded Research Mission

Use the six trading references listed in README.md to audit Signal Engine. This branch is research-only. The full PDFs are not committed here yet, so first check whether the VPS staging directory contains the six original PDFs or extracted text. If absent, do not claim to have read them. The user can provide the prepared archive through a direct phone-to-GitHub upload or another approved transfer route.

## Hard constraints
- Work only in isolated staging, on branch research/source-knowledge-pack.
- No production changes, merges to main, deployments, Telegram messages or strategy activation.
- Signal Engine is read-only. Never execute trades, place orders, connect wallets/accounts or request trading credentials.
- Deterministic quantitative logic remains authoritative. AI cannot invent prices or override risk checks.
- Keep all v1, event and v2 strategies disabled and unapproved. Keep tradingExecution=false and TONUSDT disabled/unavailable.
- No paid data/provider usage or secret changes without approval.
- Preserve existing user changes and inspect git status before editing.

## Work sequence
1. Verify repository root, branch, worktree, git status, and presence/checksums/page counts of all six source PDFs. Report missing inputs.
2. Read every source in full. Inspect chart illustrations, tables and image-only pages. Preserve the author's terminology and sequence. Record PDF page index separately from printed page label. Paraphrase rather than copying long passages. Mark unclear rules as AMBIGUOUS or UNSPECIFIED.
3. Produce six source-specific extractions. For each setup capture market/timeframe scope, context, formation, trigger, confirmation, entry reference, invalidation, stop, target/management, cancellation, no-trade conditions, examples and page citations.
4. Build source-to-code traceability with columns: source_id, source_title, pdf_page_index, printed_page, concept, source_definition, paraphrased_rule, current_module, code_location, test_reference, status, gap, proposed_change, evidence_status.
5. Record disagreements. Do not silently merge BMS, BOS, CHOCH and SMS, nor equate order blocks, supply/demand zones and FVGs. Keep reversal-stage methods, candlestick confirmations, VWAP/pivot/Stoch RSI methods and MTF confirmation as separate hypotheses.
6. Audit actual code and tests for causality, candle-close timing, lookahead, swing confirmation, MTF alignment, session/DST handling, duplicate/overlapping signals, instrument-specific data, stop/target ordering, spread, fees, slippage and gap-through-stop.
7. Write formal deterministic specifications before coding. Never translate vague terms such as strong, clean, institutional or high probability into arbitrary thresholds. Label engineering hypotheses separately from source rules.
8. Reproduce the current baseline on identical data, costs, symbols, timeframes, splits, commit and dataset fingerprint. Test each proposed change as an isolated ablation. Use chronological OOS, purging/embargo where required, realistic costs and per-symbol/per-regime reporting. Separate overlapping from non-overlapping results.
9. Report gross/net expectancy, PF, win rate, trade count, drawdown, exposure, turnover, MAE/MFE, expiry and stop rates, target distribution and uncertainty. Insufficient samples must be labelled INSUFFICIENT_SAMPLE. Never tune repeatedly on OOS or hide negative results.
10. Improve RAG so every claim cites source, page, section and epistemic type. Unsupported claims return NOT_FOUND_IN_SOURCE. Distinguish SOURCE_CLAIM, SOURCE_EXAMPLE, ENGINEERING_INTERPRETATION, EMPIRICAL_RESULT and UNVERIFIED_HYPOTHESIS.

## Source-specific focus
- Wade: expansion/retracement, 50% and OTE Fibonacci, BMS, range high/low, SMS/failure swing, BSL/SSL, stop hunts, order blocks, sessions, AMD, Turtle Soup, SH+BMS+RTO, SMS+BMS+RTO, HTF/LTF.
- Candlestick Trading Bible: candle anatomy, engulfing, doji variants, morning/evening star, hammer, shooting star, harami, tweezers, pin bar, inside bar, false breakout, trend/range context, top-down analysis, money management.
- EmperorBTC Manual: inspect full manual, especially Pivot Points + VWAP + Stoch RSI strategy material associated with user's separately supplied image. Verify exact parameters and trigger sequence before formalizing. Also inspect invalidation-based stop rules.
- Stop Loss Masterclass: structural invalidation, position sizing arithmetic, capital risk and examples. Treat leverage examples as educational, not recommendations.
- Rayner: reversal mistakes, four market stages, daily support + 1-hour accumulation, support/resistance, breakout, pullback and stop logic.
- SMC Forex thesis: FX mechanics/fundamentals, market cycle, BOS, imbalance, supply/demand and refinement, RBD/RBR/DBR/DBD, MTF, LTF confirmation, capital/risk management.

## Required reports
- docs/source-materials-input-audit.md
- docs/source-extractions/ (six files)
- docs/source-to-code-traceability.csv
- docs/source-conflict-register.md
- docs/source-implementation-gap-analysis.md
- docs/source-derived-rule-specifications.md
- docs/source-rule-ablation-results.md
- docs/source-rag-grounding-validation.md
- docs/source-materials-integration-report.md

## Stop conditions
Stop and report if the PDFs, relevant code, market data or reproducible tests are missing. Never fabricate page references or successful results. Do not activate strategies or models. Final report must confirm all strategies disabled/unapproved, tradingExecution=false, production untouched and zero production notifications.
