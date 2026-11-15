from decimal import Decimal
from signal_engine_research.backtest import Bar
from signal_engine_research.strategies import ema_series, trend_at, generate_setups

def rising(count: int, offset: int = 0) -> list[Bar]:
    result=[]
    for i in range(count):
        close=Decimal(100+i)+Decimal(offset)
        result.append(Bar(i*900000,close-Decimal("0.2"),close+Decimal("0.5"),close-Decimal("0.5"),close))
    return result

def test_ema_series_preserves_index_alignment():
    values=ema_series([Decimal(1),Decimal(2),Decimal(3)],2)
    assert values[0] is None
    assert values[1]==Decimal("1.5")
    assert values[2] is not None

def test_trend_filter_does_not_read_future_candles():
    bars=rising(80)
    assert trend_at(bars,10*900000,20,50) is None
    assert trend_at(bars,79*900000,20,50)=="long"

def test_unknown_strategy_is_rejected():
    try:
        generate_setups("unknown",rising(80),rising(80),{})
    except ValueError as error:
        assert "Unsupported strategy" in str(error)
    else:
        raise AssertionError("Expected unsupported strategy to fail")


def test_trend_filter_uses_only_completed_higher_timeframe_closes():
    bars=[]
    for i in range(60):
        close=Decimal(100+i)
        bars.append(Bar(i*900000,close-Decimal("0.2"),close+Decimal("0.5"),close-Decimal("0.5"),close,(i+1)*900000))
    assert trend_at(bars,49*900000,20,50) is None
    assert trend_at(bars,50*900000,20,50)=="long"


def test_all_six_strategies_are_registered_and_generate_without_lookahead_errors():
    from signal_engine_research.strategies import SUPPORTED_STRATEGIES
    bars = rising(220)
    trend = rising(220)
    assert len(SUPPORTED_STRATEGIES) == 6
    for key in SUPPORTED_STRATEGIES:
        setups = generate_setups(key, bars, trend, {})
        assert isinstance(setups, list)
        for setup in setups:
            assert setup.signal_time <= bars[-2].timestamp


def test_new_strategy_parameter_validation():
    bars = rising(120)
    try:
        generate_setups("range-breakout-retest", bars, bars, {"rangeLookback": 1})
    except ValueError:
        pass
    else:
        raise AssertionError("Expected invalid breakout parameters to fail")


def test_each_parity_fixture_is_no_lookahead_and_ignores_incomplete_bars():
    import json
    from dataclasses import replace
    from pathlib import Path

    from signal_engine_research.strategies import evaluate_at

    fixtures = Path(__file__).resolve().parents[3] / "tests" / "parity" / "fixtures"

    def parse(item):
        timestamp = int(item["t"])
        return Bar(
            timestamp,
            Decimal(str(item["o"])),
            Decimal(str(item["h"])),
            Decimal(str(item["l"])),
            Decimal(str(item["c"])),
            int(item.get("ct", timestamp + 1)),
            Decimal(str(item.get("v", 0))),
            item.get("complete", True),
        )

    tested = 0
    for path in sorted(fixtures.glob("*-long-valid.json")):
        fixture = json.loads(path.read_text())
        entry = [parse(item) for item in fixture["entryBars"]]
        trend = [parse(item) for item in fixture["trendBars"]]
        params = fixture.get("params") or {}
        signal = None
        for index in range(len(entry)):
            signal = evaluate_at(fixture["strategyKey"], entry[: index + 1], trend, params, "1h")
            if signal is not None:
                break
        assert signal is not None, fixture["name"]
        assert signal.trigger_close_time == entry[index].close_timestamp
        base = evaluate_at(fixture["strategyKey"], entry[: index + 1], trend, params, "1h")
        future_trend = trend + [
            replace(trend[-1], timestamp=trend[-1].timestamp + 10_000_000, close_timestamp=trend[-1].close_timestamp + 10_000_000)
        ]
        assert evaluate_at(fixture["strategyKey"], entry[: index + 1], future_trend, params, "1h") == base
        next_bar = replace(
            entry[-1],
            timestamp=entry[-1].timestamp + 3_600_000,
            close_timestamp=entry[-1].close_timestamp + 3_600_000,
        )
        setups = generate_setups(fixture["strategyKey"], entry + [next_bar], trend, params, timeframe="1h")
        assert setups, fixture["name"]
        assert all(setup.risk_fraction == Decimal("0.01") for setup in setups)
        assert all(setup.target2 is not None for setup in setups)
        incomplete = replace(
            entry[index],
            timestamp=entry[index].timestamp + 3_600_000,
            close_timestamp=entry[index].close_timestamp + 3_600_000,
            complete=False,
        )
        assert evaluate_at(fixture["strategyKey"], entry[: index + 1] + [incomplete], trend, params, "1h") == base
        tested += 1
    assert tested == 6
