from decimal import Decimal

import pytest
from pydantic import ValidationError

from signal_engine_research.api import BacktestInput, CostsInput, SetupInput, run_backtest

STEP = 3_600_000


def bar_input(index: int, close: str = "100") -> dict:
    value = Decimal(close)
    return {
        "timestamp": index * STEP,
        "close_timestamp": (index + 1) * STEP,
        "open": str(value),
        "high": str(value + 1),
        "low": str(value - 1),
        "close": str(value),
        "volume": "10",
    }


def costs(**overrides: str) -> dict:
    return {
        "fee_bps_per_side": "5",
        "spread_bps": "2",
        "slippage_bps": "2",
        "funding_bps_per_8h": "0",
        **overrides,
    }


def payload(setups=None, cost_values=None, count=80):
    return {
        "strategy_key": "ema-trend-pullback",
        "strategy_params": {},
        "symbol": "BTCUSDT",
        "timeframe": "1h",
        "bars": [bar_input(index, str(100 + index * 0.1)) for index in range(count)],
        "trend_bars": [bar_input(index, str(100 + index * 0.1)) for index in range(count)],
        "setups": setups,
        "costs": cost_values or costs(),
    }


def test_missing_costs_are_rejected():
    value = payload()
    del value["costs"]
    with pytest.raises(ValidationError):
        BacktestInput(**value)


@pytest.mark.parametrize("field", ["fee_bps_per_side", "spread_bps", "slippage_bps", "funding_bps_per_8h"])
def test_each_missing_cost_field_is_rejected(field):
    values = costs()
    del values[field]
    with pytest.raises(ValidationError):
        BacktestInput(**payload(cost_values=values))


@pytest.mark.parametrize("override", [{"fee_bps_per_side": "-1"}, {"spread_bps": "not-a-number"}])
def test_invalid_costs_are_rejected(override):
    with pytest.raises(ValidationError):
        BacktestInput(**payload(cost_values=costs(**override)))


def test_zero_costs_are_explicit_and_accepted():
    value = BacktestInput(**payload(cost_values=costs(fee_bps_per_side="0", spread_bps="0", slippage_bps="0")))
    assert value.costs.fee_bps_per_side == 0


def test_gross_and_net_metrics_cover_the_same_trades_in_overall_and_walk_forward():
    setups = [{"signal_time": 20 * STEP, "direction": "long", "stop": "95", "target": "120"}]
    result = run_backtest(BacktestInput(**payload(setups=setups)))
    metrics = result["metrics"]
    assert metrics["costModelVersion"] == "costs-v1"
    assert result["assumptions"]["version"] == "costs-v1"
    assert result["assumptions"]["explicit"] is True
    assert metrics["overallGross"]["trades"] == metrics["overallNet"]["trades"] == metrics["overall"]["trades"]
    assert Decimal(metrics["overallGross"]["net_return"]) > Decimal(metrics["overallNet"]["net_return"])
    for group, buckets in metrics["breakdowns"].items():
        assert set(metrics["breakdownsGross"][group]) == set(buckets)
        for key, bucket in buckets.items():
            assert metrics["breakdownsGross"][group][key]["trades"] == bucket["trades"]
    assert len(result["walkForward"]) == len(result["walkForwardGross"]) == 4
    for gross, net in zip(result["walkForwardGross"], result["walkForward"]):
        assert gross["trades"] == net["trades"]
        assert Decimal(gross["net_return"]) >= Decimal(net["net_return"])


def test_setup_model_rejects_incorrect_target_side():
    with pytest.raises(ValidationError):
        SetupInput(signal_time=STEP, direction="long", stop="100", target="99")
