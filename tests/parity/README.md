# Parity harness (TS vs Python)

- `fixtures/*.json`: deterministic candle fixtures and expected comparison cases per strategy.
- `run-ts.mjs`: evaluates TS `evaluateStrategy` over fixture contexts using `packages/core/dist`.
- `run-py.py`: evaluates Python `generate_setups` over same fixtures inside research runtime.
- `compare.mjs`: normalizes outputs and produces per-strategy parity matrix with tolerances.

Run (reproducible): build core, then execute TS/Python runners and compare. Python runner executed via `docker compose run --rm --no-deps -v $PWD/services/research:/app -v $PWD/tests/parity:/parity -w /app research python /parity/run-py.py`.
