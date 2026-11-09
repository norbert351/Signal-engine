# Research service

Python research package provides validated candle and cost models, completed-candle filtering, a chronological fill simulator, conservative stop-first resolution when stop and target are both touched in one bar, next-bar-open entries, transaction cost deductions, summary metrics, and chronological train/validation/out-of-sample splitting.

Install with `pip install -e '.[dev]'` from this directory, then run `python -m pytest`.

This simulator is a research foundation. Strategy signal generation, instrument-specific spread/funding histories, partial exits, and persisted report artifacts must be connected before treating its results as complete evidence.
