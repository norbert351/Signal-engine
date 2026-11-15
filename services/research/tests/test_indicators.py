import math
from decimal import Decimal

from signal_engine_research.backtest import Bar
from signal_engine_research.strategies import (
    _atr_series,
    _bollinger,
    _ema_compact,
    _relative_volume,
    _rsi,
    _support_resistance,
)


def bar(index: int, open_: float, high: float, low: float, close: float, volume: float = 10) -> Bar:
    return Bar(
        index * 3_600_000,
        Decimal(str(open_)),
        Decimal(str(high)),
        Decimal(str(low)),
        Decimal(str(close)),
        (index + 1) * 3_600_000,
        Decimal(str(volume)),
    )


def test_ema_uses_sma_seed_and_recursive_alpha():
    assert _ema_compact([1, 2, 3, 4], 3) == [2, 3]
    assert _ema_compact([1, 2], 3) == []


def test_rsi_boundary_values():
    assert _rsi([100 + index for index in range(20)], 14) == 100
    assert _rsi([100 for _ in range(20)], 14) == 50
    assert _rsi([100 + index for index in range(14)], 14) is None


def test_atr_wilder_smoothing_matches_manual_values():
    candles = [bar(index, 100, 102, 98, 100) for index in range(20)]
    values = _atr_series(candles, 14)
    assert values[12] is None
    assert values[13] == 4
    assert values[14] == 4


def test_bollinger_uses_population_deviation_and_absolute_width():
    bands = _bollinger([1, 2, 3, 4, 5], 5, 2)
    deviation = math.sqrt(2)
    assert bands["middle"][-1] == 3
    assert abs(bands["upper"][-1] - (3 + 2 * deviation)) < 1e-12
    assert abs(bands["lower"][-1] - (3 - 2 * deviation)) < 1e-12
    assert abs((bands["upper"][-1] - bands["lower"][-1]) - 4 * deviation) < 1e-12


def test_relative_volume_excludes_the_current_bar():
    candles = [bar(index, 100, 101, 99, 100, volume) for index, volume in enumerate([10, 10, 10, 30])]
    assert _relative_volume(candles, 3) == 3
    assert _relative_volume(candles[:3], 3) is None


def test_support_resistance_clusters_confirmed_swings_and_ignores_unconfirmed_tail():
    closes = [100, 102, 104, 102, 100, 98, 100, 102, 104, 102, 100, 98, 100]
    candles = [bar(index, close, close + 1, close - 1, close) for index, close in enumerate(closes)]
    levels = _support_resistance(candles, 50, 0.02)
    supports = levels["supports"]
    resistances = levels["resistances"]
    assert supports and all(level["price"] < candles[-1].close for level in supports)
    assert resistances and all(level["price"] > candles[-1].close for level in resistances)
    assert all(level["touches"] >= 1 for level in supports + resistances)
