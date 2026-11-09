from decimal import Decimal
from datetime import datetime, timezone
from signal_engine_research.engine import completed_candles, net_return
from signal_engine_research.models import Candle, CostModel

def candle(minute: int, complete: bool = True) -> Candle:
 t = datetime(2026, 1, 1, 0, minute, tzinfo=timezone.utc)
 return Candle(symbol="BTCUSDT", timeframe="5m", open_time=t, close_time=t, open=100, high=102, low=99, close=101, complete=complete)

def test_incomplete_candles_are_excluded():
 assert len(completed_candles([candle(0), candle(5, False)])) == 1

def test_cost_model_reduces_positive_return():
 assert net_return(Decimal("0.01"), CostModel(), Decimal("8")) < Decimal("0.01")
