# Parity harness (TS vs Python)

- `fixtures/*.json`: deterministic candle fixtures grouped as `positive`, `negative`, or `edge`.
- `run-ts.mjs`: validates fixtures, evaluates TypeScript `evaluateStrategy`, and emits signals plus shared `scoreOpportunity` scores.
- `run-py.py`: validates the same fixtures, evaluates Python `evaluate_at`, and emits matching signal/score fields.
- `compare.mjs`: compares fixture identity, evaluation counts, signal presence, required fields, and every material signal field. It writes `docs/parity-matrix.json`.

## Coverage rules

`PARITY_OK` requires:

- at least two positive fixtures and four positive signals per strategy;
- both `LONG` and `SHORT` positive signal coverage;
- zero signals from `negative` fixtures;
- no errors from `positive` fixtures;
- matching fixture sets, evaluation counts, categories, and signal presence;
- no missing required fields or material field differences.

The harness exits non-zero for invalid fixture OHLC, invalid timestamps, duplicate close times, invalid volume, or a blocked matrix. Negative fixtures cover no-setup, flat, low-volume, and one-confirmation-failure cases. Edge fixtures cover conflicting HTF, insufficient HTF, incomplete final candles, tight targets, invalid parameters, and zero volume.

## Run locally

```bash
pnpm --filter @signal-engine/core build
node tests/parity/run-ts.mjs > /tmp/parity-ts.json
docker run --rm \
  -v "$PWD/tests/parity:/workspace/tests/parity" \
  -v "$PWD/services/research:/workspace/services/research" \
  -e PYTHONPATH=/workspace/services/research \
  -w /workspace \
  signal-engine-research:latest \
  python /workspace/tests/parity/run-py.py > /tmp/parity-py.json
node tests/parity/compare.mjs /tmp/parity-ts.json /tmp/parity-py.json
```

Regenerate deterministic valid, variant, mirror, edge, and borderline fixtures after changing a base valid fixture:

```bash
node tests/parity/generate-fixtures.mjs
```

The generator imports `packages/core/dist`, so build core first. `PARITY_TOLERANCE` overrides the default absolute numeric tolerance (`1e-8`). `PARITY_FIXTURES` and `PARITY_MATRIX` override the fixture and matrix paths.

CI runs the harness in the `parity-checks` job.
