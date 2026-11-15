import glob
import json
import os
from decimal import Decimal

from signal_engine_research.backtest import Bar
from signal_engine_research.strategies import evaluate_at

fixtures_dir = os.environ.get("PARITY_FIXTURES", "tests/parity/fixtures")
out = {"version": 3, "strategies": {}}


def close_time(bar):
    return int(bar.close_timestamp if bar.close_timestamp is not None else bar.timestamp)


def parse_bar(item):
    timestamp = int(item["t"])
    close_timestamp = int(item.get("ct", timestamp + 1))
    return Bar(
        timestamp,
        Decimal(str(item["o"])),
        Decimal(str(item["h"])),
        Decimal(str(item["l"])),
        Decimal(str(item["c"])),
        close_timestamp,
        Decimal(str(item.get("v", 0))),
        item.get("complete", True),
    ), item.get("complete", True)


def validate_fixture(fixture, path):
    if fixture.get("category") not in {"positive", "negative", "edge"}:
        raise ValueError(f"{path}: invalid category")
    for key in ("entryBars", "trendBars"):
        bars = fixture[key]
        if not bars:
            raise ValueError(f"{path}: {key} must be non-empty")
        previous_close = None
        for index, item in enumerate(bars):
            bar, _ = parse_bar(item)
            if min(bar.open, bar.high, bar.low, bar.close) <= 0:
                raise ValueError(f"{path}: {key}[{index}] non-positive OHLC")
            if bar.high < max(bar.open, bar.close, bar.low) or bar.low > min(
                bar.open, bar.close, bar.high
            ):
                raise ValueError(f"{path}: {key}[{index}] invalid OHLC bounds")
            if close_time(bar) <= bar.timestamp:
                raise ValueError(f"{path}: {key}[{index}] invalid time range")
            if previous_close is not None and close_time(bar) <= previous_close:
                raise ValueError(f"{path}: {key}[{index}] duplicate/unsorted closeTime")
            if bar.volume < 0:
                raise ValueError(f"{path}: {key}[{index}] negative volume")
            previous_close = close_time(bar)


for path in sorted(glob.glob(os.path.join(fixtures_dir, "*.json"))):
    fixture = json.load(open(path))
    validate_fixture(fixture, path)
    key = fixture["strategyKey"]
    entry = [parse_bar(item) for item in fixture["entryBars"]]
    trend = [parse_bar(item) for item in fixture["trendBars"]]
    params = fixture.get("params") or {}
    timeframe = fixture.get("timeframe", "1h")
    results = []
    for index, _ in enumerate(entry):
        prefix = [bar for bar, complete in entry[: index + 1] if complete]
        if not prefix:
            continue
        last = prefix[-1]
        trend_prefix = [
            bar for bar, complete in trend
            if complete and (bar.close_timestamp if bar.close_timestamp is not None else bar.timestamp) <= (last.close_timestamp if last.close_timestamp is not None else last.timestamp)
        ]
        try:
            result = evaluate_at(key, prefix, trend_prefix, params, timeframe)
        except Exception as exc:  # noqa: BLE001 - surfaced in parity output
            results.append({"index": index, "error": str(exc)})
            continue
        if result is None:
            continue
        risk = result.entry - result.stop if result.direction == "LONG" else result.stop - result.entry
        results.append(
            {
                "index": index,
                "strategyKey": result.strategy_key,
                "strategyVersion": result.strategy_version,
                "triggerCloseTime": result.trigger_close_time,
                "timeframe": result.timeframe,
                "direction": result.direction,
                "entry": result.entry,
                "stop": result.stop,
                "targets": list(result.targets),
                "rr": (result.targets[0] - result.entry) / risk if result.direction == "LONG" else (result.entry - result.targets[0]) / risk,
                "score": result.score,
                "scoreFactors": result.score_factors,
                "rationale": list(result.rationale),
                "invalidation": list(result.invalidation),
                "evidence": result.evidence,
            }
        )
    out["strategies"].setdefault(key, []).append(
        {
            "fixture": fixture.get("name") or os.path.basename(path),
            "file": os.path.basename(path),
            "category": fixture["category"],
            "params": params,
            "evaluations": len(entry),
            "results": results,
        }
    )

print(json.dumps(out))
