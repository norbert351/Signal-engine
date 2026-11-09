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
